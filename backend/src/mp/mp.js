// Multijoueur temps réel : salles (rapide / classé / privées), lobby+chat,
// manches synchronisées, reconnexion (clé par compte) et classé persistant (MMR).
const { prisma } = require('../db');
const { verifyToken, COOKIE_NAME } = require('../auth/jwt');
const { isCorrectGuess } = require('../quiz/matching');
const { englishTitleFor } = require('../quiz/anime-titles');
const { computeMmrDeltas } = require('./rank');
const { progressQuests } = require('../quests/quests');
const { weekKey } = require('../util/week');
const { byId, publicCosmetic } = require('../shop/cosmetics');
const { preferredMediaUrl } = require('../storage/r2');
const { preferMainContent } = require('../catalog/format');

const MAX_PLAYERS = 8;
const PUBLIC_MIN = 2;
const COUNTDOWN_MS = 20000;
const FIRST_ROUND_PREP_MS = 3000;
const PRELOADED_ROUND_PREP_MS = 750;
const RESULT_MS = 8000; // durée de l'écran de révélation (réponse + scores + extrait révélé)
const DC_GRACE_LOBBY = 25000; // délai avant retrait après déconnexion (lobby)
const DC_GRACE_GAME = 120000; // ... en partie (reconnexion possible)
const VALID_ROUNDS = [5, 10, 15, 20];
const VALID_ROUNDMS = [15000, 25000, 40000];
const VALID_MODES = ['classic', 'teams', 'elim', 'coop'];
const VALID_THEME_TYPES = ['all', 'OP', 'ED'];
const ELIM_LIVES = 3;
const ELIM_MAX_ROUNDS = 25; // garde-fou en élimination
// Coop (Tour en équipe) : vies partagées, étages infinis, l'étage est validé si
// AU MOINS un joueur trouve ; sinon −1 vie commune. Le temps se réduit avec les étages.
const COOP_START_LIVES = 3;
const COOP_MAX_FLOORS = 100; // garde-fou
const COOP_TOKENS_PER_FLOOR = 1; // gain par étage franchi (partage le plafond/jour du multi)
const COOP_GAME_CAP = 30; // max de tokens coop par partie
function coopRoundMs(floor) {
  return Math.max(12000, 25000 - (floor - 1) * 500); // 25s -> plancher 12s vers l'étage 27
}
// Durée d'une manche selon le mode (coop = décroissante par étage).
function roundDurationMs(room) {
  return room.mode === 'coop' ? coopRoundMs(room.round) : room.settings.roundMs;
}
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
    spectators: new Set(), // userIds qui regardent (pas des joueurs)
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
  room.poolUnavailable = false;
}

function joinPublic(socket, ranked, opts) {
  if (socket.data.roomId) return rooms.get(socket.data.roomId) || null;
  const ptr = ranked ? rankedRoomId : publicRoomId;
  let room = ptr ? rooms.get(ptr) : null;
  if (!room || room.status !== 'lobby' || room.players.size >= MAX_PLAYERS) {
    room = newRoom({ isPublic: true, ranked });
    if (ranked) rankedRoomId = room.id; else publicRoomId = room.id;
    // Partie rapide : le 1er joueur de la file fixe le nombre de manches.
    if (!ranked && opts && VALID_ROUNDS.includes(opts.rounds)) room.settings.rounds = opts.rounds;
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
  const room = [...rooms.values()].find((r) => r.code === String(code || '').toUpperCase() && !r.isPublic);
  if (!room) { socket.emit('mp:error', { msg: 'Salle introuvable' }); return null; }
  if (socket.data.roomId === room.id) return room; // déjà dans cette salle
  if (room.status !== 'lobby') { socket.emit('mp:error', { msg: 'Partie déjà commencée' }); return null; }
  if (room.players.size >= MAX_PLAYERS) { socket.emit('mp:error', { msg: 'Salle pleine' }); return null; }
  // Quitte la salle actuelle (ex. son propre salon coop vide) avant de rejoindre.
  if (socket.data.roomId) leaveRoom(socket);
  addPlayer(room, socket);
  sysChat(room, `${socket.data.user.displayName} a rejoint`);
  socket.emit('mp:joined', { roomId: room.id });
  broadcastRoom(room);
  return room;
}

// Liste des parties PUBLIQUES en cours (lobby ou en jeu). Les salons privés/coop
// (à code) ne sont jamais listés.
function publicRoomsList() {
  return [...rooms.values()]
    .filter((r) => r.isPublic && r.players.size > 0)
    .map((r) => ({
      id: r.id, ranked: r.ranked, mode: r.mode || r.settings.mode || 'classic',
      status: r.status, round: r.round, total: r.settings.rounds,
      players: r.players.size, names: [...r.players.values()].map((p) => p.name).slice(0, 8),
      spectators: r.spectators.size,
    }))
    .sort((a, b) => (a.status === 'playing' ? 0 : 1) - (b.status === 'playing' ? 0 : 1) || b.players - a.players);
}

// Devenir spectateur d'une partie publique (reçoit les events de la salle sans
// faire partie des joueurs). Ne fonctionne pas sur les salons privés/coop.
function spectate(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.isPublic) { socket.emit('mp:error', { msg: 'Partie introuvable' }); return false; }
  if (room.players.has(socket.data.user.id)) return false; // déjà joueur de cette partie
  if (socket.data.roomId) leaveRoom(socket); // on ne spectate pas en jouant
  if (socket.data.spectating && socket.data.spectating !== roomId) stopSpectating(socket);
  socket.join(room.id);
  socket.data.spectating = room.id;
  room.spectators.add(socket.data.user.id);
  // État courant envoyé au seul spectateur (les autres l'ont déjà reçu).
  if (room.status === 'playing') {
    const arr = [...room.players.values()];
    socket.emit('mp:game:start', {
      totalRounds: room.mode === 'coop' ? null : room.settings.rounds, ranked: room.ranked, mode: room.mode,
      elimLives: ELIM_LIVES, coop: room.mode === 'coop', teamLives: room.teamLives, teamNames: TEAM_NAMES,
      spectator: true, players: arr.map((p) => ({ name: p.name, avatarUrl: p.avatarUrl, team: p.team })),
    });
    if (room.current) {
      const remaining = Math.max(1500, room.current.endsAt - Date.now());
      socket.emit('mp:round:start', {
        round: room.round, total: room.mode === 'coop' ? null : room.settings.rounds,
        coop: room.mode === 'coop', teamLives: room.teamLives, spectator: true,
        clipUrl: `/api/mp/clip/${room.id}?r=${room.round}`, startAt: Date.now(), duration: remaining,
      });
    }
  } else {
    socket.emit('mp:room', { ...roomSnapshot(room), spectator: true });
  }
  return true;
}
function stopSpectating(socket) {
  const roomId = socket.data.spectating;
  if (!roomId) return;
  socket.data.spectating = null;
  const room = rooms.get(roomId);
  if (room) { room.spectators.delete(socket.data.user.id); socket.leave(roomId); }
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
  if (room.players.size >= PUBLIC_MIN && !room.countdownTimer && !room.poolUnavailable) {
    room.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    room.countdownTimer = setTimeout(() => {
      startGame(room).catch((e) => console.error('mp start error:', e && e.message));
    }, COUNTDOWN_MS);
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
  room.poolUnavailable = false;
  startGame(room).catch((e) => console.error('mp start error:', e && e.message));
}

// ── Boucle de jeu ──
async function startGame(room) {
  if (room.status !== 'lobby') return;
  room.status = 'starting';
  if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
  room.countdownEndsAt = 0;

  // Partie rapide non classée : pool commun = union des listes des joueurs
  // présents au lancement. Le classé et les salons privés gardent le catalogue global.
  room.songPoolIds = null;
  if (room.isPublic && !room.ranked) {
    try {
      const entries = await prisma.userCatalogEntry.findMany({
        where: { userId: { in: [...room.players.keys()] } },
        select: { songId: true },
      });
      room.songPoolIds = [...new Set(entries.map((entry) => entry.songId))];
    } catch (e) {
      console.error('mp quick pool error:', e && e.message);
      room.songPoolIds = [];
    }
    if (!room.songPoolIds.length) {
      room.status = 'lobby';
      room.poolUnavailable = true;
      io.to(room.id).emit('mp:error', {
        msg: 'Aucun son disponible dans les listes des joueurs présents. Importez au moins une liste AniList.',
      });
      broadcastRoom(room);
      return;
    }
  }

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
  // Coop : pool de vies commun + compteur d'étages franchis.
  room.teamLives = room.mode === 'coop' ? COOP_START_LIVES : 0;
  room.coopCleared = 0;

  io.to(room.id).emit('mp:game:start', {
    totalRounds: room.mode === 'coop' ? null : room.settings.rounds, ranked: room.ranked, mode: room.mode,
    elimLives: ELIM_LIVES, coop: room.mode === 'coop', teamLives: room.teamLives,
    teamNames: TEAM_NAMES,
    players: arr.map((p) => ({ name: p.name, avatarUrl: p.avatarUrl, team: p.team })),
  });
  // La première musique commence à charger presque immédiatement ; son délai
  // de préparation remplace l'ancien écran d'attente vide.
  setTimeout(() => { Promise.resolve(startRound(room)).catch((e) => console.error('mp: échec démarrage manche:', e && e.message)); }, 250);
}

async function pickSong(room) {
  const base = availableSongWhere(room);
  // Priorité à la série principale (exclut films/OAV connus), repli si vide ou
  // si le filtre échoue (ex. colonne format absente) → ne doit jamais figer la manche.
  let where = base;
  let total = 0;
  try {
    where = { ...base, ...preferMainContent };
    total = await prisma.song.count({ where });
    if (!total) { where = base; total = await prisma.song.count({ where }); }
  } catch (e) {
    console.error('pickSong filtre format indisponible, repli:', e.message);
    where = base;
    total = await prisma.song.count({ where });
  }
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
    ...(Array.isArray(room.songPoolIds) ? { id: { in: room.songPoolIds } } : {}),
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
  const durationMs = roundDurationMs(room);
  const startAt = Date.now() + prepMs;
  const endsAt = startAt + durationMs;
  room.current = { song, startAt, endsAt, answers: new Map(), passed: new Set() };
  io.to(room.id).emit('mp:round:start', {
    round: room.round, total: room.mode === 'coop' ? null : room.settings.rounds,
    coop: room.mode === 'coop', teamLives: room.teamLives,
    clipUrl: `/api/mp/clip/${room.id}?r=${room.round}`, startAt, duration: durationMs,
  });
  room.timer = setTimeout(() => endRound(room), prepMs + durationMs);
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
  const points = correct ? 300 + Math.round((timeLeft / roundDurationMs(room)) * 700) : 0;
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

  // Coop : l'étage est franchi si AU MOINS un joueur a trouvé ; sinon −1 vie commune.
  let floorCleared = false;
  if (room.mode === 'coop') {
    floorCleared = [...cur.answers.values()].some((a) => a.correct);
    if (floorCleared) room.coopCleared = (room.coopCleared || 0) + 1;
    else room.teamLives = Math.max(0, (room.teamLives || 0) - 1);
  }

  // Émission du résultat protégée : une erreur ici ne doit pas empêcher la
  // programmation de la transition ci-dessous (sinon la partie se fige).
  try {
    const results = [...room.players.values()]
      .map((p) => {
        const a = cur.answers.get(p.userId);
        return {
          name: p.name, avatarUrl: p.avatarUrl, frame: publicCosmetic(byId(p.avatarFrame)),
          correct: !!a?.correct, points: a?.points || 0,
          guess: a?.guess || null, passed: cur.passed.has(p.userId), // réponse saisie par le joueur (révélée à tous)
          score: p.score, team: p.team, lives: p.lives, eliminated: p.eliminated,
        };
      })
      .sort((a, b) => b.score - a.score);

    io.to(room.id).emit('mp:round:result', {
      round: room.round, total: room.mode === 'coop' ? null : room.settings.rounds, mode: room.mode,
      coop: room.mode === 'coop', teamLives: room.teamLives, floorCleared,
      answer: {
        songId: s.id,
        animeTitle: s.animeTitle, englishTitle: englishTitleFor(s),
        title: s.title, artist: s.artist, type: s.type, number: s.number,
      },
      results,
      teams: room.mode === 'teams' ? teamTotals(room) : null,
    });
  } catch (e) {
    console.error('mp round:result error:', e && (e.stack || e.message) || e);
  }
  room.revealSong = s;
  room.revealUntil = Date.now() + RESULT_MS;
  const elimOver = room.mode === 'elim' && aliveCount(room) <= 1;
  const coopOver = room.mode === 'coop' && (room.teamLives <= 0 || room.round >= COOP_MAX_FLOORS);
  const matchOver = coopOver || elimOver
    || (room.mode !== 'coop' && (room.round >= room.settings.rounds || room.round >= ELIM_MAX_ROUNDS));
  if (!matchOver) prepareNextRound(room).catch((e) => console.error('mp: échec préparation manche suivante:', e && e.message));
  room.timer = setTimeout(() => {
    room.revealSong = null;
    // Sécurise la transition : une erreur ne doit ni planter le process ni figer
    // la partie → en cas d'échec d'une manche, on termine proprement la partie.
    Promise.resolve(matchOver ? endGame(room) : startRound(room)).catch((e) => {
      console.error('mp: échec de transition de manche:', e && e.message);
      if (!matchOver) Promise.resolve(endGame(room)).catch(() => {});
    });
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

// Fin de la Tour en équipe (coop) : pas de MMR/récompense, on retient l'étage et
// le record perso, puis retour au lobby (le salon coop est toujours privé).
async function endCoopGame(room) {
  const floor = room.coopCleared || 0;
  let ranking = [];
  try {
    const ordered = [...room.players.values()]
      .map((p) => ({ userId: p.userId, name: p.name, avatarUrl: p.avatarUrl, frame: publicCosmetic(byId(p.avatarFrame)), correct: p.correct || 0, score: p.score }))
      .sort((a, b) => b.correct - a.correct || b.score - a.score);
    let bestBy = {};
    const rewardBy = {};
    try {
      const ids = ordered.map((p) => p.userId);
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, coopBestFloor: true, mpRewardDay: true, mpRewardToday: true },
      });
      bestBy = Object.fromEntries(users.map((u) => [u.id, u.coopBestFloor || 0]));
      const byId = Object.fromEntries(users.map((u) => [u.id, u]));
      // Gain plafonné (≥ 2 comptes distincts), partageant le budget quotidien du multi.
      const rewardEnabled = ordered.length >= MP_MIN_PLAYERS_REWARD && floor > 0;
      const today = todayStr();
      await prisma.$transaction(
        ordered.flatMap((p) => {
          const u = byId[p.userId] || {};
          const data = {};
          if ((bestBy[p.userId] || 0) < floor) data.coopBestFloor = floor; // record perso
          let granted = 0;
          if (rewardEnabled) {
            const usedToday = u.mpRewardDay === today ? (u.mpRewardToday || 0) : 0;
            const dailyLeft = Math.max(0, MP_DAILY_CAP - usedToday);
            granted = Math.min(floor * COOP_TOKENS_PER_FLOOR, COOP_GAME_CAP, dailyLeft);
          }
          rewardBy[p.userId] = granted;
          if (granted > 0) { data.tokens = { increment: granted }; data.mpRewardDay = today; data.mpRewardToday = (u.mpRewardDay === today ? (u.mpRewardToday || 0) : 0) + granted; }
          const ops = [];
          if (Object.keys(data).length) ops.push(prisma.user.update({ where: { id: p.userId }, data }));
          if (granted > 0) ops.push(prisma.tokenTransaction.create({ data: { userId: p.userId, amount: granted, reason: 'coop_reward' } }));
          return ops;
        })
      );
      // Score hebdomadaire (classement coop + récompense aux 2 meilleurs en fin de semaine)
      if (floor > 0) {
        const week = weekKey();
        await prisma.coopWeeklyScore.createMany({ data: ids.map((uid) => ({ userId: uid, week, floor: 0 })), skipDuplicates: true });
        await prisma.coopWeeklyScore.updateMany({ where: { userId: { in: ids }, week, floor: { lt: floor } }, data: { floor } });
      }
    } catch (e) { console.error('coop reward/best update:', e && e.message); }
    for (const p of ordered) progressQuests(p.userId, 'mp', 1);
    ranking = ordered.map((p) => ({ ...p, isRecord: floor > 0 && floor > (bestBy[p.userId] || 0), tokenReward: rewardBy[p.userId] || 0 }));
  } catch (e) {
    console.error('mp endCoopGame prep error:', e && (e.stack || e.message) || e);
  }
  try {
    io.to(room.id).emit('mp:game:over', { coop: true, mode: 'coop', floor, ranking });
  } catch (e) {
    console.error('coop game:over emit error:', e && (e.stack || e.message) || e);
    try { io.to(room.id).emit('mp:game:over', { coop: true, mode: 'coop', floor, ranking: [] }); } catch {}
  }
  // Coop = toujours privé → retour au lobby pour rejouer
  room.status = 'lobby';
  room.round = 0; room.current = null; room.teamLives = 0; room.coopCleared = 0;
  room.usedSongIds = new Set(); room.usedAnilistIds = new Set();
  room.nextSong = null; room.nextSongPromise = null;
  sysChat(room, `Tour en équipe terminée — étage ${floor} ! Prêts pour une autre ?`);
  setTimeout(() => { if (rooms.has(room.id)) broadcastRoom(room); }, 8000);
}

async function endGame(room) {
  room.status = 'over';
  clearTimeout(room.timer);
  if (room.mode === 'coop') return endCoopGame(room);

  let ordered = [];
  // Le classement ne dépend pas de la BDD : on l'envoie immédiatement. Attendre
  // la persistance ici pouvait figer tous les clients sur la manche 10/10.
  try {
    ordered = [...room.players.values()]
      .map((p) => ({ userId: p.userId, name: p.name, avatarUrl: p.avatarUrl, frame: publicCosmetic(byId(p.avatarFrame)), score: p.score, correct: p.correct || 0, team: p.team, lives: p.lives, eliminated: p.eliminated }))
      .sort((a, b) => {
        if (room.mode === 'elim') {
          if (!!a.eliminated !== !!b.eliminated) return a.eliminated ? 1 : -1;
          if ((b.lives || 0) !== (a.lives || 0)) return (b.lives || 0) - (a.lives || 0);
        }
        return b.score - a.score;
      });
  } catch (e) {
    console.error('mp endGame prep error:', e && (e.stack || e.message) || e);
  }

  const ranking = ordered.map((p) => ({
    userId: p.userId,
    name: p.name, avatarUrl: p.avatarUrl, frame: p.frame, score: p.score, team: p.team,
    lives: p.lives, eliminated: p.eliminated,
    mmrDelta: null, tokenReward: 0,
  }));
  let teams = null;
  if (room.mode === 'teams') {
    const t = teamTotals(room);
    teams = TEAM_NAMES.map((name, i) => ({ name, score: t[i] }));
  }

  try {
    io.to(room.id).emit('mp:game:over', {
      ranked: room.ranked, mode: room.mode, teamNames: TEAM_NAMES, teams, ranking,
      rewardsPending: true,
    });
  } catch (e) {
    console.error('mp game:over emit error:', e && (e.stack || e.message) || e);
    try { io.to(room.id).emit('mp:game:over', { ranked: room.ranked, mode: room.mode, teamNames: TEAM_NAMES, teams: null, ranking: [] }); } catch {}
  }

  // La sauvegarde complète ensuite l'écran de fin, sans pouvoir bloquer le jeu.
  Promise.resolve(persistResults(room, ordered))
    .then(({ deltaById, rewardById }) => {
      io.to(room.id).emit('mp:game:finalized', {
        ranking: ordered.map((p) => ({
          userId: p.userId,
          mmrDelta: room.ranked ? (deltaById[p.userId]?.delta ?? 0) : null,
          tokenReward: rewardById[p.userId] || 0,
        })),
      });
    })
    .catch((e) => {
      console.error('mp persist error:', e && e.message);
      io.to(room.id).emit('mp:game:finalized', { ranking: [] });
    });
  for (const p of ordered) progressQuests(p.userId, 'mp', 1);

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
  room.poolUnavailable = false;
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
  if (socket.data.spectating) { stopSpectating(socket); return; } // spectateur : simple retrait
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
      totalRounds: room.mode === 'coop' ? null : room.settings.rounds, ranked: room.ranked, mode: room.mode,
      elimLives: ELIM_LIVES, coop: room.mode === 'coop', teamLives: room.teamLives, teamNames: TEAM_NAMES,
      players: [...room.players.values()].map((pp) => ({ name: pp.name, avatarUrl: pp.avatarUrl, team: pp.team })),
    });
    if (room.current && !p.eliminated) {
      const remaining = Math.max(1500, room.current.endsAt - Date.now());
      socket.emit('mp:round:start', {
        round: room.round, total: room.mode === 'coop' ? null : room.settings.rounds,
        coop: room.mode === 'coop', teamLives: room.teamLives,
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
  if (!room || !(room.players.has(userId) || room.spectators.has(userId))) return null;
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
    socket.on('mp:quick', (opts, ack) => {
      // Compat : si appelé avec seulement le callback (ancien client).
      if (typeof opts === 'function') { ack = opts; opts = null; }
      const room = joinPublic(socket, false, opts);
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
    socket.on('mp:rooms', (ack) => { if (typeof ack === 'function') ack({ rooms: publicRoomsList() }); });
    socket.on('mp:spectate', (roomId, ack) => {
      const ok = spectate(socket, String(roomId || ''));
      if (typeof ack === 'function') ack({ ok });
    });
    socket.on('mp:unspectate', () => stopSpectating(socket));
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
