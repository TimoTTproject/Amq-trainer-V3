// Tutoriel joué (remplace l'ancienne modale d'onboarding) — extrait autonome
// (scope global partagé, chargé avant main.js). Affiche des bulles contextuelles
// pendant la 1re manche réelle au lieu d'un mur de texte qu'on ferme sans lire.
// Purement passif (listeners + MutationObserver) : ne touche à aucune logique
// de jeu existante, donc sans risque de casser le quiz.
let tutorialActive = false;
let tutorialObservers = [];

function tutorialPending() {
  return !localStorage.getItem('amq_onboarded');
}

function tutorialDone() {
  localStorage.setItem('amq_onboarded', '1');
  tutorialActive = false;
  clearCoachmark();
  tutorialObservers.forEach((o) => o.disconnect());
  tutorialObservers = [];
}

function clearCoachmark() {
  const el = document.getElementById('coachmark');
  if (el) el.remove();
  document.querySelectorAll('.coachmark-target').forEach((t) => t.classList.remove('coachmark-target'));
}

function showCoachmark(targetEl, text, opts = {}) {
  clearCoachmark();
  if (!targetEl) return;
  const box = document.createElement('div');
  box.id = 'coachmark';
  box.className = 'coachmark';
  box.innerHTML = `<p>${text}</p>` + (opts.skip === false ? '' : '<button class="btn-link coachmark-skip">Passer le tutoriel</button>');
  document.body.appendChild(box);
  const rect = targetEl.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 10;
  const left = Math.max(10, Math.min(rect.left + window.scrollX, window.innerWidth - box.offsetWidth - 10));
  box.style.top = `${top}px`;
  box.style.left = `${left}px`;
  targetEl.classList.add('coachmark-target');
  const skipBtn = box.querySelector('.coachmark-skip');
  if (skipBtn) skipBtn.addEventListener('click', tutorialDone);
}

// Étape 1 : pointe le bouton Démarrer.
function tutorialStepStart() {
  const btn = document.getElementById('next-btn');
  if (!btn) return tutorialDone();
  showCoachmark(btn, "🎧 Clique ici pour lancer un extrait — devine l'anime au son de son opening !");
  const onClick = () => {
    btn.removeEventListener('click', onClick);
    clearCoachmark();
    tutorialStepAnswer();
  };
  btn.addEventListener('click', onClick);
}

// Étape 2 : pointe la zone de réponse dès qu'elle devient utilisable.
function tutorialStepAnswer() {
  const input = document.getElementById('answer-input');
  const choices = document.getElementById('choice-buttons');
  if (!input || !choices) return tutorialDone();
  const check = () => {
    const choicesReady = !choices.classList.contains('hidden') && choices.children.length > 0;
    if (!input.disabled || choicesReady) {
      obs.disconnect();
      clearCoachmark();
      const target = choicesReady ? choices : input;
      showCoachmark(target, "✍️ Tape le nom de l'anime (ou choisis une proposition) — valide dès que tu es prêt.");
      tutorialStepTokens();
    }
  };
  const obs = new MutationObserver(check);
  obs.observe(input, { attributes: true, attributeFilter: ['disabled'] });
  obs.observe(choices, { attributes: true, attributeFilter: ['class'] });
  tutorialObservers.push(obs);
  check();
}

// Étape 3 : pointe le solde de tokens dès qu'il change (1re récompense gagnée).
function tutorialStepTokens() {
  const badge = document.getElementById('user-tokens');
  if (!badge) return tutorialDone();
  const before = badge.textContent;
  const obs = new MutationObserver(() => {
    if (badge.textContent !== before) {
      obs.disconnect();
      clearCoachmark();
      showCoachmark(
        document.getElementById('reward-caps-btn') || badge,
        '🪙 Tu viens de gagner des tokens ! Dépense-les au Gacha pour collectionner des personnages.',
        { skip: false }
      );
      setTimeout(tutorialDone, 6000);
    }
  });
  obs.observe(badge, { childList: true, characterData: true, subtree: true });
  tutorialObservers.push(obs);
}

// Appelé à la 1re ouverture du quiz classique (voir main.js openQuiz()).
function startTutorial() {
  if (tutorialActive || !tutorialPending()) return;
  tutorialActive = true;
  tutorialStepStart();
}

window.addEventListener('resize', () => { if (tutorialActive) clearCoachmark(); });
