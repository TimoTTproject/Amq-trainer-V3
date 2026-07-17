// Désignation des comptes admin (pour les tests).
// Par défaut : email du propriétaire, surchargeable via ADMIN_EMAILS (séparés par virgule).
const DEFAULT_ADMINS = ['melfisk6@gmail.com'];

const ADMIN_EMAILS = new Set(
  [...DEFAULT_ADMINS, ...(process.env.ADMIN_EMAILS || '').split(',')]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
const IDLE_BETA_ROLE = 'idle_beta';

function isAdmin(user) {
  return !!(user && user.email && ADMIN_EMAILS.has(user.email.toLowerCase()));
}

// Middleware : réserve une route aux admins (à placer après requireAuth)
function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Réservé aux administrateurs' });
  next();
}

function hasRole(user, role) {
  return !!(user && Array.isArray(user.roles) && user.roles.includes(role));
}

// Accès restreint aux admins et aux bêta-testeurs (idle_beta) : la sortie
// publique du 2026-07-17 a été annulée en urgence suite à un bug de
// progression bloquée après Prestige (retour joueur du même jour).
function canAccessIdle(user) {
  return isAdmin(user) || hasRole(user, IDLE_BETA_ROLE);
}

// Accès au jeu bêta uniquement : ce middleware ne donne aucun privilège admin.
function requireIdleBeta(req, res, next) {
  if (!canAccessIdle(req.user)) return res.status(403).json({ error: 'Anime Ascension est réservé aux bêta-testeurs' });
  next();
}

// Suppression d'un compte, PARTAGÉE entre la route admin et l'auto-suppression
// (RGPD). Cascade totale via les relations Prisma (onDelete: Cascade) — mais on
// rend d'abord au stock les exemplaires de cartes possédés (CardInstance), pour
// ne pas fausser les compteurs de rareté dynamique (minted/soldOut).
async function deleteUserCascade(prisma, userId) {
  const instances = await prisma.cardInstance.groupBy({
    by: ['characterId'], where: { userId }, _count: { _all: true },
  });
  await prisma.$transaction([
    ...instances.map((row) =>
      prisma.character.update({
        where: { id: row.characterId },
        data: { minted: { decrement: row._count._all }, soldOut: false },
      })
    ),
    prisma.user.delete({ where: { id: userId } }),
  ]);
}

module.exports = { IDLE_BETA_ROLE, isAdmin, hasRole, canAccessIdle, requireAdmin, requireIdleBeta, deleteUserCascade };
