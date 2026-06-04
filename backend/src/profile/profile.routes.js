// Routes de profil : modification du pseudo, bio et photo
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { publicUser } = require('../auth/auth.routes');

const router = express.Router();

const MAX_AVATAR_BYTES = 700 * 1024; // ~700 Ko (l'avatar est redimensionné côté client)

// Valide une data URL d'image (data:image/...;base64,....)
function isValidAvatar(value) {
  if (typeof value !== 'string') return false;
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(value)) return false;
  // Taille approximative des octets décodés à partir du base64
  const base64 = value.split(',')[1] || '';
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes <= MAX_AVATAR_BYTES;
}

// Met à jour le profil de l'utilisateur connecté
router.patch('/', requireAuth, async (req, res) => {
  const { displayName, bio, avatar } = req.body || {};
  const data = {};

  if (displayName !== undefined) {
    const name = String(displayName).trim();
    if (name.length < 2 || name.length > 30) {
      return res.status(400).json({ error: 'Le pseudo doit faire entre 2 et 30 caractères' });
    }
    data.displayName = name;
  }

  if (bio !== undefined) {
    const text = String(bio).trim();
    if (text.length > 300) {
      return res.status(400).json({ error: 'La bio est limitée à 300 caractères' });
    }
    data.bio = text || null;
  }

  if (avatar !== undefined) {
    if (avatar === null || avatar === '') {
      data.avatarUrl = null; // suppression de la photo
    } else if (isValidAvatar(avatar)) {
      data.avatarUrl = avatar;
    } else {
      return res.status(400).json({ error: 'Image invalide ou trop lourde (max ~700 Ko)' });
    }
  }

  if (!Object.keys(data).length) {
    return res.status(400).json({ error: 'Rien à mettre à jour' });
  }

  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  res.json({ user: publicUser(user) });
});

const RARITY_RANK = { mythic: 4, legendary: 3, epic: 2, rare: 1, common: 0 };

// Profil public d'un joueur (consultable depuis le classement)
router.get('/:userId', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { id: true, displayName: true, avatarUrl: true, bio: true, createdAt: true, tokens: true, towerBestFloor: true },
  });
  if (!user) return res.status(404).json({ error: 'Joueur introuvable' });

  const stats = await prisma.userSongStat.findMany({
    where: { userId: user.id },
    select: { playCount: true, correctCount: true },
  });
  const played = stats.reduce((s, x) => s + x.playCount, 0);
  const correct = stats.reduce((s, x) => s + x.correctCount, 0);

  const cardsCount = await prisma.userCard.count({ where: { userId: user.id } });
  const cards = await prisma.userCard.findMany({
    where: { userId: user.id },
    include: { character: true },
  });
  cards.sort(
    (a, b) =>
      RARITY_RANK[b.character.rarity] - RARITY_RANK[a.character.rarity] ||
      (b.character.favourites || 0) - (a.character.favourites || 0)
  );
  const best = cards[0]?.character || null;

  res.json({
    user,
    stats: { played, correct, rate: played ? Math.round((correct / played) * 100) : 0 },
    cardsCount,
    bestCard: best ? { id: best.id, name: best.name, imageUrl: best.imageUrl, rarity: best.rarity } : null,
  });
});

module.exports = { router };
