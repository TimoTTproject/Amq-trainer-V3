// --- VARIABLES GLOBALES POUR LA PERSISTANCE ---
let savedSessions = new Map();
let currentSong = null;
let currentAnswer = null;
let sessionId = null;
let allSongs = [];
let filteredSongs = [];

const API_BASE_URL = 'http://localhost:3000';

// --- VARIABLES GLOBALES POUR LA GESTION MÉDIA ---
let isVideoRevealed = false;
let mediaElement = null;
let mediaType = null; // 'audio', 'video', ou 'youtube'
let lastPlaybackTime = 30;
let lastWasPlaying = false;

// --- VARIABLES GLOBALES POUR LES STATISTIQUES ---
let sessionStats = {
    played: 0,
    correct: 0
};

let globalStats = {
    played: 0,
    correct: 0
};

// --- INITIALISATION CORRIGÉE ---
document.addEventListener('DOMContentLoaded', function() {
    console.log('Script main.js chargé');
    // Initialiser les écouteurs d'événements
    document.getElementById('import-btn').addEventListener('click', importSongs);
    document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
    document.getElementById('btn-easy').addEventListener('click', () => handleFeedback('easy'));
    document.getElementById('btn-hard').addEventListener('click', () => handleFeedback('hard'));
    document.getElementById('btn-again').addEventListener('click', () => handleFeedback('again'));
    document.getElementById('replay-btn').addEventListener('click', replaySong);
    // Gestion du menu statistiques
    const statsMenuBtn = document.getElementById('stats-menu-btn');
    const statsMenuPopup = document.getElementById('stats-menu-popup');
    if (statsMenuBtn && statsMenuPopup) {
        statsMenuBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            statsMenuPopup.style.display = statsMenuPopup.style.display === 'none' ? 'block' : 'none';
            updateStatsDisplay();
        });
        document.addEventListener('click', function(e) {
            if (!statsMenuPopup.contains(e.target) && e.target !== statsMenuBtn) {
                statsMenuPopup.style.display = 'none';
            }
        });
    }
    const resetStatsBtn = document.getElementById('reset-stats-btn');
    if (resetStatsBtn) {
        resetStatsBtn.addEventListener('click', resetGlobalStats);
    }
    // Charger les statistiques globales
    loadGlobalStats();
    // Ajout des écouteurs pour les contrôles vidéo/audio
    document.getElementById('reveal-video-btn').addEventListener('click', revealVideo);
    document.getElementById('hide-video-btn').addEventListener('click', hideVideo);
    document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
    document.getElementById('volume-slider').addEventListener('input', handleVolumeChange);
    // Options popup
    const optionsBtn = document.getElementById('options-btn');
    const optionsPopup = document.getElementById('options-popup');
    const optionsCloseBtn = document.getElementById('options-close-btn');
    const optionVideoDefault = document.getElementById('option-video-default');
    if (optionsBtn && optionsPopup) {
        optionsBtn.addEventListener('click', () => {
            optionsPopup.style.display = 'flex';
        });
    }
    if (optionsCloseBtn && optionsPopup) {
        optionsCloseBtn.addEventListener('click', () => {
            optionsPopup.style.display = 'none';
        });
    }
    if (optionVideoDefault) {
        optionVideoDefault.checked = false;
        optionVideoDefault.addEventListener('change', () => {
            if (optionVideoDefault.checked) {
                revealVideo();
            } else {
                hideVideo();
            }
        });
    }
    // Masquer la barre de progression au démarrage
    const progressOverlay = document.getElementById('progress-overlay');
    if (progressOverlay) progressOverlay.style.display = 'none';
    // Charger les sessions sauvegardées
    loadSessionsFromStorage();
    preventButtonDefaults();
    // Initialiser les options
    initOptions();
    // Charger les notations au démarrage
    loadSongRatings();
    // Initialiser les compteurs de filtre
    const totalCount = document.getElementById('total-count');
    const filterCount = document.getElementById('filter-count');
    if (totalCount && filterCount) {
        totalCount.textContent = allSongs.length;
        filterCount.textContent = allSongs.length;
    }
});

// --- FONCTIONS MANQUANTES ---
function revealAnswer() {
    const correctAnswerElement = document.getElementById('correct-answer');
    const answerTextElement = document.getElementById('answer-text');
    const songTitleElement = document.getElementById('song-title');
    const songArtistElement = document.getElementById('song-artist');
    
    if (currentSong) {
        answerTextElement.textContent = currentSong.anime;
        songTitleElement.textContent = currentSong.title;
        songArtistElement.textContent = currentSong.artist || 'Artiste inconnu';
        correctAnswerElement.classList.remove('hidden');
        
        // Activer les boutons de feedback
        document.getElementById('btn-easy').disabled = false;
        document.getElementById('btn-hard').disabled = false;
        document.getElementById('btn-again').disabled = false;
    }
}

let currentPage = 1;
const songsPerPage = 20;

function updateSongsDisplay() {
    const tableBody = document.getElementById('songs-table-body');
    tableBody.innerHTML = '';
    // Regrouper les chansons par anime
    const songsByAnime = {};
    filteredSongs.forEach(song => {
        if (!songsByAnime[song.anime]) {
            songsByAnime[song.anime] = [];
        }
        songsByAnime[song.anime].push(song);
    });
    // Trier les animes par ordre alphabétique
    const sortedAnimeNames = Object.keys(songsByAnime).sort((a, b) => a.localeCompare(b));
    // Pagination
    const startIdx = (currentPage - 1) * songsPerPage;
    const endIdx = startIdx + songsPerPage;
    const paginatedSongs = filteredSongs.slice(startIdx, endIdx);
    // Regrouper les chansons paginées par anime
    const paginatedByAnime = {};
    paginatedSongs.forEach(song => {
        if (!paginatedByAnime[song.anime]) paginatedByAnime[song.anime] = [];
        paginatedByAnime[song.anime].push(song);
    });
    const paginatedAnimeNames = Object.keys(paginatedByAnime).sort((a, b) => a.localeCompare(b));
    // Ajouter les lignes au tableau
    paginatedAnimeNames.forEach(anime => {
        const separatorRow = document.createElement('tr');
        separatorRow.className = 'anime-separator';
        const separatorCell = document.createElement('td');
        separatorCell.colSpan = 6; // 6 colonnes avec la note
        separatorCell.textContent = anime;
        separatorRow.appendChild(separatorCell);
        tableBody.appendChild(separatorRow);
        paginatedByAnime[anime].forEach(song => {
            const row = document.createElement('tr');
            // Type
            const typeCell = document.createElement('td');
            typeCell.textContent = `${song.type}${song.number || 1}`;
            row.appendChild(typeCell);
            // Titre
            const titleCell = document.createElement('td');
            titleCell.textContent = song.title;
            titleCell.className = 'song-title';
            row.appendChild(titleCell);
            // Artiste
            const artistCell = document.createElement('td');
            artistCell.textContent = song.artist && song.artist.trim() ? song.artist : 'Inconnu';
            artistCell.className = 'artist';
            row.appendChild(artistCell);
            // Réussite
            const rateCell = document.createElement('td');
            const total = (song.easyCount || 0) + (song.hardCount || 0) + (song.againCount || 0);
            const successRate = total > 0 ? Math.round(((song.easyCount || 0) / total) * 100) : 0;
            rateCell.textContent = `${successRate}%`;
            rateCell.className = 'success-rate';
            rateCell.style.setProperty('--success-width', `${successRate}%`);
            row.appendChild(rateCell);
            // Note
            const ratingCell = document.createElement('td');
            ratingCell.className = 'song-rating';
            const songKey = getSongKey(song);
            const rating = songRatings[songKey] || 0;
            for (let i = 1; i <= 5; i++) {
                const star = document.createElement('span');
                star.className = 'rating-star';
                star.innerHTML = i <= rating ? '★' : '☆';
                star.style.cursor = 'pointer';
                star.style.color = i <= rating ? '#ffd700' : '#ccc';
                star.addEventListener('click', () => rateSong(song, i));
                ratingCell.appendChild(star);
            }
            row.appendChild(ratingCell);
            // Action (bouton play)
            const actionCell = document.createElement('td');
            const playButton = document.createElement('button');
            playButton.className = 'play-btn';
            playButton.innerHTML = '<i class="fas fa-play"></i>';
            playButton.addEventListener('click', () => playSong(song));
            actionCell.appendChild(playButton);
            row.appendChild(actionCell);
            tableBody.appendChild(row);
        });
    });
    updatePagination();
}

function updatePagination() {
    const containers = [
        document.getElementById('pagination-container'),
        document.getElementById('pagination-container-top')
    ];
    const totalPages = Math.ceil(filteredSongs.length / songsPerPage);
    containers.forEach(container => {
        if (!container) return;
        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }
        let html = '';
        // Bouton Première page
        if (currentPage > 1) {
            html += `<button class='pagination-btn' onclick="changePage(1)">Première page</button>`;
        }
        // Bouton Précédent
        if (currentPage > 1) {
            html += `<button class='pagination-btn' onclick="changePage(${currentPage - 1})">Précédent</button>`;
        }
        // Indicateur de page
        html += `<div>Page ${currentPage} / ${totalPages}</div>`;
        // Bouton Suivant
        if (currentPage < totalPages) {
            html += `<button class='pagination-btn' onclick="changePage(${currentPage + 1})">Suivant</button>`;
        }
        // Bouton Dernière page
        if (currentPage < totalPages) {
            html += `<button class='pagination-btn' onclick="changePage(${totalPages})">Dernière page</button>`;
        }
        container.innerHTML = html;
    });
}

function changePage(page) {
    currentPage = page;
    updateSongsDisplay();
    updatePagination();
}

function filterSongs() {
    const filterValue = document.getElementById('anime-filter').value.trim().toLowerCase();
    const clearButton = document.getElementById('clear-filter-btn');
    const filterInfo = document.getElementById('filter-info');
    const filterCount = document.getElementById('filter-count');
    const totalCount = document.getElementById('total-count');
    // Afficher ou masquer le bouton d'effacement et le compteur
    if (clearButton) {
        if (filterValue.length > 0) {
            clearButton.style.display = 'block';
            if (filterInfo) filterInfo.style.display = 'block';
        } else {
            clearButton.style.display = 'none';
            if (filterInfo) filterInfo.style.display = 'none';
        }
    }
    if (filterValue === '') {
        filteredSongs = [...allSongs];
    } else {
        filteredSongs = allSongs.filter(song => 
            (song.anime && song.anime.toLowerCase().includes(filterValue)) ||
            (song.title && song.title.toLowerCase().includes(filterValue)) ||
            (song.artist && song.artist.toLowerCase().includes(filterValue))
        );
    }
    // Mettre à jour le compteur
    if (filterCount) filterCount.textContent = filteredSongs.length;
    if (totalCount) totalCount.textContent = allSongs.length;
    currentPage = 1;
    updateSongsDisplay();
}

function clearFilter() {
    document.getElementById('anime-filter').value = '';
    filterSongs();
}

// Gestion de la touche Echap pour effacer le filtre
if (document.getElementById('anime-filter')) {
    document.getElementById('anime-filter').addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            clearFilter();
            this.blur();
        }
    });
}

function selectRandomSong() {
    if (allSongs.length === 0) return;
    
    const randomIndex = Math.floor(Math.random() * allSongs.length);
    currentSong = allSongs[randomIndex];
    currentAnswer = currentSong.anime;
    
    // Réinitialiser l'interface
    document.getElementById('answer-input').value = '';
    document.getElementById('correct-answer').classList.add('hidden');
    document.getElementById('btn-easy').disabled = true;
    document.getElementById('btn-hard').disabled = true;
    document.getElementById('btn-again').disabled = true;
    
    // Jouer la chanson
    playSong(currentSong);
}

// Remplacer la fonction playSong pour une meilleure gestion des médias
function playSong(song) {
    currentSong = song;
    // Arrêter le média actuel proprement
    if (mediaElement) {
        const wasPlaying = !mediaElement.paused;
        const currentTime = mediaElement.currentTime;
        mediaElement.pause();
        mediaElement.removeEventListener('timeupdate', handleTimeUpdate);
        mediaElement = null;
    }
    const mediaWrapper = document.getElementById('media-wrapper');
    mediaWrapper.innerHTML = '';
    // Précharger la vidéo en arrière-plan
    const videoPreload = document.createElement('video');
    videoPreload.src = song.videoUrl;
    videoPreload.preload = 'auto';
    videoPreload.style.display = 'none';
    document.body.appendChild(videoPreload);
    // Créer l'élément média principal
    if (isVideoRevealed || document.getElementById('option-video-default').checked) {
        createVideoPlayer(song);
    } else {
        createAudioPlayer(song);
    }
    // Mettre à jour l'affichage de la notation
    const songKey = getSongKey(song);
    const rating = songRatings[songKey] || 0;
    updateRatingDisplay(rating);
}

function createVideoPlayer(song) {
    const mediaWrapper = document.getElementById('media-wrapper');
    mediaElement = document.createElement('video');
    mediaElement.id = 'media-player';
    mediaElement.controls = false;
    mediaElement.muted = false;
    mediaType = 'video';
    const source = document.createElement('source');
    source.src = song.videoUrl;
    source.type = 'video/mp4';
    mediaElement.appendChild(source);
    mediaWrapper.appendChild(mediaElement);
    // Configurer les événements
    setupMediaEvents();
    updateVideoButton();
}

function createAudioPlayer(song) {
    const mediaWrapper = document.getElementById('media-wrapper');
    const audioPlaceholder = document.createElement('div');
    audioPlaceholder.id = 'audio-placeholder';
    audioPlaceholder.className = 'audio-placeholder';
    audioPlaceholder.innerHTML = '<i class="fas fa-music"></i>';
    mediaWrapper.appendChild(audioPlaceholder);
    // Créer l'audio en arrière-plan
    mediaElement = document.createElement('audio');
    mediaElement.id = 'media-player';
    mediaElement.src = song.videoUrl;
    mediaElement.controls = false;
    mediaElement.style.display = 'none';
    mediaType = 'audio';
    mediaWrapper.appendChild(mediaElement);
    // Configurer les événements
    setupMediaEvents();
    updateVideoButton();
}

function setupMediaEvents() {
    mediaElement.addEventListener('loadedmetadata', function() {
        mediaElement.currentTime = Math.min(mediaElement.duration - 10, 30);
        mediaElement.play().catch(e => console.log("Erreur lecture:", e));
    });
    // Remplacer le timeupdate brutal par une boucle douce
    mediaElement.addEventListener('timeupdate', handleTimeUpdate);
    mediaElement.addEventListener('play', updatePlayPauseButton);
    mediaElement.addEventListener('pause', updatePlayPauseButton);
    mediaElement.volume = document.getElementById('volume-slider').value;
}

function handleTimeUpdate() {
    // Boucle douce sans saut brutal
    if (mediaElement.currentTime > 85) { // 5 secondes avant la fin pour une transition fluide
        mediaElement.currentTime = 30;
        if (!mediaElement.paused) {
            mediaElement.play().catch(e => console.log("Erreur reprise:", e));
        }
    }
}

function retryMedia() {
    if (currentSong) {
        playSong(currentSong);
    }
}

function loadSessionsFromStorage() {
    const saved = localStorage.getItem('amq-sessions');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            // Gestion de différents formats de données
            if (Array.isArray(data)) {
                // Format: tableau d'objets session
                data.forEach(session => {
                    if (session.id && session.songs) {
                        savedSessions.set(session.id, session);
                    }
                });
            } else if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
                // Format: Map sérialisée [key, value]
                data.forEach(([id, session]) => {
                    if (id && session && session.songs) {
                        savedSessions.set(id, session);
                    }
                });
            } else if (typeof data === 'object' && data !== null) {
                // Format: objet avec IDs comme clés
                Object.entries(data).forEach(([id, session]) => {
                    if (id && session && session.songs) {
                        savedSessions.set(id, session);
                    }
                });
            }
            updateSessionsMenu();
        } catch (e) {
            console.error('Erreur chargement sessions:', e);
            // En cas d'erreur, nettoyer les données corrompues
            localStorage.removeItem('amq-sessions');
            savedSessions.clear();
        }
    }
}

function updateSessionsMenu() {
    const sessionsList = document.getElementById('saved-sessions-list');
    if (!sessionsList) return;
    sessionsList.innerHTML = '';
    savedSessions.forEach((session, id) => {
        const sessionItem = document.createElement('div');
        sessionItem.className = 'session-item';
        sessionItem.innerHTML = `
            <div>
                <h4>${session.username}</h4>
                <p>${session.songs.length} chansons</p>
            </div>
            <button onclick="loadSession('${id}')">Charger</button>
        `;
        sessionsList.appendChild(sessionItem);
    });
}

function loadSession(sessionId) {
    const session = savedSessions.get(sessionId);
    if (session) {
        allSongs = session.songs;
        filteredSongs = [...allSongs];
        sessionId = sessionId;
        updateSongsDisplay();
        document.getElementById('answer-input').disabled = false;
        document.getElementById('reveal-btn').disabled = false;
        document.getElementById('replay-btn').classList.remove('hidden');
        if (allSongs.length > 0) {
            setTimeout(selectRandomSong, 500);
        }
    }
}

function clearAllSessions() {
    if (confirm('Êtes-vous sûr de vouloir supprimer toutes les sessions sauvegardées ?')) {
        savedSessions.clear();
        localStorage.removeItem('amq-sessions');
        updateSessionsMenu();
    }
}

function preventButtonDefaults() {
    // Empêcher le comportement par défaut des boutons
    document.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', e => {
            if (btn.type !== 'submit') {
                e.preventDefault();
            }
        });
    });
}


function smoothShow(element) {
    element.style.display = 'block';
    setTimeout(() => {
        element.style.opacity = '1';
        element.style.transform = 'translateY(0)';
    }, 10);
}

function smoothHide(element) {
    element.style.opacity = '0';
    element.style.transform = 'translateY(20px)';
    setTimeout(() => {
        element.style.display = 'none';
    }, 300);
}

function showProgressOverlay() {
    const overlay = document.getElementById('progress-overlay');
    if (overlay) smoothShow(overlay);
}
function hideProgressOverlay(force) {
    const overlay = document.getElementById('progress-overlay');
    if (overlay) {
        if (force) {
            overlay.style.display = 'none';
            overlay.style.opacity = '0';
            overlay.style.transform = 'translateY(20px)';
        } else {
            smoothHide(overlay);
        }
    }
}
function showOptionsPopup() {
    const popup = document.getElementById('options-popup');
    if (popup) smoothShow(popup);
}
function hideOptionsPopup() {
    const popup = document.getElementById('options-popup');
    if (popup) smoothHide(popup);
}

function hideProgressOverlay(force = false) {
    const progressOverlay = document.getElementById('progress-overlay');
    if (progressOverlay) {
        progressOverlay.style.opacity = '0';
        if (force) {
            progressOverlay.style.display = 'none';
        } else {
            setTimeout(() => {
                progressOverlay.style.display = 'none';
            }, 500);
        }
    }
}

// --- FONCTIONS DE CONTRÔLE MÉDIA ---
function updateVideoButton() {
    const revealBtn = document.getElementById('reveal-video-btn');
    const hideBtn = document.getElementById('hide-video-btn');
    
    if (isVideoRevealed) {
        revealBtn.style.display = 'none';
        hideBtn.style.display = 'inline-block';
    } else {
        revealBtn.style.display = 'inline-block';
        hideBtn.style.display = 'none';
    }
}

function updatePlayPauseButton() {
    const playPauseBtn = document.getElementById('play-pause-btn');
    
    if (mediaElement && !mediaElement.paused) {
        playPauseBtn.innerHTML = '<i class="fas fa-pause"></i> Pause';
    } else {
        playPauseBtn.innerHTML = '<i class="fas fa-play"></i> Lecture';
    }
}

function togglePlayPause() {
    if (mediaElement) {
        if (mediaElement.paused) {
            mediaElement.play().catch(e => {
                console.log("Erreur lecture:", e);
            });
        } else {
            mediaElement.pause();
        }
        updatePlayPauseButton();
    }
}

function handleVolumeChange() {
    if (mediaElement) {
        mediaElement.volume = document.getElementById('volume-slider').value;
    }
}

// --- FONCTIONS PRINCIPALES ---
async function importSongs() {
    const anilistUsernameInput = document.getElementById('anilist-username');
    const importLimitInput = document.getElementById('import-limit');
    const username = anilistUsernameInput.value.trim();
    const limit = parseInt(importLimitInput.value) || 50;
    
    if (!username) {
        alert('Veuillez entrer votre nom d\'utilisateur AniList');
        return;
    }

    console.log('Début de l\'import pour:', username);

    const progressOverlay = document.getElementById('progress-overlay');
    const progressFill = document.getElementById('progress-fill');    
    const progressPercentage = document.getElementById('progress-percentage');
    const progressCurrent = document.getElementById('progress-current');
    const progressStatus = document.getElementById('progress-status');
    const statOps = document.getElementById('stat-ops');
    const statMatched = document.getElementById('stat-matched');
    const statTotal = document.getElementById('stat-total');

    // Afficher la barre de progression
    progressOverlay.style.display = 'flex';
    setTimeout(() => {
        progressOverlay.style.opacity = '1';
    }, 100);

    // Réinitialiser les éléments
    progressFill.style.width = '0%';
    progressPercentage.textContent = '0%';
    progressCurrent.textContent = '0/0 anime traités';
    progressStatus.textContent = 'Connexion au serveur...';
    statOps.textContent = '0';
    statMatched.textContent = '0';
    statTotal.textContent = '0';

    try {
        const eventSource = new EventSource(`${API_BASE_URL}/api/import-songs-progress?username=${encodeURIComponent(username)}&limit=${limit}`);

        eventSource.onmessage = function(event) {
            try {
                if (!event.data) return;
                
                if (event.data.startsWith(':')) {
                    return;
                }

                const data = JSON.parse(event.data);

                if (data.error) {
                    eventSource.close();
                    hideProgressOverlay();
                    alert('Erreur import: ' + data.error);
                    return;
                }

                if (data.completed) {
                    eventSource.close();
                    
                    setTimeout(() => {
                        allSongs = data.songs || [];
                        filteredSongs = [...allSongs];
                        sessionId = data.sessionId;
                        
                        // Sauvegarder la session
                        savedSessions.set(sessionId, {
                            id: sessionId,
                            username: username,
                            songs: allSongs,
                            importDate: new Date().toISOString()
                        });
                        // Sauvegarde universelle : tableau d'objets session
                        localStorage.setItem('amq-sessions', JSON.stringify(Array.from(savedSessions.values())));
                        
                        updateSongsDisplay();
                        updateSessionsMenu();
                        
                        document.getElementById('answer-input').disabled = false;
                        document.getElementById('reveal-btn').disabled = false;
                        document.getElementById('replay-btn').classList.remove('hidden');
                        
                        if (allSongs.length === 0) {
                            const videoContainer = document.querySelector('.video-container');
                            if (videoContainer) {
                                videoContainer.innerHTML = `
                                    <div class="video-placeholder">
                                        <div>
                                            <i class="fas fa-exclamation-triangle"></i>
                                            <p>Aucune opening importée.</p>
                                        </div>
                                    </div>
                                `;
                            }
                        } else {
                            setTimeout(selectRandomSong, 500);
                        }
                        
                        hideProgressOverlay();
                    }, 300);
                    return;
                }

                // Mise à jour de la progression
                if (data.progress !== undefined) {
                    progressFill.style.transition = 'width 0.3s ease';
                    progressFill.style.width = `${data.progress}%`;
                    progressPercentage.textContent = `${data.progress}%`;
                }
                
                if (data.message) {
                    progressStatus.textContent = data.message;
                }
                
                if (data.current !== undefined && data.total !== undefined) {
                    progressCurrent.textContent = `${data.current}/${data.total} anime traités`;
                }
                
                if (data.totalOpenings !== undefined) {
                    statOps.textContent = data.totalOpenings;
                }
                if (data.matchedAnime !== undefined) {
                    statMatched.textContent = data.matchedAnime;
                }
                if (data.totalSongs !== undefined) {
                    statTotal.textContent = data.totalSongs;
                }

            } catch (err) {
                console.error('Erreur de traitement SSE:', err);
            }
        };

        eventSource.onerror = function(err) {
            console.error('Erreur SSE:', err);
            hideProgressOverlay();
            eventSource.close();
            alert('Erreur de connexion avec le serveur.');
        };

        setTimeout(() => {
            if (eventSource.readyState !== EventSource.CLOSED) {
                eventSource.close();
                hideProgressOverlay();
                alert('Import terminé (timeout). Les données peuvent être incomplètes.');
            }
        }, 1200000);

    } catch (error) {
        handleImportError(error);
    }
}

function replaySong() {
    if (currentSong) {
        playSong(currentSong);
    }
}

// --- FONCTIONS DE GESTION VIDÉO AMÉLIORÉES ---
function revealVideo(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    if (isVideoRevealed || !currentSong) return;
    const currentTime = mediaElement ? mediaElement.currentTime : 30;
    const wasPlaying = mediaElement ? !mediaElement.paused : false;
    isVideoRevealed = true;
    const mediaWrapper = document.getElementById('media-wrapper');
    mediaWrapper.innerHTML = '';
    mediaElement = document.createElement('video');
    mediaElement.id = 'media-player';
    mediaElement.controls = false;
    mediaElement.muted = false;
    mediaType = 'video';
    const source = document.createElement('source');
    source.src = currentSong.videoUrl;
    source.type = 'video/mp4';
    mediaElement.appendChild(source);
    mediaElement.addEventListener('error', function() {
        mediaWrapper.innerHTML = `<div class='video-placeholder'><div><i class='fas fa-exclamation-triangle'></i><p>Vidéo non supportée ou introuvable</p></div></div>`;
    });
    mediaElement.addEventListener('loadedmetadata', function() {
        mediaElement.currentTime = currentTime;
        if (wasPlaying) {
            mediaElement.play().catch(e => {
                console.log("Erreur lecture vidéo:", e);
            });
        }
        updatePlayPauseButton();
    });
    mediaElement.addEventListener('timeupdate', function() {
        if (mediaElement.currentTime > 90) {
            mediaElement.currentTime = 30;
        }
    });
    mediaElement.addEventListener('play', updatePlayPauseButton);
    mediaElement.addEventListener('pause', updatePlayPauseButton);
    mediaElement.volume = document.getElementById('volume-slider').value;
    mediaWrapper.appendChild(mediaElement);
    updateVideoButton();
}

function hideVideo(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    if (!isVideoRevealed || !currentSong) return;
    const currentTime = mediaElement ? mediaElement.currentTime : 30;
    const wasPlaying = mediaElement ? !mediaElement.paused : false;
    isVideoRevealed = false;
    const mediaWrapper = document.getElementById('media-wrapper');
    mediaWrapper.innerHTML = '';
    const audioPlaceholder = document.createElement('div');
    audioPlaceholder.id = 'audio-placeholder';
    audioPlaceholder.className = 'audio-placeholder';
    audioPlaceholder.innerHTML = '<i class="fas fa-music"></i>';
    mediaWrapper.appendChild(audioPlaceholder);
    mediaElement = document.createElement('audio');
    mediaElement.id = 'media-player';
    mediaElement.src = currentSong.videoUrl;
    mediaElement.controls = false;
    mediaElement.style.display = 'none';
    mediaType = 'audio';
    mediaElement.addEventListener('error', function() {
        mediaWrapper.innerHTML = `
            <div class='video-placeholder'>
                <div>
                    <i class='fas fa-exclamation-triangle'></i>
                    <p>Audio non supporté ou introuvable</p>
                </div>
            </div>
        `;
    });
    mediaElement.addEventListener('loadedmetadata', function() {
        mediaElement.currentTime = currentTime;
        if (wasPlaying) {
            mediaElement.play().catch(e => {
                console.log("Erreur lecture audio:", e);
            });
        }
        updatePlayPauseButton();
    });
    mediaElement.addEventListener('timeupdate', function() {
        if (mediaElement.currentTime > 90) {
            mediaElement.currentTime = 30;
        }
    });
    mediaElement.addEventListener('play', updatePlayPauseButton);
    mediaElement.addEventListener('pause', updatePlayPauseButton);
    mediaElement.volume = document.getElementById('volume-slider').value;
    mediaWrapper.appendChild(mediaElement);
    updateVideoButton();
}

function reloadMedia() {
    if (!currentSong) return;
    if (mediaElement) {
        lastPlaybackTime = mediaElement.currentTime;
        lastWasPlaying = !mediaElement.paused;
        mediaElement.pause();
        mediaElement.remove();
        mediaElement = null;
    }
    playSong(currentSong);
}

// --- FONCTIONS DE GESTION DES STATISTIQUES ---
function loadGlobalStats() {
    const savedStats = localStorage.getItem('amq-global-stats');
    if (savedStats) {
        try {
            globalStats = JSON.parse(savedStats);
        } catch (e) {
            console.error('Erreur chargement stats:', e);
            globalStats = { played: 0, correct: 0 };
        }
    }
}

function saveGlobalStats() {
    localStorage.setItem('amq-global-stats', JSON.stringify(globalStats));
}

function updateStatsDisplay() {
    // Mettre à jour les stats de session
    document.getElementById('stat-session-played').textContent = sessionStats.played;
    document.getElementById('stat-session-correct').textContent = sessionStats.correct;
    const sessionRate = sessionStats.played > 0 ? Math.round((sessionStats.correct / sessionStats.played) * 100) : 0;
    document.getElementById('stat-session-rate').textContent = `${sessionRate}%`;
    // Mettre à jour les stats globales
    document.getElementById('stat-total-played').textContent = globalStats.played;
    document.getElementById('stat-total-correct').textContent = globalStats.correct;
    const totalRate = globalStats.played > 0 ? Math.round((globalStats.correct / globalStats.played) * 100) : 0;
    document.getElementById('stat-total-rate').textContent = `${totalRate}%`;
}

function resetGlobalStats() {
    if (confirm('Êtes-vous sûr de vouloir réinitialiser toutes les statistiques globales ?')) {
        globalStats = { played: 0, correct: 0 };
        saveGlobalStats();
        updateStatsDisplay();
    }
}

// Modifier la fonction handleFeedback pour mettre à jour les statistiques
function handleFeedback(feedbackType) {
    if (!currentSong || !sessionId) return;
    // Mettre à jour les statistiques
    sessionStats.played++;
    globalStats.played++;
    if (feedbackType === 'easy') {
        sessionStats.correct++;
        globalStats.correct++;
    }
    // Sauvegarder les stats globales
    saveGlobalStats();
    fetch(`${API_BASE_URL}/api/quiz/feedback/${sessionId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            anime: currentSong.anime,
            type: currentSong.type,
            number: currentSong.number,
            feedbackType: feedbackType
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            const songIndex = allSongs.findIndex(s => 
                s.anime === currentSong.anime && 
                s.type === currentSong.type && 
                s.number === currentSong.number
            );
            if (songIndex !== -1 && allSongs[songIndex]) {
                if (!allSongs[songIndex].easyCount) allSongs[songIndex].easyCount = 0;
                if (!allSongs[songIndex].hardCount) allSongs[songIndex].hardCount = 0;
                if (!allSongs[songIndex].againCount) allSongs[songIndex].againCount = 0;
                if (feedbackType === 'easy') {
                    allSongs[songIndex].easyCount++;
                } else if (feedbackType === 'hard') {
                    allSongs[songIndex].hardCount++;
                } else if (feedbackType === 'again') {
                    allSongs[songIndex].againCount++;
                }
                updateSongsDisplay();
            }
            setTimeout(selectRandomSong, 1000);
        }
    })
    .catch(error => {
        console.error('Erreur envoi feedback:', error);
        setTimeout(selectRandomSong, 1000);
    });
}

// --- VARIABLES GLOBALES POUR LA NOTATION ---
let songRatings = {};

// --- FONCTIONS DE NOTATION CORRIGÉES ---
function loadSongRatings() {
    const savedRatings = localStorage.getItem('amq-song-ratings');
    if (savedRatings) {
        try {
            songRatings = JSON.parse(savedRatings);
        } catch (e) {
            console.error('Erreur chargement notations:', e);
            songRatings = {};
        }
    }
}

function saveSongRatings() {
    localStorage.setItem('amq-song-ratings', JSON.stringify(songRatings));
}

function getSongKey(song) {
    return `${song.anime}|${song.type}|${song.number}|${song.title}`;
}

function rateSong(song, rating) {
    const songKey = getSongKey(song);
    songRatings[songKey] = rating;
    saveSongRatings();
    if (currentSong && getSongKey(currentSong) === songKey) {
        updateRatingDisplay(rating);
    }
    updateSongsDisplay();
}

function updateRatingDisplay(rating) {
    const ratingContainer = document.getElementById('current-rating');
    if (!ratingContainer) return;
    ratingContainer.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
        const star = document.createElement('span');
        star.className = 'rating-star';
        star.innerHTML = i <= rating ? '★' : '☆';
        star.style.cursor = 'pointer';
        star.style.color = i <= rating ? '#ffd700' : '#ccc';
        star.style.fontSize = '1.5rem';
        star.style.margin = '0 2px';
        star.addEventListener('click', () => rateSong(currentSong, i));
        ratingContainer.appendChild(star);
    }
}

// --- OPTIONS UTILISATEUR ---
function initOptions() {
    // Charger les options sauvegardées
    loadOptions();
    
    // Écouteurs pour les options
    document.getElementById('options-save').addEventListener('click', saveOptions);
    document.getElementById('options-reset').addEventListener('click', resetOptions);
    document.getElementById('option-default-volume').addEventListener('input', function() {
        document.getElementById('volume-value').textContent = this.value + '%';
    });
}

function loadOptions() {
    const options = JSON.parse(localStorage.getItem('amq-options')) || {};
    
    // Valeurs par défaut
    const defaultOptions = {
        videoDefault: false,
        autoplay: true,
        startTime: 30,
        quizDelay: 1000,
        autoNext: false,
        theme: 'dark',
        itemsPerPage: 20,
        defaultVolume: 80
    };
    
    const mergedOptions = {...defaultOptions, ...options};
    
    // Appliquer les options aux éléments UI
    document.getElementById('option-video-default').checked = mergedOptions.videoDefault;
    document.getElementById('option-autoplay').checked = mergedOptions.autoplay;
    document.getElementById('option-start-time').value = mergedOptions.startTime;
    document.getElementById('option-quiz-delay').value = mergedOptions.quizDelay;
    document.getElementById('option-auto-next').checked = mergedOptions.autoNext;
    document.getElementById('option-theme').value = mergedOptions.theme;
    document.getElementById('option-items-per-page').value = mergedOptions.itemsPerPage;
    document.getElementById('option-default-volume').value = mergedOptions.defaultVolume;
    document.getElementById('volume-value').textContent = mergedOptions.defaultVolume + '%';
    
    // Appliquer le thème
    applyTheme(mergedOptions.theme);
    
    return mergedOptions;
}

function saveOptions() {
    const options = {
        videoDefault: document.getElementById('option-video-default').checked,
        autoplay: document.getElementById('option-autoplay').checked,
        startTime: parseInt(document.getElementById('option-start-time').value),
        quizDelay: parseInt(document.getElementById('option-quiz-delay').value),
        autoNext: document.getElementById('option-auto-next').checked,
        theme: document.getElementById('option-theme').value,
        itemsPerPage: parseInt(document.getElementById('option-items-per-page').value),
        defaultVolume: parseInt(document.getElementById('option-default-volume').value)
    };
    
    localStorage.setItem('amq-options', JSON.stringify(options));
    
    // Appliquer les changements immédiats
    applyTheme(options.theme);
    songsPerPage = options.itemsPerPage;
    updateSongsDisplay();
    
    // Fermer le popup
    hideOptionsPopup();
    
    alert('Options enregistrées avec succès!');
}

function resetOptions() {
    if (confirm('Êtes-vous sûr de vouloir réinitialiser toutes les options aux valeurs par défaut ?')) {
        localStorage.removeItem('amq-options');
        loadOptions();
    }
}

function applyTheme(theme) {
    document.body.classList.remove('theme-dark', 'theme-light', 'theme-blue');
    document.body.classList.add('theme-' + theme);
}