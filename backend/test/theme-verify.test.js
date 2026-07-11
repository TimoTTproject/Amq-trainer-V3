// verifyThemesBatch : détection/réparation des thèmes importés sous le MAUVAIS
// anime par l'ancienne recherche floue (ex. les OP de MHA saison 1 catalogués
// sous l'anilistId de la saison 6 → l'OP1 se révélait « saison 6 »).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma } = require('./helpers/api');

const prisma = fakePrisma();
const { verifyThemesBatch } = require('../src/catalog/catalog.service');

// Fiche animethemes simulée de « MHA saison 6 » (anilistId 100) : ses VRAIS
// thèmes. La réponse suit le format de /resources?filter[site]=AniList.
function theme(type, sequence, title) {
  return {
    type, sequence,
    song: { title, artists: [{ name: 'Artiste' }] },
    animethemeentries: [{ videos: [{ link: `https://v/${title.replace(/\s+/g, '-')}.webm`, basename: 'x', overlap: 'None' }] }],
  };
}
const FICHE = {
  resources: [{
    anime: [{
      id: 1, name: 'Boku no Hero Academia 6th Season',
      animethemes: [theme('OP', 1, 'Hitamuki'), theme('OP', 2, 'Bokurano'), theme('ED', 1, 'SKETCH')],
    }],
  }],
};

// Catalogue stocké sous l'anilistId 100 : OP1 croisé (thème de la S1), OP2
// conforme, ED9 étranger à la fiche.
const stored = [
  { id: 11, anilistId: 100, animeTitle: 'Boku No Hero Academia 6', type: 'OP', number: 1, title: 'The Day', artist: 'Porno Graffitti', videoUrl: 'https://v/the-day.webm', audioUrl: 'https://r2/the-day.ogg' },
  { id: 12, anilistId: 100, animeTitle: 'Boku No Hero Academia 6', type: 'OP', number: 2, title: 'Bokurano', artist: 'Eve', videoUrl: 'https://v/bokurano.webm', audioUrl: null },
  { id: 13, anilistId: 100, animeTitle: 'Boku No Hero Academia 6', type: 'ED', number: 9, title: 'Chanson Etrangere', artist: '?', videoUrl: 'https://v/etrangere.webm', audioUrl: null },
];

function stubDb() {
  prisma.song.findMany = async (args) => {
    if (args?.distinct) return [{ anilistId: 100 }]; // curseur : un seul anime
    return stored.map((s) => ({ ...s }));
  };
}

test('verifyThemesBatch : audit (fix=false) repère le thème croisé et l\'étranger, sans toucher la base', async (t) => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => FICHE });
  t.after(() => { delete global.fetch; });
  stubDb();
  prisma.song.update = async () => { throw new Error('update interdit en audit'); };
  prisma.song.delete = async () => { throw new Error('delete interdit en audit'); };

  const r = await verifyThemesBatch({ cursor: 0, limit: 10, fix: false });
  assert.equal(r.processed, 1);
  assert.equal(r.fixed, 0);
  assert.equal(r.deleted, 0);
  assert.equal(r.mismatches.length, 2);
  const byId = new Map(r.mismatches.map((m) => [m.songId, m]));
  // OP1 « The Day » n'est pas sur la fiche → remplacé par le vrai OP1 (même position).
  assert.equal(byId.get(11).action, 'update');
  assert.match(byId.get(11).real, /Hitamuki/);
  // ED9 inconnu de la fiche → suppression proposée.
  assert.equal(byId.get(13).action, 'delete');
  // OP2 conforme : jamais listé.
  assert.equal(byId.has(12), false);
});

test('verifyThemesBatch : fix=true remplace le thème croisé (audioUrl invalidé) et supprime l\'étranger', async (t) => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => FICHE });
  t.after(() => { delete global.fetch; });
  stubDb();
  const updates = [];
  const deletes = [];
  prisma.song.update = async ({ where, data }) => { updates.push({ where, data }); return {}; };
  prisma.song.delete = async ({ where }) => { deletes.push(where); return {}; };

  const r = await verifyThemesBatch({ cursor: 0, limit: 10, fix: true });
  assert.equal(r.fixed, 1);
  assert.equal(r.deleted, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, 11);
  assert.equal(updates[0].data.title, 'Hitamuki');
  assert.equal(updates[0].data.audioUrl, null); // miroir R2 de l'ancienne vidéo invalidé
  assert.deepEqual(deletes, [{ id: 13 }]);
});

test('verifyThemesBatch : fiche introuvable ou vide = invérifiable, aucune action, anime listé', async (t) => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ resources: [] }) });
  t.after(() => { delete global.fetch; });
  stubDb();
  prisma.song.update = async () => { throw new Error('update interdit sans fiche'); };
  prisma.song.delete = async () => { throw new Error('delete interdit sans fiche'); };

  const r = await verifyThemesBatch({ cursor: 0, limit: 10, fix: true });
  assert.equal(r.unverifiable, 1);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.fixed + r.deleted, 0);
  // L'anime est remonté à l'admin pour inspection manuelle.
  assert.deepEqual(r.unverifiableList, [{ anilistId: 100, anime: 'Boku No Hero Academia 6' }]);
});

test('verifyThemesBatch : anime PAS ENCORE DIFFUSÉ sans fiche = corruption, purge + verrou levé', async (t) => {
  // Cas « THE ONE PIECE » (prévu 2027) : les openings du vrai One Piece ont été
  // collés dessus par l'ancienne recherche floue. Pas de fiche animethemes →
  // mais un anime futur ne peut avoir AUCUN thème : tout est supprimé et le
  // verrou d'exploration levé (ré-import propre à sa sortie).
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ resources: [] }) });
  t.after(() => { delete global.fetch; });
  const future = new Date().getFullYear() + 1;
  prisma.song.findMany = async (args) => {
    if (args?.distinct) return [{ anilistId: 171630 }];
    return [
      { id: 31, anilistId: 171630, animeTitle: 'THE ONE PIECE', type: 'OP', number: 1, title: 'We Are!', artist: 'Hiroshi Kitadani', videoUrl: 'https://v/weare.webm', audioUrl: null, seasonYear: future },
      { id: 32, anilistId: 171630, animeTitle: 'THE ONE PIECE', type: 'OP', number: 2, title: 'Believe', artist: 'Folder5', videoUrl: 'https://v/believe.webm', audioUrl: null, seasonYear: future },
    ];
  };
  const deletes = [];
  let scannedCleared = false;
  prisma.song.delete = async ({ where }) => { deletes.push(where.id); return {}; };
  prisma.scannedAnime = prisma.scannedAnime || {};
  prisma.scannedAnime.deleteMany = async ({ where }) => { scannedCleared = where.anilistId === 171630; return { count: 1 }; };

  const r = await verifyThemesBatch({ cursor: 0, limit: 10, fix: true });
  assert.equal(r.deleted, 2);
  assert.deepEqual(deletes, [31, 32]);
  assert.equal(scannedCleared, true, "verrou d'exploration levé");
  assert.equal(r.unverifiable, 0); // classé corruption, pas invérifiable
  assert.equal(r.mismatches.length, 2);
  assert.match(r.mismatches[0].real, /2027|prévue/);
});

test('verifyThemesBatch : un titre présent sous un autre numéro n\'est pas touché (dérive de numérotation)', async (t) => {
  // La fiche liste « SKETCH » en ED1 ; le catalogue l'a en ED2 → on ne touche pas.
  global.fetch = async () => ({ ok: true, status: 200, json: async () => FICHE });
  t.after(() => { delete global.fetch; });
  prisma.song.findMany = async (args) => {
    if (args?.distinct) return [{ anilistId: 100 }];
    return [{ id: 21, anilistId: 100, animeTitle: 'BNHA 6', type: 'ED', number: 2, title: 'SKETCH', artist: '?', videoUrl: 'https://v/sketch.webm', audioUrl: null }];
  };
  prisma.song.update = async () => { throw new Error('update interdit'); };
  prisma.song.delete = async () => { throw new Error('delete interdit'); };

  const r = await verifyThemesBatch({ cursor: 0, limit: 10, fix: true });
  assert.equal(r.mismatches.length, 0);
});
