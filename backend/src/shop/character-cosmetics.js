// Cosmétiques « personnages » : générés depuis la base de personnages du gacha.
// Pour chaque perso principal (top par popularité au sein de sa série), on crée
// 2 cosmétiques achetables en tokens — un dos de carte et une bannière de profil
// utilisant son artwork AniList. Le catalogue est chargé en mémoire (rafraîchi
// périodiquement) pour rester volumineux sans requête BDD à chaque accès, et
// branché dans cosmetics.byId() via un résolveur dynamique.
const { prisma } = require('../db');
const cosmetics = require('./cosmetics');

const TOP_PER_SERIES = 8; // nb de têtes d'affiche retenues par série
const PAGE_SIZE = 24;
const REFRESH_MS = 30 * 60 * 1000; // rafraîchit le catalogue toutes les 30 min
// Prix par rareté (plus le perso est rare/populaire, plus c'est cher)
const PRICE = { common: 250, rare: 500, epic: 900, legendary: 1500, mythic: 2500 };

let cache = { byId: new Map(), list: [], series: [], builtAt: 0 };
let building = null;

// 2 cosmétiques (dos + bannière) pour un personnage. L'artwork AniList est un
// portrait : bien adapté au format carte (cardBack), mais un simple
// `center/cover` sur le format large de la bannière de profil zoome sur le
// milieu du corps et coupe le visage. On biaise le recadrage vers le haut
// pour la bannière (même technique que LICENSE_CHARACTER_ART dans cosmetics.js).
function cosmeticsForChar(ch) {
  const price = PRICE[ch.rarity] || 500;
  const cardBg = `background:#0c0e12 url('${ch.imageUrl}') center/cover`;
  const bannerBg = `background:#0c0e12 url('${ch.imageUrl}') center 12%/cover`;
  const common = {
    image: true, charId: ch.id, charName: ch.name, charSeries: ch.series,
    charRarity: ch.rarity, charFav: ch.favourites || 0,
  };
  return [
    { ...common, id: `char:${ch.id}:cardBack`, slot: 'cardBack', name: `${ch.name} — Dos`, price, css: cardBg },
    { ...common, id: `char:${ch.id}:profileBanner`, slot: 'profileBanner', name: `${ch.name} — Bannière`, price, css: bannerBg },
  ];
}

async function refresh() {
  const chars = await prisma.character.findMany({
    where: { imageUrl: { not: null }, series: { not: null } },
    select: { id: true, name: true, imageUrl: true, series: true, rarity: true, favourites: true },
    orderBy: { favourites: 'desc' },
  });
  // Top N par série (la liste est déjà triée par popularité décroissante).
  const perSeries = new Map();
  for (const ch of chars) {
    const arr = perSeries.get(ch.series) || [];
    if (arr.length < TOP_PER_SERIES) { arr.push(ch); perSeries.set(ch.series, arr); }
  }
  const byId = new Map();
  const list = [];
  for (const arr of perSeries.values()) {
    for (const ch of arr) {
      for (const cos of cosmeticsForChar(ch)) { byId.set(cos.id, cos); list.push(cos); }
    }
  }
  // Tri d'affichage : série, puis popularité, puis dos avant bannière.
  list.sort((a, b) =>
    a.charSeries.localeCompare(b.charSeries) || b.charFav - a.charFav || a.slot.localeCompare(b.slot)
  );
  const series = [...perSeries.keys()].sort((a, b) => a.localeCompare(b));
  cache = { byId, list, series, builtAt: Date.now() };
  return cache;
}

// Garantit un cache à jour (déduplique les rafraîchissements concurrents).
function ensureFresh() {
  if (cache.builtAt && Date.now() - cache.builtAt < REFRESH_MS) return Promise.resolve(cache);
  if (!building) {
    building = refresh()
      .catch((e) => { console.error('character-cosmetics refresh:', e.message); return cache; })
      .finally(() => { building = null; });
  }
  return building;
}

function get(id) {
  return cache.byId.get(id) || null;
}

// Filtre (série + recherche par nom) puis pagine.
function query({ series, q, page }) {
  let items = cache.list;
  if (series) items = items.filter((c) => c.charSeries === series);
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter((c) => c.charName.toLowerCase().includes(needle));
  }
  const total = items.length;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_SIZE;
  return { items: items.slice(start, start + PAGE_SIZE), total, page: p, pageSize: PAGE_SIZE, series: cache.series };
}

// Branche le résolveur dynamique + chauffe le cache au démarrage (non bloquant).
cosmetics.registerDynamicResolver(get);
if (process.env.SKIP_BACKGROUND_REFRESH !== 'true') ensureFresh();

module.exports = { ensureFresh, get, query, PAGE_SIZE };
