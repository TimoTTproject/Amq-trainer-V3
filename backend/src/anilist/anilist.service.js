// Accès à l'API GraphQL d'AniList
const ANILIST_GQL = 'https://graphql.anilist.co';

async function anilistQuery(query, variables, accessToken) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(ANILIST_GQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error('AniList: ' + json.errors.map((e) => e.message).join(', '));
  }
  return json.data;
}

// Liste des anime terminés d'un utilisateur (par pseudo)
async function getCompletedAnime(username) {
  const query = `
    query ($name: String) {
      MediaListCollection(userName: $name, type: ANIME, status: COMPLETED) {
        lists { entries { media { id title { romaji english native } synonyms popularity } } }
      }
    }`;
  const data = await anilistQuery(query, { name: username });
  const lists = data?.MediaListCollection?.lists || [];
  const map = new Map();
  for (const entry of lists.flatMap((l) => l.entries)) {
    const m = entry.media;
    if (!map.has(m.id)) map.set(m.id, m);
  }
  return Array.from(map.values());
}

// Profil de l'utilisateur connecté (OAuth) — pour récupérer id/nom/avatar
async function getViewer(accessToken) {
  const query = `query { Viewer { id name avatar { large } } }`;
  const data = await anilistQuery(query, {}, accessToken);
  return data?.Viewer;
}

// Top animes par popularité (pour construire le catalogue global, Phase 2)
async function getPopularAnime(page = 1, perPage = 50) {
  const query = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: POPULARITY_DESC) {
          id title { romaji english native } synonyms popularity
        }
      }
    }`;
  const data = await anilistQuery(query, { page, perPage });
  return data?.Page?.media || [];
}

// Top personnages par popularité (favourites) — pour le pool gacha.
async function getTopCharacters(page = 1, perPage = 50) {
  const query = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage }
        characters(sort: FAVOURITES_DESC) {
          id name { full } image { large } favourites
          media(sort: POPULARITY_DESC, perPage: 1) { nodes { id title { romaji english } } }
        }
      }
    }`;
  const data = await anilistQuery(query, { page, perPage });
  return {
    characters: data?.Page?.characters || [],
    hasNextPage: data?.Page?.pageInfo?.hasNextPage || false,
  };
}

// Média (anime) principal de plusieurs personnages — pour remplir « series ».
async function getCharacterMedia(ids) {
  const query = `
    query ($ids: [Int]) {
      Page(perPage: 50) {
        characters(id_in: $ids) {
          id
          media(sort: POPULARITY_DESC, perPage: 1) { nodes { id title { romaji english } } }
        }
      }
    }`;
  const data = await anilistQuery(query, { ids });
  return data?.Page?.characters || [];
}

// Extrait { series, seriesId } du média principal d'un personnage AniList
function seriesOfCharacter(c) {
  const node = c?.media?.nodes?.[0];
  if (!node) return { series: null, seriesId: null };
  const t = node.title || {};
  return { series: t.romaji || t.english || null, seriesId: node.id || null };
}

// Récupère les titres de plusieurs animes par leurs ids (pour le backfill).
async function getAnimeTitlesByIds(ids) {
  const query = `
    query ($ids: [Int]) {
      Page(perPage: 50) {
        media(id_in: $ids, type: ANIME) { id title { romaji english native } synonyms }
      }
    }`;
  const data = await anilistQuery(query, { ids });
  return data?.Page?.media || [];
}

module.exports = { anilistQuery, getCompletedAnime, getViewer, getPopularAnime, getAnimeTitlesByIds, getTopCharacters, getCharacterMedia, seriesOfCharacter };
