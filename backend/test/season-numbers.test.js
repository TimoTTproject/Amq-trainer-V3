// Numérotation des saisons (computeSeasonNumbers) : seuls TV/TV_SHORT/ONA
// portent un numéro ; OAV/films/spéciaux sont des maillons passants qui
// relient la chaîne sans décaler la numérotation (bug Vinland Saga : l'OAV
// entre S1 et S2 s'affichait « S2 » et transformait la vraie S2 en « S3 »).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma } = require('./helpers/api');

fakePrisma(); // catalog.service require('../db')

// Faux anilist.service injecté dans le cache require AVANT catalog.service :
// `graph` décrit les chaînes PREQUEL/SEQUEL simulées (même principe que le
// faux prisma de helpers/api).
const graph = new Map(); // id -> { format, edges: [{ relationType, node }] }
const ANILIST_PATH = require.resolve('../src/anilist/anilist.service.js');
require.cache[ANILIST_PATH] = {
  id: ANILIST_PATH,
  filename: ANILIST_PATH,
  loaded: true,
  exports: {
    getAnimeRelationsByIds: async (ids) =>
      ids.filter((id) => graph.has(id)).map((id) => ({
        id,
        format: graph.get(id).format,
        relations: { edges: graph.get(id).edges },
      })),
  },
};
const { computeSeasonNumbers } = require('../src/catalog/catalog.service');

// Déclare une chaîne ordonnée : chaque élément pointe son voisin précédent
// (PREQUEL) et suivant (SEQUEL), comme les données AniList réelles.
function chain(nodes) {
  nodes.forEach(({ id, format }, i) => {
    const edges = [];
    if (i > 0) edges.push({ relationType: 'PREQUEL', node: { id: nodes[i - 1].id, type: 'ANIME', format: nodes[i - 1].format } });
    if (i < nodes.length - 1) edges.push({ relationType: 'SEQUEL', node: { id: nodes[i + 1].id, type: 'ANIME', format: nodes[i + 1].format } });
    graph.set(id, { format, edges });
  });
}

test('chaîne TV simple : S1 puis S2', async () => {
  chain([{ id: 11, format: 'TV' }, { id: 12, format: 'TV' }]);
  const r = await computeSeasonNumbers([11, 12]);
  assert.equal(r.get(11), 1);
  assert.equal(r.get(12), 2);
});

test('OAV entre deux saisons : passant, ne décale pas la numérotation', async () => {
  chain([{ id: 21, format: 'TV' }, { id: 22, format: 'OVA' }, { id: 23, format: 'TV' }]);
  const r = await computeSeasonNumbers([21, 22, 23]);
  assert.equal(r.get(21), 1, 'saison 1');
  assert.equal(r.get(22), 0, "l'OAV n'affiche pas de S#");
  assert.equal(r.get(23), 2, 'la vraie saison 2 reste S2 (pas S3)');
});

test('film récapitulatif dans la chaîne : passant aussi', async () => {
  chain([{ id: 31, format: 'TV' }, { id: 32, format: 'MOVIE' }, { id: 33, format: 'TV' }]);
  const r = await computeSeasonNumbers([31, 33]);
  assert.equal(r.get(31), 1);
  assert.equal(r.get(33), 2);
});

test('TV + OAV seulement : aucune vraie « chaîne », aucun préfixe', async () => {
  chain([{ id: 41, format: 'TV' }, { id: 42, format: 'OVA' }]);
  const r = await computeSeasonNumbers([41, 42]);
  assert.equal(r.get(41), 0);
  assert.equal(r.get(42), 0);
});

test('anime isolé : pas de préfixe', async () => {
  graph.set(51, { format: 'TV', edges: [] });
  const r = await computeSeasonNumbers([51]);
  assert.equal(r.get(51), 0);
});

test('les ONA comptent comme des saisons (œuvres web/Netflix)', async () => {
  chain([{ id: 61, format: 'ONA' }, { id: 62, format: 'ONA' }]);
  const r = await computeSeasonNumbers([61, 62]);
  assert.equal(r.get(61), 1);
  assert.equal(r.get(62), 2);
});

test('la frontière remonte la chaîne depuis un seul seed', async () => {
  chain([{ id: 71, format: 'TV' }, { id: 72, format: 'OVA' }, { id: 73, format: 'TV' }]);
  // Seul l'id de la saison 2 est fourni : le graphe doit remonter jusqu'à la
  // racine via PREQUEL pour la numéroter correctement.
  const r = await computeSeasonNumbers([73]);
  assert.equal(r.get(73), 2);
});
