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

// Le titre porte-t-il déjà son propre ordinal (« Fourth Stage », « 2nd
// Season », « Part 2 », « III »…) ? Dans ce cas le préfixe S# n'apporte rien
// et peut même le contredire : le S# compte les saisons TV de la chaîne
// AniList, alors que le nom officiel compte parfois aussi les films (Initial D
// Third Stage est un film → Fourth Stage serait affiché « S3 »). Volontairement
// conservateur : v/x seuls et les nombres non finaux (Mob Psycho 100) ne
// déclenchent pas, pour ne pas masquer le préfixe des titres quasi identiques
// (Kaguya-sama S1/S2) qui en ont vraiment besoin.
function titleHasOwnOrdinal(base) {
  return /\b(?:season|saison)\s*\d|\b\d(?:st|nd|rd|th)\s*(?:season|saison)\b|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|final)\s+(?:season|saison|stage|part|act|arc|chapter)\b|\bpart\s+(?:\d+|[ivx]+)\b|\b(?:ii|iii|iv|vi|vii|viii|ix)\b|\s[2-9]$/i.test(base || '');
}

// Libellé d'affichage d'un anime : titre choisi selon `englishFirst()`, préfixé
// du numéro de saison (S1/S2…) quand il fait partie d'une chaîne détectée —
// ex. distinguer Kaguya-sama S1/S2 dont les titres romaji ne diffèrent que par
// un « ? » — sauf si le titre contient déjà son propre ordinal. Le préfixe est
// purement visuel : ne pas l'inclure dans un texte soumis en réponse (le
// matching se fait sur `title`/`englishTitle` seuls).
function formatAnimeLabel({ title, englishTitle, seasonNumber }) {
  const base = englishFirst() && englishTitle ? englishTitle : title;
  return seasonNumber > 0 && !titleHasOwnOrdinal(base) ? `S${seasonNumber} · ${base}` : base;
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

// HTML d'un texte avec la partie qui matche la saisie enveloppée de <mark>
// (plages calculées par le core sur la chaîne brute, tout est échappé).
function highlightAnimeHtml(raw, rawQuery) {
  const ranges = animeSearchHighlightRanges(raw, rawQuery);
  let html = '';
  let pos = 0;
  for (const { start, end } of ranges) {
    html += `${escapeHtml(raw.slice(pos, start))}<mark>${escapeHtml(raw.slice(start, end))}</mark>`;
    pos = end;
  }
  return html + escapeHtml(raw.slice(pos));
}

// Repositionne la liste de suggestions pour qu'elle reste ENTIÈREMENT visible
// dans la fenêtre, sans avoir à scroller la page — y compris quand le champ de
// réponse est bas dans le viewport (mise en page verticale, petit écran). Par
// défaut la liste s'ouvre sous le champ ; si la place manque en dessous mais
// qu'il y en a davantage au-dessus, elle s'ouvre vers le haut à la place. Dans
// les deux cas sa hauteur max est bornée à l'espace réellement disponible.
function positionAnimeSuggestions(input, list) {
  const MARGIN = 8;
  const rect = input.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
  const spaceAbove = rect.top - MARGIN;
  const preferredMax = 320; // cf. styles.css .anime-suggestions
  const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
  list.classList.toggle('suggestions-up', openUp);
  const available = openUp ? spaceAbove : spaceBelow;
  list.style.maxHeight = Math.max(120, Math.min(preferredMax, available)) + 'px';
}

function setupAnimeAutocomplete({ inputId, listId, onSubmit }) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  const state = { input, list, suggestions: [], activeIndex: -1, timer: null, request: 0, onSubmit };
  animeAutocompleteStates.set(inputId, state);

  const render = (query) => {
    if (!state.suggestions.length) return closeAnimeAutocomplete(inputId);
    list.innerHTML = state.suggestions
      .map(({ entry, matchedTitle, matchedAcronym }, index) => {
        const { primary, secondary } = formatAnimeDisplay(entry);
        // Explique le match quand il vient d'ailleurs que des titres affichés :
        // acronyme (« ≈ AOT ») ou synonyme (« ≈ Demon Slayer »).
        let via = null;
        if (matchedAcronym) via = `≈ ${escapeHtml(matchedAcronym.toUpperCase())}`;
        else if (matchedTitle && matchedTitle !== entry.title && matchedTitle !== entry.englishTitle) {
          via = `≈ ${highlightAnimeHtml(matchedTitle, query)}`;
        }
        // Le préfixe S1/S2 est purement visuel (et pas toujours présent, cf.
        // titleHasOwnOrdinal) : on surligne seulement le titre, dérivé par
        // longueur pour rester juste quel que soit le choix du libellé.
        const base = englishFirst() && entry.englishTitle ? entry.englishTitle : entry.title;
        const seasonPrefix = primary.length > base.length ? primary.slice(0, primary.length - base.length) : '';
        const primaryBase = primary.slice(seasonPrefix.length);
        return `<button type="button" class="anime-suggestion" role="option" aria-selected="false" data-anime-index="${index}">
        <span class="anime-suggestion-body">
          <span class="anime-suggestion-title">${escapeHtml(seasonPrefix)}${highlightAnimeHtml(primaryBase, query)}</span>
          ${secondary ? `<small>${highlightAnimeHtml(secondary, query)}</small>` : ''}
          ${via ? `<small class="anime-suggestion-via">${via}</small>` : ''}
        </span>
      </button>`;
      })
      .join('');
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    positionAnimeSuggestions(input, list);
  };

  // Déplace le surlignage clavier SANS reconstruire la liste (pas de flash,
  // l'état hover/scroll est préservé).
  const setActive = (index) => {
    state.activeIndex = index;
    list.querySelectorAll('.anime-suggestion').forEach((el, i) => {
      el.classList.toggle('active', i === index);
      el.setAttribute('aria-selected', String(i === index));
    });
    if (index >= 0) list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const choose = (index) => {
    const suggestion = state.suggestions[index];
    if (!suggestion) return;
    // On remplit avec le titre affiché en premier (anglais si dispo selon la
    // préférence). Le matching accepte aussi bien l'anglais que le romaji.
    input.value = englishFirst() && suggestion.entry.englishTitle ? suggestion.entry.englishTitle : suggestion.entry.title;
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
    state.suggestions = filterAnimeEntries(entries, query);
    state.activeIndex = -1;
    render(query);
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
      setActive((state.activeIndex + 1) % state.suggestions.length);
    } else if (event.key === 'ArrowUp' && state.suggestions.length) {
      event.preventDefault();
      setActive((state.activeIndex - 1 + state.suggestions.length) % state.suggestions.length);
    } else if (event.key === 'Tab' && !event.shiftKey && state.suggestions.length) {
      // Tab complète la suggestion active (ou la première) SANS soumettre —
      // le réflexe AMQ : trois lettres, Tab, Entrée.
      event.preventDefault();
      choose(state.activeIndex >= 0 ? state.activeIndex : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (state.activeIndex >= 0) choose(state.activeIndex);
      else onSubmit?.();
    } else if (event.key === 'Escape') {
      closeAnimeAutocomplete(inputId);
    }
  });
  input.addEventListener('blur', () => setTimeout(() => closeAnimeAutocomplete(inputId), 120));
  // Reflow (rotation d'écran, clavier virtuel qui s'ouvre/se ferme sur mobile,
  // options de la manche qu'on déplie…) : la place disponible peut changer
  // pendant que la liste est ouverte.
  window.addEventListener('resize', () => {
    if (!list.classList.contains('hidden')) positionAnimeSuggestions(input, list);
  });
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
