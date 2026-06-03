// Place la route POST après l'initialisation d'app et des middlewares
// Fonction utilitaire pour envoyer des données SSE en toute sécurité
function sendSSESafe(res, data) {
    try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
    } catch (error) {
        console.error('Erreur SSE:', error);
        return false;
    }
}
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const NodeCache = require('node-cache');

// Correction fetch pour Node.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const stringSimilarity = require('string-similarity');

const app = express();
const THEMES_DB_FILE = './themes_database.json';

// Initialiser la base de données des thèmes
let themesDatabase = new Map();

// Charger la base de données au démarrage
function loadThemesDatabase() {
    try {
        if (fs.existsSync(THEMES_DB_FILE)) {
            const data = fs.readFileSync(THEMES_DB_FILE, 'utf8');
            const db = JSON.parse(data);
            db.forEach(entry => {
                themesDatabase.set(entry.anilistId, {
                    animeTitle: entry.animeTitle,
                    themes: entry.themes,
                    lastUpdated: entry.lastUpdated
                });
            });
            console.log(`Base de données thèmes chargée: ${themesDatabase.size} animes`);
        }
    } catch (error) {
        console.error('Erreur chargement base de données thèmes:', error);
    }
}

// Sauvegarder la base de données
function saveThemesDatabase() {
    try {
        const dbData = Array.from(themesDatabase.entries()).map(([anilistId, data]) => ({
            anilistId,
            animeTitle: data.animeTitle,
            themes: data.themes,
            lastUpdated: data.lastUpdated
        }));
        fs.writeFileSync(THEMES_DB_FILE, JSON.stringify(dbData, null, 2));
    } catch (error) {
        console.error('Erreur sauvegarde base de données thèmes:', error);
    }
}
const PORT = 3000;
const SESSIONS_FILE = './sessions.json';

// Pour stocker les sessions utilisateur et leurs chansons
const userSessions = new Map();

app.use(cors());
app.use(bodyParser.json());

// Cache pour améliorer les performances
const animeCache = new NodeCache({ stdTTL: 3600 }); // Cache d'1 heure

// Fonction de normalisation améliorée pour les noms d'anime
function normalizeAnimeName(name) {
    if (!name || name === 'undefined' || name === 'null') {
        return 'Anime inconnu';
    }
    
    let normalized = name.toString().trim();
    
        // Pour Gintama, garder le nom exact pour chaque saison (pas de normalisation)
        if (/^gintama/i.test(name.trim())) {
            return name.trim();
        }
    
    // Normalisation pour les autres anime
    normalized = normalized
        .replace(/\[.*?\]|\(.*?\)/g, '') // Supprimer les crochets et parenthèses
        .replace(/\s+/g, ' ')             // Espaces multiples -> simple
        .trim();
    
    // Conserver les indicateurs de saison importants
    const keepPatterns = [
        /(\d{4})/,       // Garder les années
        /(season\s*\d+)/i,
        /(part\s*\d+)/i,
        /(cour\s*\d+)/i
    ];
    // (Note : les patterns sont là pour extension future, non utilisés ici)
    
    // Capitaliser la première lettre de chaque mot
    normalized = normalized.replace(/\b\w/g, char => char.toUpperCase());
    
    return normalized || 'Anime inconnu';
}

// Améliorer la fonction getArtistName
function getArtistName(songData) {
    if (!songData) return 'Artiste inconnu';
    // Essayer différentes propriétés possibles
    const possiblePaths = [
        songData.artists?.[0]?.name,
        songData.artist,
        songData.as?.artist,
        songData.performer,
        songData.composer
    ];
    for (const artist of possiblePaths) {
        if (artist && typeof artist === 'string' && artist.trim() !== '') {
            return artist.trim();
        }
    }
    return 'Artiste inconnu';
}

// Améliorer l'extraction du nom de la chanson
function getSongTitle(theme) {
    if (!theme.song) return `Thème ${theme.type}${theme.sequence || 1}`;
    // Essayer différentes propriétés possibles
    const possiblePaths = [
        theme.song.title,
        theme.song.name,
        theme.title,
        theme.name
    ];
    for (const title of possiblePaths) {
        if (title && typeof title === 'string' && title.trim() !== '') {
            return title.trim();
        }
    }
    return `Thème ${theme.type}${theme.sequence || 1}`;
}

// Fonction pour extraire les thèmes des données AnimeThemes (VERSION CORRIGÉE)
function extractThemesFromAnimeData(animeData, originalTitle) {
    const themes = [];
    if (!animeData.animethemes || !Array.isArray(animeData.animethemes)) {
        return themes;
    }
    // Utiliser la normalisation améliorée
    const cleanTitle = normalizeAnimeName(originalTitle || animeData.name);
    console.log(`Extraction pour: ${cleanTitle} (original: "${originalTitle}")`);
    for (const theme of animeData.animethemes) {
        const themeNumber = theme.sequence || 1;
        if (theme.type === 'OP' && theme.animethemeentries && Array.isArray(theme.animethemeentries)) {
            for (const entry of theme.animethemeentries) {
                if (entry.videos && Array.isArray(entry.videos) && entry.videos.length > 0) {
                    // Prendre le premier lien vidéo valide
                    const video = entry.videos.find(v => v.link && v.basename !== 'NC');
                    if (video) {
                        const songTitle = getSongTitleFromTheme(theme);
                        const artistName = getArtistNameFromTheme(theme);
                        const themeData = {
                            anime: cleanTitle,
                            type: theme.type,
                            number: themeNumber,
                            title: songTitle,
                            artist: artistName,
                            videoUrl: video.link,
                            easyCount: 0,
                            hardCount: 0,
                            againCount: 0
                        };
                        themes.push(themeData);
                        break;
                    }
                }
            }
        }
    }
    // Filtrer les doublons et versions non originales (cover, alternative, remix, yorinuki)
    const filteredThemes = themes.filter(theme => {
        // Exclure les versions cover/alternatives/remix/yorinuki
        const isCover = /cover|alternative|yorinuki|remix|version/i.test(theme.title || '');
        const isOriginalArtist = !/yorinuki|cover|remix/i.test(theme.artist || '');
        // Exclure les titres vides ou trop courts
        const isValidTitle = theme.title && theme.title.length > 2;
        return !isCover && isOriginalArtist && isValidTitle;
    });
    console.log(`Extrait ${filteredThemes.length} thèmes OP originaux de: ${cleanTitle}`);
    return filteredThemes;
}

// Fonctions d'extraction améliorées avec plus de cas de figure
function getSongTitleFromTheme(theme) {
    try {
        console.log('Structure du thème pour titre:', JSON.stringify(theme, null, 2));
        // Priorité 1: song.title
        if (theme.song && theme.song.title) {
            return theme.song.title;
        }
        // Priorité 2: theme.title
        if (theme.title) {
            return theme.title;
        }
        // Priorité 3: song.name
        if (theme.song && theme.song.name) {
            return theme.song.name;
        }
        // Priorité 4: slug formaté
        if (theme.slug) {
            const slugTitle = theme.slug
                .split('-')
                .join(' ')
                .replace(/\b\w/g, l => l.toUpperCase());
            if (slugTitle) return slugTitle;
        }
        // Priorité 5: identifier
        if (theme.song && theme.song.identifier) {
            return theme.song.identifier;
        }
    } catch (error) {
        console.error('Erreur extraction titre:', error);
    }
    // Fallback avec numéro corrigé
    const themeNumber = theme.sequence || 1;
    return `Thème ${theme.type}${themeNumber}`;
}

function getArtistNameFromTheme(theme) {
    try {
        console.log('Structure song pour artiste:', JSON.stringify(theme.song, null, 2));
        
        if (theme.song && theme.song.artists && Array.isArray(theme.song.artists)) {
            const artists = theme.song.artists
                .map(artist => {
                    if (artist && typeof artist === 'object') {
                        return artist.name || artist.artist_name || artist.title;
                    }
                    return artist;
                })
                .filter(name => name && typeof name === 'string')
                .join(', ');
            
            if (artists) return artists;
        }
        if (theme.song && theme.song.artist) {
            return theme.song.artist;
        }
        if (theme.artist) {
            return theme.artist;
        }
        // Recherche dans d'autres propriétés possibles
        if (theme.song && theme.song.performer) {
            return theme.song.performer;
        }
        if (theme.song && theme.song.singer) {
            return theme.song.singer;
        }
        if (theme.song && theme.song.composer) {
            return theme.song.composer;
        }
    } catch (error) {
        console.error('Erreur extraction artiste:', error);
    }
    
    // Fallback: chercher dans le nom du thème ou autre
    if (theme.slug) {
        // Essayer d'extraire l'artiste du slug
        const slugParts = theme.slug.split('-');
        if (slugParts.length > 1) {
            return slugParts[slugParts.length - 1].replace(/\b\w/g, l => l.toUpperCase());
        }
    }
    
        return 'Artiste inconnu';
    }

// Fonction pour récupérer les thèmes d'un anime depuis l'API AnimeThemes
async function getThemesForAnime(anilistId, animeTitle, synonyms = []) {
    // Vérifier d'abord dans la base de données permanente
    const dbEntry = themesDatabase.get(anilistId);
    if (dbEntry) {
        console.log(`Thèmes trouvés en base pour: ${animeTitle} (${anilistId})`);
        return dbEntry.themes;
    }

    // Vérifier ensuite dans le cache mémoire
    const cacheKey = `anilist-${anilistId}`;
    const cached = animeCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    // Si pas en base, procéder à la recherche normale
    console.log(`Recherche thèmes pour nouvel anime: ${animeTitle} (${anilistId})`);

    // Validation du titre
    const validTitle = animeTitle && animeTitle !== 'undefined' ? animeTitle : 'Titre inconnu';
    // Timeout individuel pour chaque anime (5 secondes max)
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve([]), 5000);
    });

    const themesPromise = (async () => {
        // OPTIM: Retourner vite si pas d'anime populaire
        if (!/^gintama/i.test(animeTitle.trim())) {
            const fallback = getFallbackThemes(animeTitle, anilistId);
            if (fallback.length > 0) {
                return fallback;
            }
        }

        let themes = [];
        try {
            // OPTIM: Recherche directe par nom (plus rapide)
            const searchResponse = await fetch(`https://api.animethemes.moe/anime?include=animethemes.song.artists,animethemes.animethemeentries.videos&q=${encodeURIComponent(animeTitle)}`);
            if (searchResponse.ok) {
                const searchResult = await searchResponse.json();
                if (searchResult.anime && searchResult.anime.length > 0) {
                    let bestMatch = null;
                    let bestScore = 0.4; // Réduire le seuil de similarité
                    for (const anime of searchResult.anime) {
                        // Essayer plusieurs comparaisons
                        const similarity1 = stringSimilarity.compareTwoStrings(
                            normalizeAnimeName(animeTitle),
                            normalizeAnimeName(anime.name)
                        );
                        // Vérifier aussi les synonymes
                        let maxSynonymSimilarity = 0;
                        if (synonyms && synonyms.length > 0) {
                            synonyms.forEach(synonym => {
                                const sim = stringSimilarity.compareTwoStrings(
                                    normalizeAnimeName(synonym),
                                    normalizeAnimeName(anime.name)
                                );
                                maxSynonymSimilarity = Math.max(maxSynonymSimilarity, sim);
                            });
                        }
                        const totalSimilarity = Math.max(similarity1, maxSynonymSimilarity);
                        if (totalSimilarity > bestScore) {
                            bestScore = totalSimilarity;
                            bestMatch = anime;
                        }
                    }
                    if (bestMatch) {
                        themes = extractThemesFromAnimeData(bestMatch, animeTitle);
                    }
                }
            }
        } catch (error) {
            console.error('Erreur recherche rapide:', error);
        }
        return themes;
    })();

    try {
        const themes = await Promise.race([themesPromise, timeoutPromise]);
        animeCache.set(cacheKey, themes);
        // Après avoir obtenu les thèmes, les sauvegarder dans la base permanente
        if (themes.length > 0) {
            themesDatabase.set(anilistId, {
                animeTitle: animeTitle,
                themes: themes,
                lastUpdated: new Date().toISOString()
            });
            saveThemesDatabase();
            console.log(`Nouvel anime sauvegardé en base: ${animeTitle} (${anilistId})`);
        }
        return themes;
    } catch (error) {
        animeCache.set(cacheKey, []);
        return [];
    }
}

function getFallbackThemes(animeTitle, anilistId) {
    const normalizedTitle = normalizeAnimeName(animeTitle);
    
    const fallbackThemes = {
        // Gintama - différentes saisons séparées
        918: { // Gintama original (2006-2010)
            anime: "Gintama",
            themes: [
                { title: "Pray", artist: "Tommy heavenly6", type: "OP", number: 1 },
                { title: "Tooi Nioi", artist: "YO-KING", type: "OP", number: 2 },
                { title: "Gin Iris", artist: "Neko Jump", type: "OP", number: 3 },
                { title: "Kasanaru Kage", artist: "Hearts Grow", type: "OP", number: 4 }
            ]
        },
        20996: { // Gintama° (2015)
            anime: "Gintama° (2015)", 
            themes: [
                { title: "DAYxDAY", artist: "BLUE ENCOUNT", type: "OP", number: 1 },
                { title: "DESTINY", artist: "Negoto", type: "OP", number: 2 },
                { title: "Beautiful Days", artist: "OKAMOTO'S", type: "OP", number: 3 }
            ]
        },
        33028: { // Gintama. (2017)
            anime: "Gintama. (2017)",
            themes: [
                { title: "KAGERO", artist: "BURNOUT SYNDROMES", type: "OP", number: 1 },
                { title: "Hanaichi Monme", artist: "THREE LIGHTS DOWN KINGS", type: "OP", number: 2 }
            ]
        },
        114129: { // Gintama: The Final (2021)
            anime: "Gintama: The Final",
            themes: [
                { title: "Katte ni My Soul", artist: "DISH//", type: "OP", number: 1 }
            ]
        },
        // Yuu☆Yuu☆Hakusho
        392: {
            anime: "Yuu☆Yuu☆Hakusho",
            themes: [
                { title: "Hohoemi no Bakudan", artist: "Matsuko Mawatari", type: "OP", number: 1 },
                { title: "Sunshine", artist: "Matsuko Mawatari", type: "OP", number: 2 },
                { title: "Daydream Generation", artist: "Matsuko Mawatari", type: "OP", number: 3 }
            ]
        }
    };

    if (fallbackThemes[anilistId]) {
        const data = fallbackThemes[anilistId];
        return data.themes.map(theme => ({
            ...theme,
            anime: data.anime,
            videoUrl: theme.videoUrl || "https://www.youtube.com/embed/example"
        }));
    }
    
    // Recherche par titre normalisé
    for (const [id, data] of Object.entries(fallbackThemes)) {
        if (normalizeAnimeName(data.anime) === normalizedTitle) {
            return data.themes.map(theme => ({
                ...theme,
                anime: data.anime,
                videoUrl: theme.videoUrl || "https://www.youtube.com/embed/example"
            }));
        }
    }
    
    return [];
}

// Fonction pour récupérer les anime vus par l'utilisateur AniList
async function fetchUserSongs(username, onProgress, limit = 1000) {
    console.log(`Import OPTIMISÉ (OP seulement) pour: ${username}`);
    
    try {
        // 1. Récupère la liste d'anime vus sur AniList
        const query = `
            query ($name: String) {
                MediaListCollection(userName: $name, type: ANIME, status: COMPLETED) {
                    lists {
                        entries {
                            media {
                                id
                                title { romaji english }
                                synonyms
                            }
                        }
                    }
                }
            }
        `;
        const variables = { name: username };
        const response = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables })
        });
        const result = await response.json();
        if (!result.data || !result.data.MediaListCollection) {
            throw new Error('Impossible de récupérer la liste AniList');
        }

        // Filtrer les doublons d'anime par ID
        const uniqueAnimeMap = new Map();
        for (const entry of result.data.MediaListCollection.lists.flatMap(list => list.entries)) {
            const media = entry.media;
            if (!uniqueAnimeMap.has(media.id)) {
                uniqueAnimeMap.set(media.id, media);
            }
        }
        const uniqueAnimeList = Array.from(uniqueAnimeMap.values());

        let songs = [];
        let totalOps = 0;
        let matchedAnime = 0;

        // OPTIM: Traitement par batch avec délai réduit
        for (let i = 0; i < Math.min(uniqueAnimeList.length, limit); i++) {
            const media = uniqueAnimeList[i];
            const totalAnime = Math.min(uniqueAnimeList.length, limit);
            // Progress update
            if (onProgress) {
                onProgress({
                    progress: Math.round(((i + 1) / totalAnime) * 100),
                    current: i + 1,
                    total: totalAnime,
                    message: `Recherche d'openings pour ${media.title.romaji}...`,
                    totalOpenings: totalOps,
                    matchedAnime: matchedAnime,
                    totalSongs: totalOps
                });
            }
            try {
                // Recherche RAPIDE (OP seulement)
                const animeThemes = await getThemesForAnime(media.id, media.title.romaji, media.synonyms || []);
                // Ajout du log de similarité et du nombre de thèmes
                let bestScore = null;
                if (animeThemes && animeThemes.length > 0 && animeThemes[0]._bestScore !== undefined) {
                    bestScore = animeThemes[0]._bestScore;
                }
                console.log(`→ ${media.title.romaji}: ${animeThemes.length} thèmes trouvés, similarité: ${bestScore || 'N/A'}`);
                if (animeThemes.length === 0) {
                    console.log(`   Aucun thème trouvé pour: ${media.title.romaji}`);
                }
                if (animeThemes.length > 0) {
                    matchedAnime++;
                    totalOps += animeThemes.length;
                    songs.push(...animeThemes);
                }
                await new Promise(res => setTimeout(res, 50));
            } catch (error) {
                console.error(`Erreur pour ${media.title.romaji}:`, error.message);
                continue;
            }
        }

        // DÉDUPLICATION avant de retourner
        console.log(`Avant déduplication: ${songs.length} chansons`);
        songs = deduplicateSongs(songs);
        console.log(`Après déduplication: ${songs.length} chansons`);

        return {
            songs,
            totalAnime: uniqueAnimeList.length,
            totalOpenings: songs.length, // Utiliser le count dédupliqué
            totalSongs: songs.length,
            matchedAnime: matchedAnime
        };
    } catch (error) {
        console.error('Erreur fetchUserSongs:', error);
        throw error;
    }
}

// Fonction pour dédupliquer les chansons (VERSION CORRIGÉE)
function deduplicateSongs(songs) {
    const seen = new Set();
    const uniqueSongs = [];
    songs.forEach(song => {
        // Créer une clé basée sur l'anime + type + numéro + titre normalisé
        const normalizedTitle = song.title
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const key = `${song.anime}|${song.type}|${song.number}|${normalizedTitle}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueSongs.push(song);
        } else {
            console.log(`Doublon supprimé: ${song.anime} - ${song.title}`);
        }
    });
    return uniqueSongs;
}

// Route d'import avec progression (SSE-like) - VERSION CORRIGÉE
app.get('/api/import-songs-progress', async (req, res) => {
    // Accepte username via GET (query string)
    const username = req.query?.username;
    const limit = parseInt(req.query?.limit) || 1000; // Limite par défaut à 1000
    if (!username) {
        res.write(`data: {"error": "Username is required"}\n\n`);
        return res.end();
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no'); // Important pour SSE

    // Envoyer un message de connexion initial
    res.write(': connected\n\n');
    res.flushHeaders(); // Forcer l'envoi des headers

    let sessionId = uuidv4();
    let isConnectionClosed = false;

    // Vérifier si la connexion est toujours active
    req.on('close', () => {
        console.log('Client a fermé la connexion SSE');
        isConnectionClosed = true;
        res.end();
    });

    // Remplacer la fonction sendSSEData par sendSSESafe
    // Envoyer un message de connexion initial
    res.write(': connected\n\n');

    try {
        let lastProgress = 0;
        // Envoyer un message de démarrage
        sendSSESafe(res, {
            message: `Début de l'import pour ${username}`,
            progress: 0,
            current: 0,
            total: 0
        });

        const result = await fetchUserSongs(username, (progress) => {
            if (isConnectionClosed) return;
            if (progress.progress !== lastProgress) {
                if (!sendSSESafe(res, progress)) {
                    isConnectionClosed = true;
                    return res.end();
                }
                lastProgress = progress.progress;
            }
        }, limit); // Passer la limite à fetchUserSongs

        if (isConnectionClosed) {
            console.log('Connexion fermée avant la fin de l\'import');
            return res.end();
        }

        userSessions.set(sessionId, {
            username: username,
            songs: result.songs,
            importDate: new Date().toISOString(),
            id: sessionId
        });
        saveSessions();

        // Envoie le résultat final
        const finalData = {
            completed: true,
            songs: result.songs,
            sessionId,
            username: username,
            totalAnime: result.totalAnime,
            totalOpenings: result.totalOpenings,
            totalEndings: result.totalEndings,
            totalSongs: result.totalSongs,
            matchedAnime: result.matchedAnime,
            importDate: new Date().toISOString()
        };

        sendSSESafe(res, finalData);
        res.end();
        
    } catch (err) {
        console.error('Erreur lors de l\'import:', err);
        if (!isConnectionClosed) {
            sendSSESafe(res, { 
                error: err.message,
                progress: 0,
                message: 'Erreur lors de l\'importation'
            });
            res.end();
        }
    }
});

// Route pour obtenir toutes les chansons d'une session
// Route POST pour import sans SSE (fetch)
app.post('/api/import-songs-progress', async (req, res) => {
    const username = req.body?.username;
    if (!username) {
        return res.status(400).json({ error: 'Username is required' });
    }

    try {
        // Import des chansons avec callback de progression ignoré
        const result = await fetchUserSongs(username);

        // Création d'une nouvelle session
        const sessionId = uuidv4();
        userSessions.set(sessionId, {
            username: username,
            songs: result.songs,
            importDate: new Date().toISOString(),
            id: sessionId
        });
        saveSessions();

        // Réponse finale
        res.json({
            completed: true,
            songs: result.songs,
            sessionId,
            username: username,
            totalAnime: result.totalAnime,
            totalOpenings: result.totalOpenings,
            totalEndings: result.totalEndings,
            totalSongs: result.totalSongs,
            matchedAnime: result.matchedAnime,
            importDate: new Date().toISOString()
        });
    } catch (err) {
        console.error('Erreur lors de l\'import (POST):', err);
        res.status(500).json({ error: err.message || 'Erreur lors de l\'importation' });
    }
});
app.get('/api/songs/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const userData = userSessions.get(sessionId);
    if (!userData) {
        return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ songs: userData.songs });
});

// Route pour obtenir une chanson aléatoire pour le quiz
app.get('/api/quiz/random/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const userData = userSessions.get(sessionId);
    if (!userData || !userData.songs || userData.songs.length === 0) {
        return res.status(404).json({ error: 'No songs available for quiz' });
    }
    
    const randomIndex = Math.floor(Math.random() * userData.songs.length);
    const randomSong = userData.songs[randomIndex];
    
    res.json({
        quiz: randomSong,
        answer: randomSong.anime
    });
});

// Route pour mettre à jour les stats d'une chanson
app.post('/api/quiz/feedback/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { anime, type, number, feedbackType } = req.body;
    const userData = userSessions.get(sessionId);
    if (!userData) {
        return res.status(404).json({ error: 'Session not found' });
    }
    const song = userData.songs.find(s =>
        s.anime === anime &&
        s.type === type &&
        s.number === number
    );
    if (!song) {
        return res.status(404).json({ error: 'Song not found' });
    }
    if (feedbackType === 'easy') song.easyCount = (song.easyCount || 0) + 1;
    if (feedbackType === 'hard') song.hardCount = (song.hardCount || 0) + 1;
    if (feedbackType === 'again') song.againCount = (song.againCount || 0) + 1;
    saveSessions();
    res.json({ success: true, song });
});

// Route pour réinitialiser une session
app.post('/api/session/reset/:sessionId', (req, res) => {
    userSessions.delete(req.params.sessionId);
    saveSessions();
    res.json({ success: true });
});

// Route de test
app.get('/api/test', (req, res) => {
    res.json({ message: 'API is working!', timestamp: new Date().toISOString() });
});

// Démarre le serveur
app.listen(PORT, () => {
    console.log(`Anime Music Quiz backend running on http://localhost:${PORT}`);
    console.log('Test endpoint: http://localhost:3000/api/test');
});

// Fonction temporaire pour déboguer le regroupement des chansons par anime
function debugAnimeGrouping() {
    console.log('=== DEBUG REGROUPEMENT ===');
    const animeCount = {};
    allSongs.forEach(song => {
        animeCount[song.anime] = (animeCount[song.anime] || 0) + 1;
    });
    console.log('Répartition par anime:');
    Object.entries(animeCount)
        .sort((a, b) => b[1] - a[1])
        .forEach(([anime, count]) => {
            console.log(`- ${anime}: ${count} chansons`);
        });
}

// Charger les sessions au démarrage du serveur
function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
            const sessions = JSON.parse(data);
            sessions.forEach(session => {
                userSessions.set(session.id, session);
            });
            console.log(`Sessions chargées: ${sessions.length}`);
        }
    } catch (error) {
        console.error('Erreur chargement sessions:', error);
    }
}

// Sauvegarder les sessions
function saveSessions() {
  try {
    const sessions = Array.from(userSessions.values());
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (error) {
    console.error('Erreur sauvegarde sessions:', error);
  }
}

// Charger au démarrage 
loadThemesDatabase();
loadSessions();

// Route pour forcer la mise à jour des thèmes d'un anime spécifique
app.post('/api/refresh-anime/:anilistId', async (req, res) => {
    const { anilistId } = req.params;
    const { animeTitle, synonyms } = req.body;
    
    // Supprimer de la base de données
    themesDatabase.delete(parseInt(anilistId));
    
    // Supprimer du cache
    animeCache.del(`anilist-${anilistId}`);
    
    try {
        // Rechercher à nouveau les thèmes
        const themes = await getThemesForAnime(parseInt(anilistId), animeTitle, synonyms || []);
        res.json({ success: true, themes });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Route pour obtenir les statistiques de la base de données
app.get('/api/database-stats', (req, res) => {
    res.json({
        totalAnimes: themesDatabase.size,
        lastUpdated: new Date().toISOString()
    });
});
