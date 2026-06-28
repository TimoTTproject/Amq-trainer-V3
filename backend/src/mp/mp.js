// Multijoueur temps réel : salles (rapide / classé / privées), lobby+chat,
// manches synchronisées, reconnexion (clé par compte) et classé persistant (MMR).
const { prisma } = require('../db');
const { verifyToken, COOKIE_NAME } = require('../auth/jwt');
const { isCorrectGuess } = require('../quiz/matching');
const { englishTitleFor } = require('../quiz/anime-titles');
const { computeMmrDeltas } = require('./rank');
const { progressQuests } = require('../quests/quests');
const { byId, publicCosmetic } = require('../shop/cosmetics');
const { preferredMediaUrl } = require('../storage/r2');
const { preferMainContent } = require('../catalog/format');

const MAX_PLAYERS = 8;
const PUBLIC_MIN = 2;
const COUNTDOWN_MS = 20000;
const FIRST_ROUND_PREP_MS = 3000;
const PRELOADED_ROUND_PREP_MS = 750;
const RESULT_MS = 4000;
const DC_GRACE_LOBBY = 25000; // délai avant retrait après déconnexion (lobby)
const DC_GRACE_GAME = 120000; // ... en partie (reconnexion possible)
const VALID_ROUNDS = [5, 10, 15, 20];
const VALID_ROUNDMS = [15000, 25000, 40000];
const VALID_MODES = ['classic', 'teams', 'elim'];
const VALID_THEME_TYPES = ['all', 'OP', 'ED'];
const ELIM_LIVES = 3;
const ELIM_MAX_ROUNDS = 25; // garde-fou en élimination
const TEAM_NAMES = ['Rouge', 'Bleu'];
const EMOTES = ['😂', '🔥', '👍', '😮', '😭', '🎉', '👏', '💀'];
const RANKED_SETTINGS = { rounds: 10, roundMs: 25000, mode: 'classic', themeType: 'all' };

// Récompense en tokens (perf + plafond quotidien anti-abus). Le farm entre amis
// est toléré (jeu pour s'amuser) ; le plafond/jour borne les dérives (bots/nuit).
const MP_TOKENS_PER_CORRECT = 2; // par bonne réponse sur la partie
const MP_PLACEMENT_BONUS = [20, 10, 5]; // 1er / 2e / 3e
const MP_GAME_CAP = 40; // max de tokens gagnés en une partie
const MP_DAILY_CAP = 200; // max de tokens multi par jour
const MP_MIN_PLAYERS_REWARD = 2; // au moins 2 comptes distincts pour récompenser

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const rooms = new Map(); // roomId -> room
const userRoom = new Map(); // userId -> roomId (pour la reconnexion)
const online = new Map(); // userId -> Set<socketId> (présence)
let publicRoomId = null;
let rankedRoomId = null;
let io = null;

function addOnline(socket) {
  const uid = socket.data.user.id;
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(socket.id);
}
function removeOnline(socket) {
  const uid = socket.data.user.id;
  const set = online.get(uid);
  if (set) { set.delete(socket.id); if (!set.size) online.delete(uid); }
}
function isOnline(userId) {
  return online.has(userId);
}
// Émet un événement à tous les sockets connectés d'un utilisateur (notifs hors-jeu).
function notifyUser(userId, event, payload) {
  const set = online.get(userId);
  if (!io || !set) return;
  for (const sid of set) io.sockets.sockets.get(sid)?.emit(event, payload);
}

// Invitation en salle privée : prévient tous les sockets de l'ami
function invite(socket, toUserId) {
  const room = rooms.get(socket.data.roomId);
  if (!room || room.isPublic || !room.code) {
    return socket.emit('mp:error', { msg: 'Crée une salle privée pour inviter.' });
  }
  const set = online.get(toUserId);
  if (!set || !set.size) return socket.emit('mp:error', { msg: 'Ce joueur est hors ligne.' });
  for (const sid of set) {
    io.sockets.sockets.get(sid)?.emit('mp:invited', { code: room.code, from: socket.data.user.displayName });
  }
  socket.emit('mp:info', { msg: 'Invitation envoyée ✓' });
}

function parseCookies(str) {
  const out = {};
  (str || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function genCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 6).toUpperCase(); }
  while ([...rooms.values()].some((r) => r.code === code));
  return code;
}
function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected);
}

// ── Snapshot ──
function roomSnapshot(room) {
  return {
    roomId: room.id, code: room.isPublic ? null : room.code,
    isPublic: room.isPublic, ranked: room.ranked, status: room.status,
    hostId: room.hostId, settings: room.settings,
    countdownEndsAt: room.countdownEndsAt || null, chat: room.chat.slice(-30),
    players: [...room.players.values()].map((p) => ({
      name: p.name, avatarUrl: p.avatarUrl, frame: publicCosmetic(byId(p.avatarFrame)),
      isHost: p.userId === room.hostId, connected: p.connected,
    })),
  };
}
function broadcastRoom(room) { io.to(room.id).emit('mp:room', roomSnapshot(room)); }
function playersPublic(room) { return [...room.players.values()].map((p) => ({ name: p.name, avatarUrl: p.avatarUrl })); }
function sysChat(room, text) { room.chat.push({ system: true, text }); }

// ── Salles ──
function newRoom({ isPublic, ranked }) {
  const id = 'r_' + Math.random().toString(36).slice(2, 9);
  const room = {
    id, isPublic, ranked: !!ranked, code: isPublic ? null : genCode(),
    hostId: null, players: new Map(),
    settings: ranked ? { ...RANKED_SETTINGS } : { rounds: 10, roundMs: 25000, mode: 'classic', themeType: 'all' },
    status: 'lobby', chat: [], round: 0, current: null,
    usedSongIds: new Set(), usedAnilistIds: new Set(),
    nextSong: null, nextSongPromise: null,
    timer: null, countdownTimer: null, countdownEndsAt: 0, revealSong: null, revealUntil: 0,
  };
  rooms.set(id, room);
  return room;
}
function addPlayer(room, socket) {
  const u = socket.data.user;
  socket.data.roomId = room.id;
  socket.join(room.id);
  userRoom.set(u.id, room.id);
  if (!room.hostId) room.hostId = u.id;
  room.players.set(u.id, { userId: u.id, name: u.displayName, avatarUrl: u.avatarUrl, avatarFrame: u.avatarFrame, socketId: socket.id, connected: true, score: 0, dcTimer: null });
}

function joinPublic(socket, ranked) {
  if (socket.data.roomId) return rooms.get(socket.data.roomId) || null;
  const ptr = ranked ? rankedRoomId : publicRoomId;
  let room = ptr ? rooms.get(ptr) : null;
  if (!room || room.status !== 'lobby' || room.players.size >= MAX_PLAYERS) {
    room = newRoom({ isPublic: true, ranked });
    if (ranked) rankedRoomId = room.id; else publicRoomId = room.id;
  }
  addPlayer(room, socket);
  sysChat(room, `${socket.data.user.displayName} a rejoint`);
  maybeCountdown(room);
  broadcastRoom(room);
  return room;
}
function createRoom(socket, settings) {
  if (socket.data.roomId) return rooms.get(socket.data.roomId) || null;
  const room = newRoom({ isPublic: false, ranked: false });
  applySettings(room, settings);
  addPlayer(room, socket);
  socket.emit('mp:joined', { roomId: room.id });
  broadcastRoom(room);
  return room;
}
function joinByCode(socket, code) {
  if (socket.data.roomId) return rooms.get(socket.data.roomId) || null;
  const room = [...rooms.values()].find((r) => r.code === String(code || '').toUpperCase() && !r.isPublic);
  if (!room) { socket.emit('mp:error', { msg: 'Salle introuvable' }); return null; }
  if (room.status !== 'lobby') { socket.emit('mp:error', { msg: 'Partie déjà commencée' }); return null; }
  if (room.players.size >= MAX_PLAYERS) { socket.emit('mp:error', { msg: 'Salle pleine' }); return null; }
  addPlayer(room, socket);
  sysChat(room, `${socket.data.user.displayName} a rejoint`);
  socket.emit('mp:joined', { roomId: room.id });
  broadcastRoom(room);
  return room;
}

function applySettings(room, s) {
  if (!s || room.ranked) return;
  if (VALID_ROUNDS.includes(s.rounds)) room.settings.rounds = s.rounds;
  if (VALID_ROUNDMS.includes(s.roundMs)) room.settings.roundMs = s.roundMs;
  if (VALID_MODES.includes(s.mode)) room.settings.mode = s.mode;
  if (VALID_THEME_TYPES.includes(s.themeType)) room.settings.themeType = s.themeType;
}
function setSettings(socket, s) {
  const room = rooms.get(socket.data.roomId);
  if (!room || room.hostId !== socket.data.user.id || room.status !== 'lobby') return;
  applySettings(room, s);
  broadcastRoom(room);
}

function maybeCountdown(room) {
  if (!room.isPublic) return;
  if (room.players.size >= PUBLIC_MIN && !room.countdownTimer) {
    room.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    room.countdownTimer = setTimeout(() => startGame(room), COUNTDOWN_MS);
  } else if (room.players.size < PUBLIC_MIN && room.countdownTimer) {
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
    room.countdownEndsAt = 0;
  }
}
function hostStart(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room || room.hostId !== socket.data.user.id || room.status !== 'lobby') return;
  if (room.players.size < (room.isPublic ? PUBLIC_MIN : 1)) return;
  startGame(room);
}

// ── Boucle de jeu ──
function startGame(room) {
  if (room.status !== 'lobby') return;
  if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
  room.countdownEndsAt = 0;
  if (publicRoomId === room.id) publicRoomId = null;
  if (rankedRoomId === room.id) rankedRoomId = null;
  room.status = 'playing';
  room.round = 0;
  room.usedSongIds = new Set();
  room.usedAnilistIds = new Set();
  room.nextSong = null;
  room.nextSongPromise = null;
  room.mode = room.settings.mode || 'classic';

  const arr = [...room.players.values()];
  arr.forEach((p) => { p.score = 0; p.correct = 0; p.team = null; p.lives = ELIM_LIVES; p.eliminated = false; });
  if (room.mode === 'teams') shuffle(arr).forEach((p, i) => { p.team = i % 2; });

  io.to(room.id).emit('mp:game:start', {
    totalRounds: room.settings.rounds, ranked: room.ranked, mode: room.mode, elimLives: ELIM_LIVES,
    teamNames: TEAM_NAMES,
    players: arr.map((p) => ({ name: p.name, avatarUrl: p.avatarUrl, team: p.team })),
  });
  // La première musique commence à charger presque immédiatement ; son délai
  // de préparation remplace l'ancien écran d'attente vide.
  setTimeout(() => startRound(room), 250);
}

async function pickSong(room) {
  const base = availableSongWhere(room);
  // Priorité à la série principale (exclut films/OAV connus), repli si vide.
  let where = { ...base, ...preferMainContent };
  let total = await prisma.song.count({ where });
  if (!total) { where = base; total = await prisma.song.count({ where }); }
  if (!total) return null;
  const song = await prisma.song.findFirst({
    where,
    skip: Math.floor(Math.random() * total),
    select: {
      id: true, anilistId: true, animeTitle: true, altTitles: true,
      title: true, artist: true, type: true, number: true, videoUrl: true, audioUrl: true,
    },
  });
  if (!song) return null;
  room.usedSongIds.add(song.id);
  room.usedAnilistIds.add(song.anilistId);
  return song;
}

function availableSongWhere(room) {
  return {
    videoUrl: { not: null },
    ...(room.settings?.themeType && room.settings.themeType !== 'all' ? { type: room.settings.themeType } : {}),
    ...(room.usedAnilistIds.size ? { anilistId: { notIn: [...room.usedAnilistIds] } } : {}),
  };
}

async function startRound(room) {
  if (room.status !== 'playing' || !rooms.has(room.id)) return;
  room.round++;
  let song = room.nextSong;
  if (!song && room.nextSongPromise) song = await room.nextSongPromise;
  room.nextSong = null;
  room.nextSongPromise = null;
  if (!song) song = await pickSong(room);
  if (!song) return endGame(room);
  const prepMs = room.round === 1 ? FIRST_ROUND_PREP_MS : PRELOADED_ROUND_PREP_MS;
  const startAt = Date.now() + prepMs;
  const endsAt = startAt + room.settings.roundMs;
  room.current = { song, startAt, endsAt, answers: new Map(), passed: new Set() };
  io.to(room.id).emit('mp:round:start', {
    round: room.round, total: room.settings.rounds,
    clipUrl: `/api/mp/clip/${room.id}?r=${room.round}`, startAt, duration: room.settings.roundMs,
  });
  room.timer = setTimeout(() => endRound(room), prepMs + room.settings.roundMs);
}

async function prepareNextRound(room) {
  if (room.nextSong || room.nextSongPromise || room.status !== 'playing') return;
  const nextRound = room.round + 1;
  room.nextSongPromise = pickSong(room);
  try {
    const song = await room.nextSongPromise;
    if (!song || room.status !== 'playing' || room.current || nextRound !== room.round + 1) return;
    room.nextSong = song;
    io.to(room.id).emit('mp:round:preload', {
      round: nextRound,
      clipUrl: `/api/mp/clip/${room.id}?r=${nextRound}`,
    });
  } catch (error) {
    console.error('mp preload error:', error.message);
  }
}

// Progrès de la manche (combien ont trouvé / passé sur le total)
function emitProgress(room) {
  const cur = room.current;
  if (!cur) return;
  io.to(room.id).emit('mp:round:progress', {
    answered: cur.answers.size,
    correct: [...cur.answers.values()].filter((a) => a.correct).length,
    passed: cur.passed.size,
    total: connectedPlayers(room).length,
  });
}

// Une réponse validée est définitive : dès que tous les joueurs ont répondu
// ou passé, on révèle immédiatement le résultat.
function everyoneResolved(room) {
  const cur = room.current;
  if (!cur) return false;
  const active = connectedPlayers(room).filter((p) => !p.eliminated);
  return active.length > 0 && active.every((p) => cur.answers.has(p.userId) || cur.passed.has(p.userId));
}

function onGuess(socket, text) {
  const room = rooms.get(socket.data.roomId);
  if (!room || !room.current) return;
  const uid = socket.data.user.id;
  const player = room.players.get(uid);
  if (!player || player.eliminated) return; // les éliminés sont spectateurs
  const cur = room.current;
  if (cur.answers.has(uid) || cur.passed.has(uid) || Date.now() > cur.endsAt) return;
  const correct = isCorrectGuess(text, cur.song);
  const timeLeft = correct ? Math.max(0, cur.endsAt - Date.now()) : 0;
  const points = correct ? 300 + Math.round((timeLeft / room.settings.roundMs) * 700) : 0;
  cur.answers.set(uid, { correct, points, guess: text });
  if (correct) {
    player.score += points;
    player.correct = (player.correct || 0) + 1;
  }
  socket.emit('mp:guess:ack', { correct, final: true });
  emitProgress(room);
  if (everyoneResolved(room)) { clearTimeout(room.timer); endRound(room); }
}

// « Passer » : le joueur déclare ne pas savoir (verrouillé pour la manche)
function onSkip(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room || !room.current) return;
  const uid = socket.data.user.id;
  const player = room.players.get(uid);
  if (!player || player.eliminated) return;
  const cur = room.current;
  if (cur.answers.has(uid) || cur.passed.has(uid) || Date.now() > cur.endsAt) return;
  cur.passed.add(uid);
  socket.emit('mp:skip:ack', {});
  emitProgress(room);
  if (everyoneResolved(room)) { clearTimeout(room.timer); endRound(room); }
}

function aliveCount(room) {
  return [...room.players.values()].filter((p) => !p.eliminated).length;
}
function teamTotals(room) {
  const t = [0, 0];
  for (const p of room.players.values()) if (p.team != null) t[p.team] += p.score;
  return t;
}

function endRound(room) {
  if (!room.current || !rooms.has(room.id)) return;
  const cur = room.current;
  room.current = null;
  const s = cur.song;

  // Élimination : qui rate (ou n'a pas répondu) perd une vie ; 0 vie → éliminé
  if (room.mode === 'elim') {
    for (const p of room.players.values()) {
      if (p.eliminated) continue;
      if (!cur.answers.get(p.userId)?.correct) {
        p.lives = Math.max(0, (p.lives || 0) - 1);
        if (p.lives === 0) p.eliminated = true;
      }
    }
  }

  const results = [...room.players.values()]
    .map((p) => {
      const a = cur.answers.get(p.userId);
      return {
        name: p.name, avatarUrl: p.avatarUrl, frame: publicCosmetic(byId(p.avatarFrame)),
        correct: !!a?.correct, points: a?.points || 0,
        score: p.score, team: p.team, lives: p.lives, eliminated: p.eliminated,
      };
    })
    .sort((a, b) => b.score - a.score);

  io.to(room.id).emit('mp:round:result', {
    round: room.round, total: room.settings.rounds, mode: room.mode,
    answer: {
      animeTitle: s.animeTitle, englishTitle: englishTitleFor(s),
      title: s.title, artist: s.artist, type: s.type, number: s.number,
    },
    results,
    teams: room.mode === 'teams' ? teamTotals(room) : null,
  });
  room.revealSong = s;
  room.revealUntil = Date.now() + RESULT_MS;
  const elimOver = room.mode === 'elim' && aliveCount(room) <= 1;
  const matchOver = elimOver || room.round >= room.settings.rounds || room.round >= ELIM_MAX_ROUNDS;
  if (!matchOver) prepareNextRound(room);
  room.timer = setTimeout(() => {
    room.revealSong = null;
    if (matchOver) endGame(room);
    else startRound(room);
  }, RESULT_MS);
}

// Récompense brute (avant plafond quotidien) d'un joueur selon perf + placement
function rawReward(p, placement) {
  const base = (p.correct || 0) * MP_TOKENS_PER_CORRECT + (MP_PLACEMENT_BONUS[placement - 1] || 0);
  return Math.min(MP_GAME_CAP, base);
}

// Persistance + MMR + récompense tokens à la fin
async function persistResults(room, ordered) {
  // ordered: [{userId, name, score, correct}] trié (vainqueur d'abord)
  const ids = ordered.map((p) => p.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, mmr: true, mpRewardDay: true, mpRewardToday: true },
  });
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const mmrById = Object.fromEntries(users.map((u) => [u.id, u.mmr]));
  const deltas = room.ranked
    ? computeMmrDeltas(ordered.map((p) => ({ userId: p.userId, score: p.score, mmr: mmrById[p.userId] ?? 1000 })))
    : [];
  const deltaById = Object.fromEntries(deltas.map((d) => [d.userId, d]));

  // Récompense seulement si au moins 2 comptes distincts (pas de solo en boucle)
  const rewardEnabled = ordered.length >= MP_MIN_PLAYERS_REWARD;
  const today = todayStr();
  const rewardById = {};

  await prisma.$transaction(
    ordered.flatMap((p, i) => {
      const placement = i + 1;
      const before = mmrById[p.userId] ?? 1000;
      const delta = room.ranked ? deltaById[p.userId]?.delta || 0 : 0;
      const after = before + delta;

      // Token reward avec plafond quotidien
      let granted = 0;
      if (rewardEnabled) {
        const u = byId[p.userId] || {};
        const usedToday = u.mpRewardDay === today ? (u.mpRewardToday || 0) : 0;
        const dailyLeft = Math.max(0, MP_DAILY_CAP - usedToday);
        granted = Math.min(rawReward(p, placement), dailyLeft);
      }
      rewardById[p.userId] = granted;

      const ops = [
        prisma.mpResult.create({
          data: {
            userId: p.userId, ranked: room.ranked, placement, players: ordered.length,
            score: p.score, mmrBefore: room.ranked ? before : null, mmrAfter: room.ranked ? after : null,
          },
        }),
      ];

      // Mise à jour utilisateur : MMR (si classé) + tokens (si récompense)
      const data = {};
      if (room.ranked) {
        data.mmr = Math.max(100, after);
        data.rankedGames = { increment: 1 };
        data.rankedWins = { increment: placement === 1 ? 1 : 0 };
      }
      if (granted > 0) {
        const usedToday = byId[p.userId]?.mpRewardDay === today ? (byId[p.userId]?.mpRewardToday || 0) : 0;
        data.tokens = { increment: granted };
        data.mpRewardDay = today;
        data.mpRewardToday = usedToday + granted;
      }
      if (Object.keys(data).length) ops.push(prisma.user.update({ where: { id: p.userId }, data }));
      if (granted > 0) ops.push(prisma.tokenTransaction.create({ data: { userId: p.userId, amount: granted, reason: 'mp_reward' } }));
      return ops;
    })
  );
  return { deltaById, rewardById };
}

async function endGame(room) {
  room.status = 'over';
  clearTimeout(room.timer);
  // Classement : élimination = survivants d'abord (par vies puis score), sinon par score
  const ordered = [...room.players.values()]
    .map((p) => ({ userId: p.userId, name: p.name, avatarUrl: p.avatarUrl, frame: publicCosmetic(byId(p.avatarFrame)), score: p.score, correct: p.correct || 0, team: p.team, lives: p.lives, eliminated: p.eliminated }))
    .sort((a, b) => {
      if (room.mode === 'elim') {
        if (!!a.eliminated !== !!b.eliminated) return a.eliminated ? 1 : -1;
        if ((b.lives || 0) !== (a.lives || 0)) return (b.lives || 0) - (a.lives || 0);
      }
      return b.score - a.score;
    });

  let deltaById = {}, rewardById = {};
  try { ({ deltaById, rewardById } = await persistResults(room, ordered)); }
  catch (e) { console.error('mp persist error:', e.message); }
  for (const p of ordered) progressQuests(p.userId, 'mp', 1); // quête « parties multi »

  const ranking = ordered.map((p, i) => ({
    userId: p.userId,
    name: p.name, avatarUrl: p.avatarUrl, frame: p.frame, score: p.score, team: p.team,
    lives: p.lives, eliminated: p.eliminated,
    mmrDelta: room.ranked ? deltaById[p.userId]?.delta ?? 0 : null,
    tokenReward: rewardById[p.userId] || 0,
  }));
  let teams = null;
  if (room.mode === 'teams') {
    const t = teamTotals(room);
    teams = TEAM_NAMES.map((name, i) => ({ name, score: t[i] }));
  }
  io.to(room.id).emit('mp:game:over', { ranked: room.ranked, mode: room.mode, teamNames: TEAM_NAMES, teams, ranking });

  if (room.isPublic) {
    setTimeout(() => closeRoom(room), 30000);
  } else {
    room.status = 'lobby';
    room.round = 0; room.current = null;
    room.usedSongIds = new Set(); room.usedAnilistIds = new Set();
    room.nextSong = null; room.nextSongPromise = null;
    sysChat(room, 'Partie terminée — prêts pour une autre ?');
    setTimeout(() => { if (rooms.has(room.id)) broadcastRoom(room); }, 8000);
  }
}

function closeRoom(room) {
  for (const p of room.players.values()) {
    if (p.dcTimer) clearTimeout(p.dcTimer);
    userRoom.delete(p.userId);
    const s = p.socketId && io.sockets.sockets.get(p.socketId);
    if (s) { s.leave(room.id); s.data.roomId = null; }
  }
  if (room.timer) clearTimeout(room.timer);
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  rooms.delete(room.id);
  if (publicRoomId === room.id) publicRoomId = null;
  if (rankedRoomId === room.id) rankedRoomId = null;
}

// Retrait définitif d'un joueur (départ volontaire ou délai de grâce écoulé)
function removePlayer(room, userId) {
  const p = room.players.get(userId);
  if (!p) return;
  if (p.dcTimer) clearTimeout(p.dcTimer);
  room.players.delete(userId);
  if (userRoom.get(userId) === room.id) userRoom.delete(userId);
  if (room.players.size === 0) { closeRoom(room); return; }
  if (room.hostId === userId) room.hostId = room.players.keys().next().value;
  sysChat(room, `${p.name} est parti`);
  if (room.isPublic) maybeCountdown(room);
  if (room.current) {
    const conn = connectedPlayers(room);
    if (conn.length && conn.every((pl) => room.current.answers.get(pl.userId)?.correct)) {
      clearTimeout(room.timer);
      endRound(room);
    }
  }
  broadcastRoom(room);
}

// Départ volontaire
function leaveRoom(socket) {
  const room = rooms.get(socket.data.roomId);
  socket.data.roomId = null;
  if (!room) return;
  socket.leave(room.id);
  removePlayer(room, socket.data.user.id);
}

// Déconnexion (refresh, perte réseau) : on garde le slot avec un délai de grâce
function onDisconnect(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return;
  const p = room.players.get(socket.data.user.id);
  if (!p || p.socketId !== socket.id) return; // un autre socket a déjà repris ce joueur
  p.connected = false;
  p.socketId = null;
  // Classé EN COURS : on garde le slot jusqu'à la fin de la partie. Quitter ne
  // permet donc plus d'échapper à la défaite (le joueur finit avec son score
  // courant et encaisse sa variation de MMR). La reconnexion reste possible à
  // tout moment ; le retrait se fait au closeRoom en fin de partie.
  if (room.ranked && room.status === 'playing') return;
  const grace = room.status === 'playing' ? DC_GRACE_GAME : DC_GRACE_LOBBY;
  p.dcTimer = setTimeout(() => removePlayer(room, socket.data.user.id), grace);
  if (room.status === 'lobby') broadcastRoom(room);
}

// Reconnexion : ré-attache un nouveau socket au joueur existant
function reattach(socket) {
  const uid = socket.data.user.id;
  const roomId = userRoom.get(uid);
  if (!roomId) return false;
  const room = rooms.get(roomId);
  if (!room) { userRoom.delete(uid); return false; }
  const p = room.players.get(uid);
  if (!p) { userRoom.delete(uid); return false; }
  if (p.dcTimer) { clearTimeout(p.dcTimer); p.dcTimer = null; }
  p.connected = true;
  p.socketId = socket.id;
  socket.data.roomId = roomId;
  socket.join(roomId);

  if (room.status === 'lobby' || room.status === 'over') {
    broadcastRoom(room);
  } else if (room.status === 'playing') {
    socket.emit('mp:game:start', {
      totalRounds: room.settings.rounds, ranked: room.ranked, mode: room.mode, elimLives: ELIM_LIVES, teamNames: TEAM_NAMES,
      players: [...room.players.values()].map((pp) => ({ name: pp.name, avatarUrl: pp.avatarUrl, team: pp.team })),
    });
    if (room.current && !p.eliminated) {
      const remaining = Math.max(1500, room.current.endsAt - Date.now());
      socket.emit('mp:round:start', {
        round: room.round, total: room.settings.rounds,
        clipUrl: `/api/mp/clip/${room.id}?r=${room.round}`, startAt: Date.now(),
        duration: remaining, resumed: true,
        alreadyAnswered: !!room.current.answers.get(uid)?.correct,
        alreadyPassed: room.current.passed.has(uid),
      });
    }
  }
  return true;
}

function chat(socket, text) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return;
  const t = String(text || '').trim().slice(0, 200);
  if (!t) return;
  room.chat.push({ name: socket.data.user.displayName, text: t });
  if (room.chat.length > 60) room.chat = room.chat.slice(-40);
  io.to(room.id).emit('mp:chat', { name: socket.data.user.displayName, text: t });
}
function emote(socket, e) {
  const room = rooms.get(socket.data.roomId);
  if (!room || !EMOTES.includes(e)) return;
  io.to(room.id).emit('mp:emote', { name: socket.data.user.displayName, emote: e });
}

function videoForRound(room, requestedRound) {
  const round = Number(requestedRound);
  if (room.current && (!round || round === room.round)) return preferredMediaUrl(room.current.song);
  if (room.nextSong && round === room.round + 1) return preferredMediaUrl(room.nextSong);
  if (room.revealSong && (!round || round === room.round) && Date.now() < (room.revealUntil || 0)) {
    return preferredMediaUrl(room.revealSong);
  }
  return null;
}

function getCurrentVideo(roomId, userId, requestedRound) {
  const room = rooms.get(roomId);
  if (!room || !room.players.has(userId)) return null;
  return videoForRound(room, requestedRound);
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
        where: { id: payload.sub }, select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true },
      });
      if (!user) return next(new Error('auth'));
      socket.data.user = user;
      next();
    } catch { next(new Error('auth')); }
  });
  io.on('connection', (socket) => {
    addOnline(socket);
    reattach(socket); // restaure une partie en cours si l'utilisateur en avait une
    socket.on('mp:invite', (toUserId) => invite(socket, String(toUserId || '')));
    socket.on('mp:quick', (ack) => {
      const room = joinPublic(socket, false);
      if (typeof ack === 'function') ack({ ok: !!room, players: room?.players.size || 0 });
    });
    socket.on('mp:ranked', (ack) => {
      const room = joinPublic(socket, true);
      if (typeof ack === 'function') ack({ ok: !!room, players: room?.players.size || 0 });
    });
    socket.on('mp:create', (s, ack) => {
      const room = createRoom(socket, s);
      if (typeof ack === 'function') ack({ ok: !!room, players: room?.players.size || 0, code: room?.code || null });
    });
    socket.on('mp:join', (code, ack) => {
      const room = joinByCode(socket, code);
      if (typeof ack === 'function') ack({ ok: !!room, players: room?.players.size || 0 });
    });
    socket.on('mp:settings', (s) => setSettings(socket, s));
    socket.on('mp:start', () => hostStart(socket));
    socket.on('mp:leave', () => leaveRoom(socket));
    socket.on('mp:chat', (t) => chat(socket, t));
    socket.on('mp:emote', (e) => emote(socket, e));
    socket.on('mp:guess', (t) => onGuess(socket, String(t || '').slice(0, 120)));
    socket.on('mp:skip', () => onSkip(socket));
    socket.on('disconnect', () => { removeOnline(socket); onDisconnect(socket); });
  });
  return io;
}

module.exports = { initMp, getCurrentVideo, isOnline, notifyUser, everyoneResolved, availableSongWhere, videoForRound, rawReward, MP_GAME_CAP };
