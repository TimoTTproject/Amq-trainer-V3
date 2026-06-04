// Routes admin (outils de test). Réservées aux comptes admin.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { requireAdmin } = require('./admin');
const { getCharacterMedia, seriesOfCharacter } = require('../anilist/anilist.service');

const router = express.Router();
const VALID_RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];

// Crédite des tokens au compte courant (test gacha / achats)
router.post('/tokens', requireAuth, requireAdmin, async (req, res) => {
  const amount = Math.max(1, Math.min(100000, parseInt(req.body?.amount) || 1000));
  const userId = req.user.id;
  const u = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: { tokens: { increment: amount } } });
    await tx.tokenTransaction.create({ data: { userId, amount, reason: 'admin_grant' } });
    return user;
  });
  res.json({ granted: amount, tokens: u.tokens });
});

// Liste des personnages (gestion des raretés) : recherche + filtre + pagination
router.get('/characters', requireAuth, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 50;
  const q = (req.query.search || '').trim();
  const rarity = VALID_RARITIES.includes(req.query.rarity) ? req.query.rarity : null;

  const where = {};
  if (rarity) where.rarity = rarity;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { series: { contains: q, mode: 'insensitive' } },
    ];
  }
  const [total, characters, missingSeries] = await Promise.all([
    prisma.character.count({ where }),
    prisma.character.findMany({
      where,
      orderBy: [{ favourites: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, name: true, imageUrl: true, rarity: true, series: true, favourites: true },
    }),
    prisma.character.count({ where: { series: null } }),
  ]);
  res.json({ characters, total, page, pages: Math.ceil(total / perPage), rarities: VALID_RARITIES, missingSeries });
});

// Modifie la rareté d'un personnage
router.patch('/characters/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const rarity = req.body?.rarity;
  if (!VALID_RARITIES.includes(rarity)) return res.status(400).json({ error: 'Rareté invalide' });
  try {
    const c = await prisma.character.update({ where: { id }, data: { rarity } });
    res.json({ id: c.id, rarity: c.rarity });
  } catch {
    res.status(404).json({ error: 'Personnage introuvable' });
  }
});

// Remplit « series » par lots (déclenché côté serveur, qui a accès à la prod + AniList).
// Appeler en boucle jusqu'à remaining === 0.
router.post('/backfill-series', requireAuth, requireAdmin, async (req, res) => {
  const batch = await prisma.character.findMany({
    where: { series: null },
    take: 50,
    select: { id: true, anilistId: true },
  });
  if (!batch.length) return res.json({ processed: 0, remaining: 0 });

  try {
    const media = await getCharacterMedia(batch.map((c) => c.anilistId));
    const byAnilist = Object.fromEntries(media.map((m) => [m.id, m]));
    let processed = 0;
    for (const c of batch) {
      const { series, seriesId } = seriesOfCharacter(byAnilist[c.anilistId]);
      // Marque traité même sans média trouvé (chaîne vide) pour ne pas boucler dessus
      await prisma.character.update({
        where: { id: c.id },
        data: { series: series || '—', seriesId: seriesId || null },
      });
      processed++;
    }
    const remaining = await prisma.character.count({ where: { series: null } });
    res.json({ processed, remaining });
  } catch (e) {
    res.status(502).json({ error: 'AniList indisponible : ' + e.message });
  }
});

module.exports = { router };
