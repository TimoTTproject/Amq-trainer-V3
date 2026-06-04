// Multijoueur temps réel : file de matchmaking + manches synchronisées (Socket.io).
// Sans tokens (fun only) : score à la vitesse, classement de fin de partie.
const { prisma } = require('../db');
const { verifyToken, COOKIE_NAME } = require('../auth/jwt');
const { isCorrectGuess } = require('../quiz/matching');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 20000; // attente avant lancement une fois MIN atteint
const TOTAL_ROUNDS = 10;
const PREP_MS = 1500; // délai avant le début d'une manche (sync chargement)
const ROUND_MS = 25000; // fenêtre de réponse
const RESULT_MS = 6000; // affichage des résultats entre 2 manches

const games = new Map(); // gameId -> game
let queue = new Map(); // socketId -> socket
let countdownTimer = null;
let countdownEndsAt = 0;
let io = null;

function parseCookies(str) {
  const out = {};
  (str || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// ── Matchmaking ──
function queuePlayers() {
  return [...queue.values()].map((s) => ({ name: s.data.user.displayName, avatarUrl: s.data.user.avatarUrl }));
}
function broadcastQueue() {
  const payload = { count: queue.size, min: MIN_PLAYERS, players: queuePlayers(), countdownEndsAt: countdownEndsAt || null };
  for (const s of queue.values()) s.emit('mp:queue:update', payload);
}
function cancelCountdown() {
  if (countdownTimer) clearTimeout(countdownTimer);
  countdownTimer = null;
  countdownEndsAt = 0;
}
function maybeCountdown() {
  if (queue.size >= MIN_PLAYERS && !countdownTimer) {
    countdownEndsAt = Date.now() + COUNTDOWN_MS;
    countdownTimer = setTimeout(startGameFromQueue, COUNTDOWN_MS);
  } else if (queue.size < MIN_PLAYERS && countdownTimer) {
    cancelCountdown();
  }
}
function joinQueue(socket) {
  if (socket.data.gameId) return; // déjà en partie
  queue.set(socket.id, socket);
  maybeCountdown();
  broadcastQueue();
}
function leaveQueue(socket) {
  if (queue.delete(socket.id)) {
    maybeCountdown();
    broadcastQueue();
  }
}

function startGameFromQueue() {
  cancelCountdown();
  const sockets = [...queue.values()].slice(0, MAX_PLAYERS);
  if (sockets.length < MIN_PLAYERS) { broadcastQueue(); return; }
  for (const s of sockets) queue.delete(s.id);
  broadcastQueue(); // met à jour ceux qui restent en file

  const gameId = 'g_' + Math.random().toString(36).slice(2, 9);
  const players = new Map();
  const userIds = new Set();
  for (const s of sockets) {
    s.data.gameId = gameId;
    s.join(gameId);
    players.set(s.id, {
      socketId: s.id, userId: s.data.user.id,
      name: s.data.user.displayName, avatarUrl: s.data.user.avatarUrl, score: 0,
    });
    userIds.add(s.data.user.id);
  }
  const game = { id: gameId, players, userIds, round: 0, totalRounds: TOTAL_ROUNDS, current: null, usedSongIds: new Set(), status: 'playing', timer: null };
  games.set(gameId, game);

  io.to(gameId).emit('mp:game:start', {
    gameId, totalRounds: TOTAL_ROUNDS,
    players: [...players.values()].map((p) => ({ name: p.name, avatarUrl: p.avatarUrl })),
  });
  setTimeout(() => startRound(game), 2500);
}

// ── Boucle de jeu ──
async function pickSong(game) {
  const where = { videoUrl: { not: null } };
  const total = await prisma.song.count({ where });
  if (!total) return null;
  for (let tries = 0; tries < 8; tries++) {
    const song = await prisma.song.findFirst({
      where, skip: Math.floor(Math.random() * total),
      select: { id: true, animeTitle: true, altTitles: true, title: true, artist: true, type: true, number: true, videoUrl: true },
    });
    if (song && !game.usedSongIds.has(song.id)) { game.usedSongIds.add(song.id); return song; }
  }
  return null;
}

async function startRound(game) {
  if (game.status !== 'playing' || !games.has(game.id)) return;
  game.round++;
  const song = await pickSong(game);
  if (!song) return endGame(game);

  const startAt = Date.now() + PREP_MS;
  const endsAt = startAt + ROUND_MS;
  game.current = { song, startAt, endsAt, answers: new Map() };

  io.to(game.id).emit('mp:round:start', {
    round: game.round, total: game.totalRounds,
    clipUrl: `/api/mp/clip/${game.id}?r=${game.round}`,
    startAt, duration: ROUND_MS,
  });
  game.timer = setTimeout(() => endRound(game), PREP_MS + ROUND_MS);
}

function onGuess(socket, text) {
  const game = games.get(socket.data.gameId);
  if (!game || !game.current) return;
  const player = game.players.get(socket.id);
  if (!player) return;
  const cur = game.current;
  if (cur.answers.get(socket.id)?.correct) return; // déjà trouvé
  if (Date.now() > cur.endsAt) return;

  const correct = isCorrectGuess(text, cur.song);
  socket.emit('mp:guess:ack', { correct });
  if (!correct) return;

  const timeMs = Math.max(0, Date.now() - cur.startAt);
  const timeLeft = Math.max(0, cur.endsAt - Date.now());
  const points = 300 + Math.round((timeLeft / ROUND_MS) * 700);
  cur.answers.set(socket.id, { correct: true, timeMs, points });
  player.score += points;

  io.to(game.id).emit('mp:round:progress', {
    answered: [...cur.answers.values()].filter((a) => a.correct).length,
    total: game.players.size,
  });
  // Tout le monde a trouvé → on clôt la manche en avance
  if ([...game.players.keys()].every((sid) => cur.answers.get(sid)?.correct)) {
    clearTimeout(game.timer);
    endRound(game);
  }
}

function endRound(game) {
  if (!game.current || !games.has(game.id)) return;
  const cur = game.current;
  game.current = null;
  const s = cur.song;
  const results = [...game.players.values()]
    .map((p) => {
      const a = cur.answers.get(p.socketId);
      return { name: p.name, avatarUrl: p.avatarUrl, correct: !!a?.correct, points: a?.points || 0, score: p.score };
    })
    .sort((a, b) => b.score - a.score);

  io.to(game.id).emit('mp:round:result', {
    round: game.round, total: game.totalRounds,
    answer: { animeTitle: s.animeTitle, title: s.title, artist: s.artist, type: s.type, number: s.number },
    results,
  });

  game.timer = setTimeout(() => {
    if (game.round >= game.totalRounds) endGame(game);
    else startRound(game);
  }, RESULT_MS);
}

function endGame(game) {
  game.status = 'over';
  clearTimeout(game.timer);
  const ranking = [...game.players.values()]
    .map((p) => ({ name: p.name, avatarUrl: p.avatarUrl, score: p.score }))
    .sort((a, b) => b.score - a.score);
  io.to(game.id).emit('mp:game:over', { ranking });

  for (const p of game.players.values()) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) { s.leave(game.id); s.data.gameId = null; }
  }
  setTimeout(() => games.delete(game.id), 60000);
}

function onDisconnect(socket) {
  leaveQueue(socket);
  const game = games.get(socket.data.gameId);
  if (!game) return;
  const player = game.players.get(socket.id);
  game.players.delete(socket.id);
  if (player) game.userIds.delete(player.userId);
  if (game.players.size === 0) {
    clearTimeout(game.timer);
    games.delete(game.id);
  } else {
    io.to(game.id).emit('mp:player:left', { name: player?.name });
    // si la manche en cours et tous les restants ont répondu → clore
    if (game.current && [...game.players.keys()].every((sid) => game.current.answers.get(sid)?.correct)) {
      clearTimeout(game.timer);
      endRound(game);
    }
  }
}

// Vidéo de la manche en cours (pour le proxy), si l'utilisateur est dans la partie
function getCurrentVideo(gameId, userId) {
  const game = games.get(gameId);
  if (!game || !game.current || !game.userIds.has(userId)) return null;
  return game.current.song.videoUrl;
}

function initMp(server) {
  const { Server } = require('socket.io');
  io = new Server(server, { path: '/socket.io' });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const payload = verifyToken(cookies[COOKIE_NAME]);
      if (!payload?.sub) return next(new Error('auth'));
      const user = await prisma.user.findUnique({
        where: { id: payload.sub }, select: { id: true, displayName: true, avatarUrl: true },
      });
      if (!user) return next(new Error('auth'));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('auth'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('mp:queue:join', () => joinQueue(socket));
    socket.on('mp:queue:leave', () => leaveQueue(socket));
    socket.on('mp:guess', (text) => onGuess(socket, String(text || '').slice(0, 120)));
    socket.on('disconnect', () => onDisconnect(socket));
  });

  return io;
}

module.exports = { initMp, getCurrentVideo };
