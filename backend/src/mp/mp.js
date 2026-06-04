// Multijoueur temps réel : salles (rapide / classé / privées), lobby+chat,
// manches synchronisées, reconnexion (clé par compte) et classé persistant (MMR).
const { prisma } = require('../db');
const { verifyToken, COOKIE_NAME } = require('../auth/jwt');
const { isCorrectGuess } = require('../quiz/matching');
const { computeMmrDeltas } = require('./rank');

const MAX_PLAYERS = 8;
const PUBLIC_MIN = 2;
const COUNTDOWN_MS = 20000;
const PREP_MS = 1500;
const RESULT_MS = 6500;
const DC_GRACE_LOBBY = 25000; // délai avant retrait après déconnexion (lobby)
const DC_GRACE_GAME = 120000; // ... en partie (reconnexion possible)
const VALID_ROUNDS = [5, 10, 15, 20];
const VALID_ROUNDMS = [15000, 25000, 40000];
const EMOTES = ['😂', '🔥', '👍', '😮', '😭', '🎉', '👏', '💀'];
const RANKED_SETTINGS = { rounds: 10, roundMs: 25000 };

const rooms = new Map(); // roomId -> room
const userRoom = new Map(); // userId -> roomId (pour la reconnexion)
let publicRoomId = null;
let rankedRoomId = null;
let io = null;

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
      name: p.name, avatarUrl: p.avatarUrl, isHost: p.userId === room.hostId, connected: p.connected,
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
    settings: ranked ? { ...RANKED_SETTINGS } : { rounds: 10, roundMs: 25000 },
    status: 'lobby', chat: [], round: 0, current: null, usedSongIds: new Set(),
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
  room.players.set(u.id, { userId: u.id, name: u.displayName, avatarUrl: u.avatarUrl, socketId: socket.id, connected: true, score: 0, dcTimer: null });
}

function joinPublic(socket, ranked) {
  if (socket.data.roomId) return;
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
}
function createRoom(socket, settings) {
  if (socket.data.roomId) return;
  const room = newRoom({ isPublic: false, ranked: false });
  applySettings(room, settings);
  addPlayer(room, socket);
  socket.emit('mp:joined', { roomId: room.id });
  broadcastRoom(room);
}
function joinByCode(socket, code) {
  if (socket.data.roomId) return;
  const room = [...rooms.values()].find((r) => r.code === String(code || '').toUpperCase() && !r.isPublic);
  if (!room) return socket.emit('mp:error', { msg: 'Salle introuvable' });
  if (room.status !== 'lobby') return socket.emit('mp:error', { msg: 'Partie déjà commencée' });
  if (room.players.size >= MAX_PLAYERS) return socket.emit('mp:error', { msg: 'Salle pleine' });
  addPlayer(room, socket);
  sysChat(room, `${socket.data.user.displayName} a rejoint`);
  socket.emit('mp:joined', { roomId: room.id });
  broadcastRoom(room);
}

function applySettings(room, s) {
  if (!s || room.ranked) return;
  if (VALID_ROUNDS.includes(s.rounds)) room.settings.rounds = s.rounds;
  if (VALID_ROUNDMS.includes(s.roundMs)) room.settings.roundMs = s.roundMs;
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
  if (room.players.size < 1) return;
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
  for (const p of room.players.values()) p.score = 0;
  io.to(room.id).emit('mp:game:start', { totalRounds: room.settings.rounds, ranked: room.ranked, players: playersPublic(room) });
  setTimeout(() => startRound(room), 2500);
}

async function pickSong(room) {
  const where = { videoUrl: { not: null } };
  const total = await prisma.song.count({ where });
  if (!total) return null;
  for (let t = 0; t < 8; t++) {
    const song = await prisma.song.findFirst({
      where, skip: Math.floor(Math.random() * total),
      select: { id: true, animeTitle: true, altTitles: true, title: true, artist: true, type: true, number: true, videoUrl: true },
    });
    if (song && !room.usedSongIds.has(song.id)) { room.usedSongIds.add(song.id); return song; }
  }
  return null;
}

async function startRound(room) {
  if (room.status !== 'playing' || !rooms.has(room.id)) return;
  room.round++;
  const song = await pickSong(room);
  if (!song) return endGame(room);
  const startAt = Date.now() + PREP_MS;
  const endsAt = startAt + room.settings.roundMs;
  room.current = { song, startAt, endsAt, answers: new Map() };
  io.to(room.id).emit('mp:round:start', {
    round: room.round, total: room.settings.rounds,
    clipUrl: `/api/mp/clip/${room.id}?r=${room.round}`, startAt, duration: room.settings.roundMs,
  });
  room.timer = setTimeout(() => endRound(room), PREP_MS + room.settings.roundMs);
}

function onGuess(socket, text) {
  const room = rooms.get(socket.data.roomId);
  if (!room || !room.current) return;
  const uid = socket.data.user.id;
  const player = room.players.get(uid);
  if (!player) return;
  const cur = room.current;
  if (cur.answers.get(uid)?.correct || Date.now() > cur.endsAt) return;
  const correct = isCorrectGuess(text, cur.song);
  socket.emit('mp:guess:ack', { correct });
  if (!correct) return;
  const timeLeft = Math.max(0, cur.endsAt - Date.now());
  const points = 300 + Math.round((timeLeft / room.settings.roundMs) * 700);
  cur.answers.set(uid, { correct: true, points });
  player.score += points;
  io.to(room.id).emit('mp:round:progress', {
    answered: [...cur.answers.values()].filter((a) => a.correct).length,
    total: connectedPlayers(room).length,
  });
  const conn = connectedPlayers(room);
  if (conn.length && conn.every((p) => cur.answers.get(p.userId)?.correct)) {
    clearTimeout(room.timer);
    endRound(room);
  }
}

function endRound(room) {
  if (!room.current || !rooms.has(room.id)) return;
  const cur = room.current;
  room.current = null;
  const s = cur.song;
  const results = [...room.players.values()]
    .map((p) => {
      const a = cur.answers.get(p.userId);
      return { name: p.name, avatarUrl: p.avatarUrl, correct: !!a?.correct, points: a?.points || 0, score: p.score };
    })
    .sort((a, b) => b.score - a.score);
  io.to(room.id).emit('mp:round:result', {
    round: room.round, total: room.settings.rounds,
    answer: { animeTitle: s.animeTitle, title: s.title, artist: s.artist, type: s.type, number: s.number },
    results,
  });
  room.revealSong = s;
  room.revealUntil = Date.now() + RESULT_MS;
  room.timer = setTimeout(() => {
    room.revealSong = null;
    if (room.round >= room.settings.rounds) endGame(room);
    else startRound(room);
  }, RESULT_MS);
}

// Persistance + MMR à la fin
async function persistResults(room, ordered) {
  // ordered: [{userId, name, avatarUrl, score}] trié par score
  const ids = ordered.map((p) => p.userId);
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, mmr: true } });
  const mmrById = Object.fromEntries(users.map((u) => [u.id, u.mmr]));
  const deltas = room.ranked
    ? computeMmrDeltas(ordered.map((p) => ({ userId: p.userId, score: p.score, mmr: mmrById[p.userId] ?? 1000 })))
    : [];
  const deltaById = Object.fromEntries(deltas.map((d) => [d.userId, d]));

  await prisma.$transaction(
    ordered.flatMap((p, i) => {
      const placement = i + 1;
      const before = mmrById[p.userId] ?? 1000;
      const delta = room.ranked ? deltaById[p.userId]?.delta || 0 : 0;
      const after = before + delta;
      const ops = [
        prisma.mpResult.create({
          data: {
            userId: p.userId, ranked: room.ranked, placement, players: ordered.length,
            score: p.score, mmrBefore: room.ranked ? before : null, mmrAfter: room.ranked ? after : null,
          },
        }),
      ];
      if (room.ranked) {
        ops.push(prisma.user.update({
          where: { id: p.userId },
          data: { mmr: Math.max(100, after), rankedGames: { increment: 1 }, rankedWins: { increment: placement === 1 ? 1 : 0 } },
        }));
      }
      return ops;
    })
  );
  return deltaById;
}

async function endGame(room) {
  room.status = 'over';
  clearTimeout(room.timer);
  const ordered = [...room.players.values()]
    .map((p) => ({ userId: p.userId, name: p.name, avatarUrl: p.avatarUrl, score: p.score }))
    .sort((a, b) => b.score - a.score);

  let deltaById = {};
  try { deltaById = await persistResults(room, ordered); }
  catch (e) { console.error('mp persist error:', e.message); }

  const ranking = ordered.map((p, i) => ({
    name: p.name, avatarUrl: p.avatarUrl, score: p.score,
    mmrDelta: room.ranked ? deltaById[p.userId]?.delta ?? 0 : null,
  }));
  io.to(room.id).emit('mp:game:over', { ranked: room.ranked, ranking });

  if (room.isPublic) {
    setTimeout(() => closeRoom(room), 30000);
  } else {
    room.status = 'lobby';
    room.round = 0; room.current = null; room.usedSongIds = new Set();
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
    socket.emit('mp:game:start', { totalRounds: room.settings.rounds, ranked: room.ranked, players: playersPublic(room) });
    if (room.current) {
      const remaining = Math.max(1500, room.current.endsAt - Date.now());
      socket.emit('mp:round:start', {
        round: room.round, total: room.settings.rounds,
        clipUrl: `/api/mp/clip/${room.id}?r=${room.round}`, startAt: Date.now(),
        duration: remaining, resumed: true, alreadyAnswered: !!room.current.answers.get(uid)?.correct,
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

function getCurrentVideo(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || !room.players.has(userId)) return null;
  if (room.current) return room.current.song.videoUrl;
  if (room.revealSong && Date.now() < (room.revealUntil || 0)) return room.revealSong.videoUrl;
  return null;
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
    } catch { next(new Error('auth')); }
  });
  io.on('connection', (socket) => {
    reattach(socket); // restaure une partie en cours si l'utilisateur en avait une
    socket.on('mp:quick', () => joinPublic(socket, false));
    socket.on('mp:ranked', () => joinPublic(socket, true));
    socket.on('mp:create', (s) => createRoom(socket, s));
    socket.on('mp:join', (code) => joinByCode(socket, code));
    socket.on('mp:settings', (s) => setSettings(socket, s));
    socket.on('mp:start', () => hostStart(socket));
    socket.on('mp:leave', () => leaveRoom(socket));
    socket.on('mp:chat', (t) => chat(socket, t));
    socket.on('mp:emote', (e) => emote(socket, e));
    socket.on('mp:guess', (t) => onGuess(socket, String(t || '').slice(0, 120)));
    socket.on('disconnect', () => onDisconnect(socket));
  });
  return io;
}

module.exports = { initMp, getCurrentVideo };
