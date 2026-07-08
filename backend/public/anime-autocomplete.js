// Autocomplétion partagée par le quiz solo et le multijoueur.
// Filtrage 100% côté client : la liste complète (titre + synonymes normalisés)
// est chargée UNE FOIS puis filtrée/triée en JS à chaque frappe — pas d'aller-
// retour réseau par frappe, contrairement à l'ancienne version qui interrogeait
// le serveur à chaque saisie (perceptiblement plus lent sur mauvaise connexion,
// alors qu'AMQ filtre entièrement côté client).
let animeFullListPromise = null;
function loadAnimeFullList() {
  if (!animeFullListPromise) {
    animeFullListPromise = api('/api/quiz/series-all').then((data) => data.entries || []).catch(() => []);
  }
  return animeFullListPromise;
}

// Préférence d'affichage (partagée par tout le quiz) : anglais d'abord (défaut)
// ou japonais/romaji d'abord.
function englishFirst() {
  return typeof settings === 'undefined' || settings.titleLang !== 'jp';
}

// Libellé d'affichage d'un anime : titre choisi selon `englishFirst()`, préfixé
// du numéro de saison (S1/S2…) quand il fait partie d'une chaîne détectée —
// ex. distinguer Kaguya-sama S1/S2 dont les titres romaji ne diffèrent que par
// un « ? ». Le préfixe est purement visuel : ne pas l'inclure dans un texte
// soumis en réponse (le matching se fait sur `title`/`englishTitle` seuls).
function formatAnimeLabel({ title, englishTitle, seasonNumber }) {
  const base = englishFirst() && englishTitle ? englishTitle : title;
  return seasonNumber > 0 ? `S${seasonNumber} · ${base}` : base;
}

function formatAnimeDisplay({ title, englishTitle, seasonNumber }) {
  const primary = formatAnimeLabel({ title, englishTitle, seasonNumber });
  const secondary = englishFirst()
    ? (englishTitle && englishTitle !== title ? title : null)
    : (englishTitle && englishTitle !== title ? englishTitle : null);
  return { primary, secondary };
}

const animeAutocompleteStates = new Map();

function closeAnimeAutocomplete(inputId) {
  const state = animeAutocompleteStates.get(inputId);
  if (!state) return;
  state.request++;
  state.suggestions = [];
  state.activeIndex = -1;
  state.list.innerHTML = '';
  state.list.classList.add('hidden');
  state.input.setAttribute('aria-expanded', 'false');
}

// Normalisation identique au serveur (src/quiz/quiz.routes.js) : minuscules,
// accents retirés, espaces/ponctuation supprimés — « re zero », « rezero » et
// « Re:Zero » deviennent tous « rezero ». DOIT rester synchronisée avec le
// serveur, sinon `searchTitles` (déjà normalisés côté serveur) et `needle` ne
// se compareraient plus.
function animeSearchNormalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Filtre/trie la liste complète en mémoire : même algorithme que le serveur
// (match exact d'abord, puis index le plus tôt, popularité, longueur, alpha).
function filterAnimeEntries(entries, needle) {
  if (!needle) return [];
  const scored = [];
  for (const entry of entries) {
    let matchIndex = -1;
    let matchLen = Number.MAX_SAFE_INTEGER;
    let exact = false;
    for (const title of entry.searchTitles) {
      const index = title.indexOf(needle);
      if (index < 0) continue;
      if (title === needle) exact = true;
      // Le titre matché le plus court l'emporte à index égal : « Magi » doit
      // battre « Magical Girl Site » quand les deux commencent par « magi »,
      // sans quoi la popularité (ci-dessous) fait remonter un titre sans
      // rapport juste parce qu'il partage ce préfixe.
      if (matchIndex < 0 || index < matchIndex || (index === matchIndex && title.length < matchLen)) {
        matchIndex = index;
        matchLen = title.length;
      }
    }
    if (matchIndex < 0) continue;
    // Un match qui tombe pile sur un mot entier (« Magi » dans « Magi: The
    // Labyrinth of Magic ») doit battre un match en plein milieu d'un mot
    // plus long (« magi » dans « Magical Girl Site »), même si ce dernier a
    // un titre plus court ou plus populaire.
    const wholeWord = entry.wordTokens.includes(needle);
    const wordStart = wholeWord || entry.wordTokens.some((t) => t.startsWith(needle));
    scored.push({ entry, matchIndex, matchLen, exact, wholeWord, wordStart });
  }
  scored.sort((a, b) =>
    (b.exact - a.exact) ||
    (b.wholeWord - a.wholeWord) ||
    (b.wordStart - a.wordStart) ||
    a.matchIndex - b.matchIndex ||
    a.matchLen - b.matchLen ||
    // Saisons d'une même chaîne dans l'ordre (S1 avant S2…), avant la popularité.
    (a.entry.seasonNumber || 0) - (b.entry.seasonNumber || 0) ||
    (b.entry.popularity || 0) - (a.entry.popularity || 0) ||
    a.entry.title.length - b.entry.title.length ||
    a.entry.title.localeCompare(b.entry.title));
  return scored.slice(0, 20).map(({ entry }) => ({ title: entry.title, englishTitle: entry.englishTitle, seasonNumber: entry.seasonNumber || 0 }));
}

function setupAnimeAutocomplete({ inputId, listId, onSubmit }) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  const state = { input, list, suggestions: [], activeIndex: -1, timer: null, request: 0, onSubmit };
  animeAutocompleteStates.set(inputId, state);

  const render = () => {
    if (!state.suggestions.length) return closeAnimeAutocomplete(inputId);
    list.innerHTML = state.suggestions
      .map((suggestion, index) => {
        const { primary, secondary } = formatAnimeDisplay(suggestion);
        return `<button type="button" class="anime-suggestion${index === state.activeIndex ? ' active' : ''}" role="option" aria-selected="${index === state.activeIndex}" data-anime-index="${index}">
        <span>${escapeHtml(primary)}</span>
        ${secondary ? `<small>${escapeHtml(secondary)}</small>` : ''}
      </button>`;
      })
      .join('');
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    if (state.activeIndex >= 0) list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const choose = (index) => {
    const suggestion = state.suggestions[index];
    if (!suggestion) return;
    // On remplit avec le titre affiché en premier (anglais si dispo selon la
    // préférence). Le matching accepte aussi bien l'anglais que le romaji.
    input.value = englishFirst() && suggestion.englishTitle ? suggestion.englishTitle : suggestion.title;
    closeAnimeAutocomplete(inputId);
    input.focus();
  };

  const search = async (rawQuery) => {
    const query = rawQuery.trim();
    if (!query) return closeAnimeAutocomplete(inputId);
    const request = ++state.request;
    const entries = await loadAnimeFullList();
    if (request !== state.request || input.value.trim() !== query || input.disabled) return;
    state.suggestions = filterAnimeEntries(entries, animeSearchNormalize(query));
    state.activeIndex = -1;
    render();
  };

  input.addEventListener('input', () => {
    clearTimeout(state.timer);
    const query = input.value;
    if (!query.trim()) return closeAnimeAutocomplete(inputId);
    // Filtrage local (pas de réseau à masquer) : un très léger debounce suffit,
    // juste pour ne pas re-rendre la liste à chaque caractère tapé très vite.
    state.timer = setTimeout(() => search(query), 30);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && state.suggestions.length) {
      event.preventDefault();
      state.activeIndex = (state.activeIndex + 1) % state.suggestions.length;
      render();
    } else if (event.key === 'ArrowUp' && state.suggestions.length) {
      event.preventDefault();
      state.activeIndex = (state.activeIndex - 1 + state.suggestions.length) % state.suggestions.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (state.activeIndex >= 0) choose(state.activeIndex);
      else onSubmit?.();
    } else if (event.key === 'Escape') {
      closeAnimeAutocomplete(inputId);
    }
  });
  input.addEventListener('blur', () => setTimeout(() => closeAnimeAutocomplete(inputId), 120));
  list.addEventListener('mousedown', (event) => {
    const option = event.target.closest('[data-anime-index]');
    if (!option) return;
    event.preventDefault();
    choose(parseInt(option.dataset.animeIndex));
  });
}

function initAnimeAutocompleteUI() {
  loadAnimeFullList(); // préchauffe le cache avant la première frappe
  setupAnimeAutocomplete({ inputId: 'answer-input', listId: 'answer-suggestions', onSubmit: () => guessAnswer() });
  setupAnimeAutocomplete({ inputId: 'mp-input', listId: 'mp-suggestions', onSubmit: () => mpSubmitGuess() });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAnimeAutocompleteUI);
