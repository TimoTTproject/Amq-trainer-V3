// Autocomplétion partagée par le quiz solo et le multijoueur.
const animeAutocompleteCache = new Map();
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

function setupAnimeAutocomplete({ inputId, listId, onSubmit }) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  const state = { input, list, suggestions: [], activeIndex: -1, timer: null, request: 0, onSubmit };
  animeAutocompleteStates.set(inputId, state);

  const render = () => {
    if (!state.suggestions.length) return closeAnimeAutocomplete(inputId);
    list.innerHTML = state.suggestions
      .map((suggestion, index) => `<button type="button" class="anime-suggestion${index === state.activeIndex ? ' active' : ''}" role="option" aria-selected="${index === state.activeIndex}" data-anime-index="${index}">
        <span>${escapeHtml(suggestion.title)}</span>
        ${suggestion.englishTitle ? `<small>${escapeHtml(suggestion.englishTitle)}</small>` : ''}
      </button>`)
      .join('');
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    if (state.activeIndex >= 0) list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const choose = (index) => {
    const suggestion = state.suggestions[index];
    if (!suggestion) return;
    // Un synonyme AniList peut ressembler à un titre anglais sans être le nom
    // canonique (par exemple « Banana Chips »). La sélection garde donc le vrai titre.
    input.value = suggestion.title;
    closeAnimeAutocomplete(inputId);
    input.focus();
  };

  const search = async (rawQuery) => {
    const query = rawQuery.trim();
    if (!query) return closeAnimeAutocomplete(inputId);
    const key = query.toLocaleLowerCase();
    const request = ++state.request;
    try {
      let suggestions = animeAutocompleteCache.get(key);
      if (!suggestions) {
        const data = await api(`/api/quiz/series?q=${encodeURIComponent(query)}`);
        suggestions = data.suggestions || (data.series || []).map((title) => ({ title, englishTitle: null }));
        animeAutocompleteCache.set(key, suggestions);
      }
      if (request !== state.request || input.value.trim() !== query || input.disabled) return;
      state.suggestions = suggestions;
      state.activeIndex = -1;
      render();
    } catch {
      closeAnimeAutocomplete(inputId);
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(state.timer);
    const query = input.value;
    if (!query.trim()) return closeAnimeAutocomplete(inputId);
    state.timer = setTimeout(() => search(query), 120);
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
  setupAnimeAutocomplete({ inputId: 'answer-input', listId: 'answer-suggestions', onSubmit: () => guessAnswer() });
  setupAnimeAutocomplete({ inputId: 'mp-input', listId: 'mp-suggestions', onSubmit: () => mpSubmitGuess() });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAnimeAutocompleteUI);
