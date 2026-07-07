// Échange entre joueurs : propositions d'exemplaires précis (CardInstance) +
// éventuellement tokens/poussière, avec double validation et transfert atomique.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { notifyUser } = require('../mp/mp');
const { progressQuests } = require('../quests/quests');

const router = express.Router();

const MAX_ITEMS = 12; // garde-fou : nb max d'exemplaires par côté

// Recalcule l'agrégat UserCard.copies pour des couples (userId, characterId)
// à partir des CardInstance réels (source de vérité après transfert).
async function resyncUserCards(tx, pairs) {
  const seen = new Set();
  for (const { userId, characterId } of pairs) {
    const key = userId + ':' + characterId;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = await tx.cardInstance.count({ where: { userId, characterId } });
    if (count > 0) {
      await tx.userCard.upsert({
        where: { userId_characterId: { userId, characterId } },
        update: { copies: count },
        create: { userId, characterId, copies: count },
      });
    } else {
      await tx.userCard.deleteMany({ where: { userId, characterId } });
    }
  }
}

// Détail d'une liste d'instances (pour l'affichage des offres)
async function expandInstances(ids) {
  if (!ids || !ids.length) return [];
  const insts = await prisma.cardInstance.findMany({
    where: { id: { in: ids } },
    select: { id: true, serial: true, character: { select: { id: true, name: true, imageUrl: true, rarity: true } } },
  });
  return insts.map((i) => ({ id: i.id, serial: i.serial, characterId: i.character.id, name: i.character.name, imageUrl: i.character.imageUrl, rarity: i.character.rarity }));
}

// Exemplaires échangeables d'un joueur, groupés par personnage (pour le builder)
// Exclut les exemplaires en vente sur le marché (gelés tant que l'annonce est active).
router.get('/instances/:userId', requireAuth, async (req, res) => {
  const insts = await prisma.cardInstance.findMany({
    where: { userId: req.params.userId, listed: false },
    orderBy: [{ characterId: 'asc' }, { serial: 'asc' }],
    select: { id: true, serial: true, character: { select: { id: true, name: true, imageUrl: true, rarity: true } } },
  });
  const byChar = {};
  for (const i of insts) {
    const c = i.character;
    (byChar[c.id] ||= { characterId: c.id, name: c.name, imageUrl: c.imageUrl, rarity: c.rarity, serials: [] })
      .serials.push({ id: i.id, serial: i.serial });
  }
  res.json({ characters: Object.values(byChar) });
});

// Crée une proposition d'échange
router.post('/', requireAuth, async (req, res) => {
  const fromId = req.user.id;
  const { toUserId } = req.body || {};
  const offeredIds = [...new Set((req.body?.offeredIds || []).map(Number).filter(Boolean))];
  const requestedIds = [...new Set((req.body?.requestedIds || []).map(Number).filter(Boolean))];
  const offeredTokens = Math.max(0, parseInt(req.body?.offeredTokens) || 0);
  const requestedTokens = Math.max(0, parseInt(req.body?.requestedTokens) || 0);
  const offeredDust = Math.max(0, parseInt(req.body?.offeredDust) || 0);
  const requestedDust = Math.max(0, parseInt(req.body?.requestedDust) || 0);

  if (!toUserId || toUserId === fromId) return res.status(400).json({ error: 'Destinataire invalide' });
  if (offeredIds.length > MAX_ITEMS || requestedIds.length > MAX_ITEMS) return res.status(400).json({ error: `Max ${MAX_ITEMS} cartes par côté` });
  const totalItems = offeredIds.length + requestedIds.length + offeredTokens + requestedTokens + offeredDust + requestedDust;
  if (!totalItems) return res.status(400).json({ error: 'Proposition vide' });

  const target = await prisma.user.findUnique({ where: { id: toUserId }, select: { id: true } });
  if (!target) return res.status(404).json({ error: 'Joueur introuvable' });

  // Validation possession + devises (re-vérifiées à l'acceptation). Les
  // exemplaires en vente sur le marché sont gelés et ne peuvent pas être échangés.
  if (offeredIds.length) {
    const owned = await prisma.cardInstance.count({ where: { id: { in: offeredIds }, userId: fromId, listed: false } });
    if (owned !== offeredIds.length) return res.status(400).json({ error: 'Tu ne possèdes pas (plus) ces cartes (peut-être en vente sur le marché)' });
  }
  if (requestedIds.length) {
    const owned = await prisma.cardInstance.count({ where: { id: { in: requestedIds }, userId: toUserId, listed: false } });
    if (owned !== requestedIds.length) return res.status(400).json({ error: 'Le joueur ne possède pas (plus) ces cartes (peut-être en vente sur le marché)' });
  }
  if ((req.user.tokens || 0) < offeredTokens) return res.status(400).json({ error: 'Pas assez de tokens' });
  if ((req.user.dust || 0) < offeredDust) return res.status(400).json({ error: 'Pas assez de poussière' });

  const trade = await prisma.trade.create({
    data: { fromUserId: fromId, toUserId, offeredIds, requestedIds, offeredTokens, requestedTokens, offeredDust, requestedDust },
  });
  notifyUser(toUserId, 'trade:new', { from: req.user.displayName });
  res.json({ ok: true, id: trade.id });
});

// Mes échanges en attente (reçus + envoyés), avec détails
router.get('/list', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const trades = await prisma.trade.findMany({
    where: { status: 'pending', OR: [{ toUserId: uid }, { fromUserId: uid }] },
    orderBy: { createdAt: 'desc' },
    include: {
      from: { select: { id: true, displayName: true, avatarUrl: true } },
      to: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });
  const out = [];
  for (const t of trades) {
    out.push({
      id: t.id,
      direction: t.toUserId === uid ? 'incoming' : 'outgoing',
      from: t.from, to: t.to,
      offered: await expandInstances(t.offeredIds),
      requested: await expandInstances(t.requestedIds),
      offeredTokens: t.offeredTokens, requestedTokens: t.requestedTokens,
      offeredDust: t.offeredDust, requestedDust: t.requestedDust,
      createdAt: t.createdAt,
    });
  }
  res.json({ trades: out, incoming: out.filter((t) => t.direction === 'incoming').length });
});

// Historique : échanges résolus récents me concernant
router.get('/history', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const trades = await prisma.trade.findMany({
    where: { status: { in: ['accepted', 'declined', 'cancelled'] }, OR: [{ toUserId: uid }, { fromUserId: uid }] },
    orderBy: { resolvedAt: 'desc' },
    take: 20,
    include: { from: { select: { displayName: true } }, to: { select: { displayName: true } } },
  });
  res.json({
    trades: trades.map((t) => ({
      id: t.id, status: t.status,
      direction: t.toUserId === uid ? 'incoming' : 'outgoing',
      other: (t.toUserId === uid ? t.from : t.to).displayName,
      offeredCount: t.offeredIds.length, requestedCount: t.requestedIds.length,
      offeredTokens: t.offeredTokens, requestedTokens: t.requestedTokens,
      offeredDust: t.offeredDust, requestedDust: t.requestedDust,
      resolvedAt: t.resolvedAt,
    })),
  });
});

// Accepte un échange (destinataire uniquement) → transfert atomique
router.post('/:id/accept', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const uid = req.user.id;
  let otherUserId = null; // proposant, pour créditer sa quête « échange » aussi
  try {
    await prisma.$transaction(async (tx) => {
      const t = await tx.trade.findUnique({ where: { id } });
      otherUserId = t?.fromUserId || null;
      if (!t || t.status !== 'pending') throw new Error('Échange indisponible');
      if (t.toUserId !== uid) throw new Error('Réservé au destinataire');

      // Re-validation possession des deux côtés (et qu'aucun exemplaire n'a
      // été mis en vente sur le marché depuis la proposition)
      const offered = await tx.cardInstance.findMany({ where: { id: { in: t.offeredIds } }, select: { id: true, userId: true, characterId: true, listed: true } });
      const requested = await tx.cardInstance.findMany({ where: { id: { in: t.requestedIds } }, select: { id: true, userId: true, characterId: true, listed: true } });
      if (offered.length !== t.offeredIds.length || offered.some((i) => i.userId !== t.fromUserId || i.listed)) throw new Error('Le proposant ne possède plus ces cartes (peut-être en vente sur le marché)');
      if (requested.length !== t.requestedIds.length || requested.some((i) => i.userId !== t.toUserId || i.listed)) throw new Error('Tu ne possèdes plus ces cartes (peut-être en vente sur le marché)');

      // Devises
      const from = await tx.user.findUnique({ where: { id: t.fromUserId }, select: { tokens: true, dust: true } });
      const to = await tx.user.findUnique({ where: { id: t.toUserId }, select: { tokens: true, dust: true } });
      if (from.tokens < t.offeredTokens || from.dust < t.offeredDust) throw new Error('Le proposant n\'a plus les ressources');
      if (to.tokens < t.requestedTokens || to.dust < t.requestedDust) throw new Error('Tu n\'as pas les ressources demandées');

      // Transfert des exemplaires
      if (t.offeredIds.length) await tx.cardInstance.updateMany({ where: { id: { in: t.offeredIds } }, data: { userId: t.toUserId } });
      if (t.requestedIds.length) await tx.cardInstance.updateMany({ where: { id: { in: t.requestedIds } }, data: { userId: t.fromUserId } });

      // Devises (from cède offered, reçoit requested ; to l'inverse)
      await tx.user.update({ where: { id: t.fromUserId }, data: { tokens: { increment: t.requestedTokens - t.offeredTokens }, dust: { increment: t.requestedDust - t.offeredDust } } });
      await tx.user.update({ where: { id: t.toUserId }, data: { tokens: { increment: t.offeredTokens - t.requestedTokens }, dust: { increment: t.offeredDust - t.requestedDust } } });

      // Resync des agrégats UserCard pour tous les couples touchés
      const pairs = [];
      for (const i of offered) { pairs.push({ userId: t.fromUserId, characterId: i.characterId }, { userId: t.toUserId, characterId: i.characterId }); }
      for (const i of requested) { pairs.push({ userId: t.toUserId, characterId: i.characterId }, { userId: t.fromUserId, characterId: i.characterId }); }
      await resyncUserCards(tx, pairs);

      await tx.trade.update({ where: { id }, data: { status: 'accepted', resolvedAt: new Date() } });
      notifyUser(t.fromUserId, 'trade:accepted', { by: req.user.displayName });
    });
    // Quête « Réalise un échange » pour les deux joueurs (l'échange est conclu).
    progressQuests(uid, 'trade', 1);
    if (otherUserId) progressQuests(otherUserId, 'trade', 1);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Refuse (destinataire) ou annule (proposant)
router.post('/:id/decline', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const t = await prisma.trade.findUnique({ where: { id } });
  if (!t || t.status !== 'pending') return res.status(400).json({ error: 'Échange indisponible' });
  if (t.toUserId !== req.user.id && t.fromUserId !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  const status = t.fromUserId === req.user.id ? 'cancelled' : 'declined';
  await prisma.trade.update({ where: { id }, data: { status, resolvedAt: new Date() } });
  res.json({ ok: true, status });
});

module.exports = { router };
