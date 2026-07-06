// Marché des joueurs : vente d'exemplaires précis (CardInstance) contre des
// tokens. Une annonce gèle l'exemplaire (`listed`) — il ne peut plus être
// fusionné, ascensionné ou échangé tant que l'annonce est active.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { notifyUser } = require('../mp/mp');

const router = express.Router();

const MAX_PRICE = 999999;
const VALID_RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];

// Parcours des annonces actives : filtre rareté/recherche, tri, pagination
router.get('/', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 30;
  const q = (req.query.search || '').trim();
  const rarity = VALID_RARITIES.includes(req.query.rarity) ? req.query.rarity : null;
  const sort = req.query.sort === 'price_desc' ? 'price_desc' : req.query.sort === 'recent' ? 'recent' : 'price_asc';

  const where = {
    status: 'active',
    ...(rarity ? { character: { rarity } } : {}),
    ...(q ? { character: { name: { contains: q, mode: 'insensitive' } } } : {}),
  };
  const orderBy = sort === 'price_desc' ? { price: 'desc' } : sort === 'recent' ? { createdAt: 'desc' } : { price: 'asc' };

  const total = await prisma.marketListing.count({ where });
  const listings = await prisma.marketListing.findMany({
    where,
    orderBy,
    skip: (page - 1) * perPage,
    take: perPage,
    include: {
      character: { select: { id: true, name: true, imageUrl: true, rarity: true, series: true } },
      cardInstance: { select: { serial: true } },
      seller: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });
  res.json({
    page,
    pages: Math.max(1, Math.ceil(total / perPage)),
    total,
    listings: listings.map((l) => ({
      id: l.id,
      price: l.price,
      createdAt: l.createdAt,
      serial: l.cardInstance.serial,
      character: l.character,
      seller: l.seller,
      mine: l.sellerId === req.user.id,
    })),
  });
});

// Mes annonces actives + historique récent (ventes conclues / achats / annulations)
router.get('/mine', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const active = await prisma.marketListing.findMany({
    where: { sellerId: uid, status: 'active' },
    orderBy: { createdAt: 'desc' },
    include: {
      character: { select: { id: true, name: true, imageUrl: true, rarity: true } },
      cardInstance: { select: { serial: true } },
    },
  });
  const history = await prisma.marketListing.findMany({
    where: { status: { in: ['sold', 'cancelled'] }, OR: [{ sellerId: uid }, { buyerId: uid }] },
    orderBy: { resolvedAt: 'desc' },
    take: 20,
    include: {
      character: { select: { name: true } },
      cardInstance: { select: { serial: true } },
      seller: { select: { displayName: true } },
      buyer: { select: { displayName: true } },
    },
  });
  res.json({
    active: active.map((l) => ({
      id: l.id, price: l.price, serial: l.cardInstance.serial, character: l.character, createdAt: l.createdAt,
    })),
    history: history.map((l) => ({
      id: l.id,
      status: l.status,
      price: l.price,
      serial: l.cardInstance.serial,
      characterName: l.character.name,
      direction: l.sellerId === uid ? 'sold' : 'bought',
      other: l.sellerId === uid ? (l.buyer ? l.buyer.displayName : null) : l.seller.displayName,
      resolvedAt: l.resolvedAt,
    })),
  });
});

// Met un exemplaire possédé en vente
router.post('/list', requireAuth, async (req, res) => {
  const cardInstanceId = parseInt(req.body?.cardInstanceId);
  const price = parseInt(req.body?.price);
  if (!cardInstanceId) return res.status(400).json({ error: 'Carte invalide' });
  if (!(price > 0) || price > MAX_PRICE) return res.status(400).json({ error: `Prix invalide (1 à ${MAX_PRICE} tokens)` });

  const inst = await prisma.cardInstance.findUnique({ where: { id: cardInstanceId } });
  if (!inst || inst.userId !== req.user.id) return res.status(404).json({ error: 'Tu ne possèdes pas cet exemplaire' });
  if (inst.listed) return res.status(400).json({ error: 'Cet exemplaire est déjà en vente' });

  const listing = await prisma.$transaction(async (tx) => {
    await tx.cardInstance.update({ where: { id: cardInstanceId }, data: { listed: true } });
    return tx.marketListing.create({
      data: { sellerId: req.user.id, cardInstanceId, characterId: inst.characterId, price },
    });
  });
  res.json({ ok: true, id: listing.id });
});

// Annule une annonce (vendeur uniquement) : libère l'exemplaire
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const listing = await prisma.marketListing.findUnique({ where: { id } });
  if (!listing || listing.status !== 'active') return res.status(400).json({ error: 'Annonce indisponible' });
  if (listing.sellerId !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  await prisma.$transaction([
    prisma.cardInstance.update({ where: { id: listing.cardInstanceId }, data: { listed: false } }),
    prisma.marketListing.update({ where: { id }, data: { status: 'cancelled', resolvedAt: new Date() } }),
  ]);
  res.json({ ok: true });
});

// Achète une carte en vente : transfert atomique de l'exemplaire + tokens
router.post('/:id/buy', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const uid = req.user.id;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const listing = await tx.marketListing.findUnique({ where: { id } });
      if (!listing || listing.status !== 'active') throw new Error('Annonce indisponible');
      if (listing.sellerId === uid) throw new Error('Tu ne peux pas acheter ta propre annonce');
      const inst = await tx.cardInstance.findUnique({ where: { id: listing.cardInstanceId } });
      if (!inst || inst.userId !== listing.sellerId || !inst.listed) throw new Error('Cet exemplaire n’est plus disponible');
      const buyer = await tx.user.findUnique({ where: { id: uid }, select: { tokens: true } });
      if (buyer.tokens < listing.price) throw new Error('Pas assez de tokens');

      await tx.cardInstance.update({ where: { id: inst.id }, data: { userId: uid, listed: false } });
      await tx.user.update({ where: { id: uid }, data: { tokens: { decrement: listing.price } } });
      await tx.user.update({ where: { id: listing.sellerId }, data: { tokens: { increment: listing.price } } });
      await tx.tokenTransaction.create({ data: { userId: uid, amount: -listing.price, reason: 'market_buy' } });
      await tx.tokenTransaction.create({ data: { userId: listing.sellerId, amount: listing.price, reason: 'market_sell' } });

      // Resync des agrégats UserCard des deux côtés (source de vérité = CardInstance)
      const sellerCount = await tx.cardInstance.count({ where: { userId: listing.sellerId, characterId: inst.characterId } });
      if (sellerCount > 0) {
        await tx.userCard.update({
          where: { userId_characterId: { userId: listing.sellerId, characterId: inst.characterId } },
          data: { copies: sellerCount },
        });
      } else {
        await tx.userCard.deleteMany({ where: { userId: listing.sellerId, characterId: inst.characterId } });
      }
      const buyerCount = await tx.cardInstance.count({ where: { userId: uid, characterId: inst.characterId } });
      await tx.userCard.upsert({
        where: { userId_characterId: { userId: uid, characterId: inst.characterId } },
        update: { copies: buyerCount },
        create: { userId: uid, characterId: inst.characterId, copies: buyerCount },
      });

      await tx.marketListing.update({ where: { id }, data: { status: 'sold', buyerId: uid, resolvedAt: new Date() } });
      return { price: listing.price, sellerId: listing.sellerId };
    });
    notifyUser(result.sellerId, 'market:sold', { by: req.user.displayName, price: result.price });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = { router };
