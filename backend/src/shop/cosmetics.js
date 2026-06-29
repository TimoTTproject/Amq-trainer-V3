// Catalogue des cosmétiques (boutique). Défini en code : pas de gestion BDD.
// Chaque item porte un `css` (style inline appliqué à l'élément cible côté front)
// et/ou une `className` (pour les effets animés définis dans styles.css).
//
// 4 emplacements (slots) :
//   - cardBack      : dos de carte (face cachée à l'ouverture de booster)
//   - cardBorder    : bordure des cartes possédées (en plus de la couleur de rareté)
//   - profileBanner : fond du hero du profil
//   - avatarFrame   : anneau décoratif autour de l'avatar
//
// L'item `default` de chaque slot est gratuit et possédé par tout le monde
// implicitement (price 0, jamais stocké en BDD).

// ── LICENCES D'ANIME ──────────────────────────────────────────
// Cosmétiques thématiques utilisant l'artwork officiel AniList (couverture =
// dos de carte, bannière = fond de profil), hotlinké depuis le CDN AniList —
// exactement comme les images de personnages des cartes gacha. Achat en tokens
// (monnaie de jeu, aucun argent réel). Regroupés par franchise dans la boutique.
const ANIME_LICENSES = [
  { key: 'one-piece', name: 'One Piece', color: '#e49335',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-wf37VakJmZqs.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx141902-fTyoTk8F8qOl.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/141902-SvnRSXnN7DWC.jpg' },
  { key: 'naruto', name: 'Naruto', color: '#e47850',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/20-HHxhPj5JD13a.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1735-kGfVm0YqCPcu.png',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/1735.jpg' },
  { key: 'dragon-ball-z', name: 'Dragon Ball Z', color: '#e49343',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx813-ZhnFNOeCU5dQ.png',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/813-03ZLvWJgR6Wd.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21175-EH06qlfF8TnB.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21175-bXEDZ4sk6jTJ.png' },
  { key: 'attack-on-titan', name: "L'Attaque des Titans", color: '#f1a143',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-8jpFCOcDmneX.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20958-HuFJyr54Mmir.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/20958-Y7eQdz9VENBD.jpg' },
  { key: 'demon-slayer', name: 'Demon Slayer', color: '#f1c9ae',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/101922-33MtJGsUSxga.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx112151-1qlQwPB1RrJe.png',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/112151-eHCBz19nf2yC.jpg' },
  { key: 'jujutsu-kaisen', name: 'Jujutsu Kaisen', color: '#e45d5d',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/113415-jQBSkxWAAk83.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx145064-hSNRJM03pvv1.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/145064-esDtAY2He7sk.jpg' },
  { key: 'my-hero-academia', name: 'My Hero Academia', color: '#f1d643',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21459-nYh85uj2Fuwr.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21459-yeVkolGKdGUV.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21856-gutauxhWAwn6.png',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21856-wtSHgeHFmzdG.jpg' },
  { key: 'fma-brotherhood', name: 'Fullmetal Alchemist', color: '#e4c993',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/5114-q0V5URebphSG.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx121-zjmixZ428Mwv.png',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/121-t5K7c8WRuPWl.jpg' },
  { key: 'bleach', name: 'Bleach', color: '#f1a150',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx269-d2GmRkJbMopq.png',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/269-08ar2HJOUAuL.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx116674-p3zK4PUX2Aag.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/116674-l2YlIyJzvGSV.jpg' },
  { key: 'death-note', name: 'Death Note', color: '#b23b3b',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1535-kUgkcrfOrkUM.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/1535.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/b2994-mlofkz5GpkIu.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/b2994-mlofkz5GpkIu.jpg' },
  { key: 'hunter-x-hunter', name: 'Hunter x Hunter', color: '#f1d65d',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx11061-y5gsT1hoHuHw.png',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/11061-8WkkTZ6duKpq.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx136-gj0bbCpDNrKG.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/136-uHALFo2vGOGd.jpg' },
  { key: 'sword-art-online', name: 'Sword Art Online', color: '#e4bb5d',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx11757-SxYDUzdr9rh2.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/11757-TlEEV9weG4Ag.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/nx20594-FhRgZ1H9Istt.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/20594-BZOLwqidcS1G.jpg' },
  { key: 'one-punch-man', name: 'One Punch Man', color: '#e4ae5d',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21087-B5DHjqZ3kW4b.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21087-sHb9zUZFsHe1.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx97668-nC8gQrXVxt7k.png',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/97668-8Yo3iH2fxbKR.jpg' },
  { key: 'spy-x-family', name: 'Spy x Family', color: '#7fd0d0',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx140960-Kb6R5nYQfjmP.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/140960-Z7xSvkRxHKfj.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx142838-26JrqcFU1ljB.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/142838-tynuN00wxmKO.jpg' },
  { key: 'chainsaw-man', name: 'Chainsaw Man', color: '#d4452f',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx127230-DdP4vAdssLoz.png',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/127230-o8IRwCGVr9KW.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx171627-ZN9D7P46yHnw.png',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/171627-7esVHhgw69rn.jpg' },
  { key: 'tokyo-ghoul', name: 'Tokyo Ghoul', color: '#ff6b35',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/b20605-k665mVkSug8D.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/20605-RCJ7M71zLmrh.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20850-glDf9EMKeCwe.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/20850-YjtRXQkNl0xz.jpg' },
  { key: 'code-geass', name: 'Code Geass', color: '#c9d678',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1575-hsmWM2ydNm1m.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/1575.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx2904-Fet9Q33suC7G.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/2904-X71fcvE83n3s.jpg' },
  { key: 'steins-gate', name: 'Steins;Gate', color: '#e4b98a',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx9253-tIUXF2gfU8Sg.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/n9253-JIhmKgBKsWUN.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11577-rhqsxLOAge4f.png',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/11577.jpg' },
  { key: 're-zero', name: 'Re:Zero', color: '#f150ae',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21355-wRVUrGxpvIQQ.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21355-f9SjOfEJMk5P.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx108632-lQWnmw7XaNOK.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/108632-yeLbrgPN4Oni.jpg' },
  { key: 'mob-psycho-100', name: 'Mob Psycho 100', color: '#d65d1a',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21507-6YUSbh2m0N1p.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21507-Qx8bGsLXUgLo.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101338-rokVscjRYzdP.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/101338-Rl54Qhx71dUq.jpg' },
  { key: 'vinland-saga', name: 'Vinland Saga', color: '#f16b5d',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx101348-2fhDFPCuMNiz.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/101348-pivKKffCAwAY.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx136430-gsBsJjA7hGh9.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/136430-ktoFZnyubhHg.jpg' },
  { key: 'evangelion', name: 'Evangelion', color: '#f17843',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx30-AI1zr74Dh4ye.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/30-gEMoHHIqxDgN.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx32-5JYsv0wc122I.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/n32-BH9yHJBQqeOa.jpg' },
  { key: 'black-clover', name: 'Black Clover', color: '#d6c96b',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx97940-fyh8o7gNbha0.png',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/97940-1URQdQ4U1a0b.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx131680-gjs8mMQPmkOQ.png',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/131680-6jyC01S1Gila.jpg' },
  { key: 'dr-stone', name: 'Dr. Stone', color: '#e4bb50',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx113936-D4eYd4XwslVI.jpg',
    banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/113936-PpMtCY9kCwwV.jpg',
    coverAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx105333-GybuoSoOZfpH.jpg',
    bannerAlt: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/105333-KWKGvBM8Hyga.jpg' },
];

// Génère 4 cosmétiques par franchise : deux dos de carte et deux bannières.
// Les ids historiques de la première série restent inchangés afin de préserver
// les achats et équipements existants.
const LICENSE_COSMETICS = ANIME_LICENSES.flatMap((l) => [
  { cover: l.cover, banner: l.banner, idSuffix: '', nameSuffix: '' },
  { cover: l.coverAlt, banner: l.bannerAlt, idSuffix: '-v2', nameSuffix: ' · Visuel 2' },
].flatMap((visual) => [
  { id: `lic-${l.key}${visual.idSuffix}-back`, slot: 'cardBack', license: l.name,
    name: `${l.name} — Dos de carte${visual.nameSuffix}`,
    price: 1200, image: true, css: `background:#0c0e12 url('${visual.cover}') center/cover` },
  { id: `lic-${l.key}${visual.idSuffix}-banner`, slot: 'profileBanner', license: l.name,
    name: `${l.name} — Bannière${visual.nameSuffix}`,
    price: 1000, image: true, css: `background:#0c0e12 url('${visual.banner}') center/cover` },
]));

const COSMETICS = [
  // ── Dos de cartes ─────────────────────────────────────────────
  { id: 'back-default', slot: 'cardBack', name: 'Classique', price: 0,
    css: '', icon: 'fa-music' },
  { id: 'back-twilight', slot: 'cardBack', name: 'Crépuscule', price: 300,
    css: 'background:linear-gradient(135deg,#3a1c71,#d76d77,#ffaf7b)', icon: 'fa-moon' },
  { id: 'back-ocean', slot: 'cardBack', name: 'Océan', price: 300,
    css: 'background:linear-gradient(135deg,#0f2027,#2c5364,#00b4db)', icon: 'fa-water' },
  { id: 'back-sakura', slot: 'cardBack', name: 'Sakura', price: 500,
    css: 'background:linear-gradient(135deg,#ffafbd,#ffc3a0,#ff8fab)', icon: 'fa-fan' },
  { id: 'back-neon', slot: 'cardBack', name: 'Néon', price: 800,
    css: 'background:radial-gradient(circle at 50% 30%,#1a1a2e,#0f0f1a)', className: 'cb-neon', icon: 'fa-bolt' },
  { id: 'back-gold', slot: 'cardBack', name: 'Or royal', price: 1500,
    css: 'background:linear-gradient(135deg,#b8860b,#ffd700,#fff3b0,#b8860b)', className: 'cb-shine', icon: 'fa-crown' },

  // ── Bordures de cartes ────────────────────────────────────────
  { id: 'border-default', slot: 'cardBorder', name: 'Aucune', price: 0, css: '' },
  { id: 'border-silver', slot: 'cardBorder', name: 'Argent', price: 300,
    css: 'box-shadow:0 0 0 3px #cfd8dc,0 0 10px rgba(207,216,220,.6)' },
  { id: 'border-gold', slot: 'cardBorder', name: 'Or', price: 600,
    css: 'box-shadow:0 0 0 3px #ffd700,0 0 12px rgba(255,215,0,.6)' },
  { id: 'border-flame', slot: 'cardBorder', name: 'Flammes', price: 900,
    css: 'box-shadow:0 0 0 3px #ff5722,0 0 16px rgba(255,87,34,.7)' },
  { id: 'border-rainbow', slot: 'cardBorder', name: 'Arc-en-ciel', price: 1200,
    css: '', className: 'cosm-rainbow-border' },

  // ── Bannières de profil ───────────────────────────────────────
  { id: 'banner-default', slot: 'profileBanner', name: 'Classique', price: 0, css: '' },
  { id: 'banner-aurora', slot: 'profileBanner', name: 'Aurore', price: 400,
    css: 'background:linear-gradient(120deg,#1d2b64,#2a5298,#43cea2)' },
  { id: 'banner-forest', slot: 'profileBanner', name: 'Forêt', price: 400,
    css: 'background:linear-gradient(120deg,#134e5e,#71b280)' },
  { id: 'banner-sunset', slot: 'profileBanner', name: 'Coucher de soleil', price: 700,
    css: 'background:linear-gradient(120deg,#ff512f,#dd2476,#ff8a00)' },
  { id: 'banner-galaxy', slot: 'profileBanner', name: 'Galaxie', price: 700,
    css: 'background:linear-gradient(120deg,#0f0c29,#302b63,#24243e)' },
  { id: 'banner-holo', slot: 'profileBanner', name: 'Holographique', price: 1500,
    css: '', className: 'cosm-holo-banner' },

  // ── Cadres d'avatar ───────────────────────────────────────────
  { id: 'frame-default', slot: 'avatarFrame', name: 'Aucun', price: 0, css: '' },
  { id: 'frame-bronze', slot: 'avatarFrame', name: 'Bronze', price: 200,
    css: 'box-shadow:0 0 0 3px #cd7f32' },
  { id: 'frame-silver', slot: 'avatarFrame', name: 'Argent', price: 400,
    css: 'box-shadow:0 0 0 3px #cfd8dc,0 0 8px rgba(207,216,220,.6)' },
  { id: 'frame-gold', slot: 'avatarFrame', name: 'Or', price: 800,
    css: 'box-shadow:0 0 0 3px #ffd700,0 0 10px rgba(255,215,0,.6)' },
  { id: 'frame-mythic', slot: 'avatarFrame', name: 'Mythique', price: 1500,
    css: '', className: 'cosm-mythic-frame' },

  // ── EXCLUSIFS DE PALIER (débloqués par le rang classé/solo, non achetables) ──
  // tierReq = index de palier requis (1 Argent · 2 Or · 3 Platine · 4 Diamant · 5 Maître)
  { id: 'frame-rank-argent', slot: 'avatarFrame', name: 'Rang Argent', exclusive: true, tierReq: 1, icon: 'fa-medal',
    css: 'box-shadow:0 0 0 3px #b9c4cc,0 0 12px rgba(185,196,204,.7)' },
  { id: 'border-rank-or', slot: 'cardBorder', name: 'Rang Or', exclusive: true, tierReq: 2,
    css: 'box-shadow:0 0 0 3px #ffcf33,0 0 16px rgba(255,207,51,.7)' },
  { id: 'banner-rank-platine', slot: 'profileBanner', name: 'Rang Platine', exclusive: true, tierReq: 3,
    css: 'background:linear-gradient(120deg,#0aa3a3,#7fffd4,#0aa3a3)' },
  { id: 'back-rank-diamant', slot: 'cardBack', name: 'Rang Diamant', exclusive: true, tierReq: 4, icon: 'fa-gem',
    css: 'background:linear-gradient(135deg,#3a8dde,#7fd2ff,#dff6ff,#3a8dde)', className: 'cb-shine' },
  { id: 'frame-rank-maitre', slot: 'avatarFrame', name: 'Rang Maître', exclusive: true, tierReq: 5, icon: 'fa-crown',
    css: '', className: 'cosm-mythic-frame' },

  // ── Licences d'anime (générées ci-dessus) ────────────────────
  ...LICENSE_COSMETICS,
];

// Ordre + couleur d'accent des franchises (pour la section « Licences » de la boutique)
const LICENSES = ANIME_LICENSES.map((l) => l.name);
const LICENSE_COLORS = Object.fromEntries(ANIME_LICENSES.map((l) => [l.name, l.color]));

const SLOTS = ['cardBack', 'cardBorder', 'profileBanner', 'avatarFrame'];
const SLOT_LABELS = {
  cardBack: 'Dos de cartes',
  cardBorder: 'Bordures de cartes',
  profileBanner: 'Bannières de profil',
  avatarFrame: "Cadres d'avatar",
};

const BY_ID = Object.fromEntries(COSMETICS.map((c) => [c.id, c]));
// Item par défaut (gratuit) de chaque slot
const DEFAULT_BY_SLOT = Object.fromEntries(
  SLOTS.map((s) => [s, COSMETICS.find((c) => c.slot === s && c.price === 0)])
);

// Résolveur dynamique (cosmétiques générés depuis la BDD, ex. personnages).
// Branché à l'exécution par character-cosmetics.js pour que byId() — et donc
// resolveEquipped(), l'achat et l'équipement — fonctionnent sur ces ids sans
// que ce module touche à la base de données.
let dynamicResolver = null;
function registerDynamicResolver(fn) {
  dynamicResolver = fn;
}

function byId(id) {
  if (!id) return null;
  return BY_ID[id] || (dynamicResolver ? dynamicResolver(id) : null) || null;
}

// Forme transmise au front pour appliquer un cosmétique
function publicCosmetic(c) {
  if (!c) return null;
  return {
    id: c.id, slot: c.slot, name: c.name, css: c.css || '', className: c.className || '', icon: c.icon || null,
    ...(c.image ? { image: true } : {}),
    ...(c.license ? { license: c.license } : {}),
    ...(c.exclusive ? { exclusive: true, tierReq: c.tierReq } : {}),
  };
}

// Résout les cosmétiques équipés d'un utilisateur en objets prêts à appliquer.
// Un slot vide → l'item par défaut du slot (apparence standard).
function resolveEquipped(user) {
  const out = {};
  for (const slot of SLOTS) {
    const equipped = byId(user && user[slot]);
    out[slot] = publicCosmetic(equipped || DEFAULT_BY_SLOT[slot]);
  }
  return out;
}

module.exports = {
  COSMETICS,
  SLOTS,
  SLOT_LABELS,
  LICENSES,
  LICENSE_COLORS,
  byId,
  registerDynamicResolver,
  publicCosmetic,
  resolveEquipped,
  DEFAULT_BY_SLOT,
};
