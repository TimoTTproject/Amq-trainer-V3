// Import animethemes : ne garder que les OP/ED « propres » (pas d'insert songs,
// versions non-spoiler d'abord, extrait sans dialogues par-dessus si dispo).
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractThemes } = require('../src/catalog/catalog.service');

const song = (title) => ({ title, artists: [{ name: 'Artiste' }] });
const video = (link, overlap = 'None') => ({ link, basename: link.split('/').pop(), overlap });

test('ignore tout ce qui n\'est pas OP/ED (jamais d\'insert songs)', () => {
  const themes = extractThemes({
    animethemes: [
      { type: 'IN', sequence: 1, song: song('Insert Song'), animethemeentries: [{ videos: [video('https://v/x1.webm')] }] },
      { type: 'OP', sequence: 1, song: song('Vrai Opening'), animethemeentries: [{ videos: [video('https://v/op1.webm')] }] },
    ],
  });
  assert.equal(themes.length, 1);
  assert.equal(themes[0].title, 'Vrai Opening');
  assert.equal(themes[0].type, 'OP');
});

test('préfère la version NON-spoiler d\'un même thème', () => {
  const themes = extractThemes({
    animethemes: [{
      type: 'OP', sequence: 1, song: song('Opening'),
      animethemeentries: [
        { spoiler: true, videos: [video('https://v/spoiler.webm')] },
        { spoiler: false, videos: [video('https://v/clean.webm')] },
      ],
    }],
  });
  assert.equal(themes[0].videoUrl, 'https://v/clean.webm');
});

test('préfère un extrait sans dialogues par-dessus (overlap None)', () => {
  const themes = extractThemes({
    animethemes: [{
      type: 'ED', sequence: 2, song: song('Ending'),
      animethemeentries: [{
        videos: [video('https://v/over.webm', 'Over'), video('https://v/clean.webm', 'None')],
      }],
    }],
  });
  assert.equal(themes[0].videoUrl, 'https://v/clean.webm');
  assert.equal(themes[0].number, 2);
});

test('repli sur la seule vidéo disponible même avec overlap', () => {
  const themes = extractThemes({
    animethemes: [{
      type: 'OP', sequence: 1, song: song('Opening'),
      animethemeentries: [{ videos: [video('https://v/over.webm', 'Over')] }],
    }],
  });
  assert.equal(themes[0].videoUrl, 'https://v/over.webm');
});

test('écarte covers et versions alternatives', () => {
  const themes = extractThemes({
    animethemes: [{
      type: 'OP', sequence: 1, song: song('Opening (Cover ver.)'),
      animethemeentries: [{ videos: [video('https://v/cover.webm')] }],
    }],
  });
  assert.equal(themes.length, 0);
});
