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

// Le matching et le tri vivent dans anime-search-core.js (module PARTAGÉ avec
// le serveur — une seule implémentation, chargée avant ce fichier par main.js).

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
    // Saisie BRUTE (le core normalise lui-même) : les espaces portent le
    // découpage en mots du matching multi-mots.
    state.suggestions = filterAnimeEntries(entries, query)
      .map(({ title, englishTitle, seasonNumber }) => ({ title, englishTitle, seasonNumber: seasonNumber || 0 }));
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
