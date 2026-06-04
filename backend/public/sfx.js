// Effets sonores synthétisés (Web Audio API) — aucun fichier audio à héberger.
// + confettis. Exposé en global : sfx, burstConfetti.
const sfx = (function () {
  let ctx = null;
  let muted = localStorage.getItem('amq_muted') === '1';

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Une note : fréquence, délai, durée, forme d'onde, volume crête
  function tone(freq, delay, dur, type = 'triangle', peak = 0.22) {
    const c = ac();
    if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.connect(g);
    g.connect(c.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  function seq(notes, { dur = 0.16, step = 0.08, type = 'triangle', peak = 0.22 } = {}) {
    if (muted) return;
    if (!ac()) return;
    notes.forEach((f, i) => tone(f, i * step, dur, type, peak));
  }

  const REVEAL = {
    common: [880],
    rare: [880, 1175],
    epic: [784, 988, 1319],
    legendary: [659, 988, 1319, 1568],
    mythic: [659, 988, 1319, 1568, 2093],
  };

  return {
    correct() { seq([523.25, 659.25, 783.99], { type: 'triangle', dur: 0.18 }); },
    wrong() { if (muted) return; tone(180, 0, 0.18, 'square', 0.18); tone(120, 0.1, 0.22, 'square', 0.18); },
    reveal(rarity) { seq(REVEAL[rarity] || REVEAL.common, { type: 'sine', step: 0.07, dur: 0.22, peak: 0.18 }); },
    win() { seq([523.25, 659.25, 783.99, 1046.5], { type: 'triangle', step: 0.12, dur: 0.28, peak: 0.25 }); },
    lose() { seq([392, 329.63, 261.63], { type: 'triangle', step: 0.14, dur: 0.3, peak: 0.2 }); },
    levelup() { seq([523.25, 659.25, 783.99, 1046.5, 1318.5], { type: 'square', step: 0.07, dur: 0.16, peak: 0.16 }); },
    tick() { if (muted) return; tone(880, 0, 0.06, 'sine', 0.14); },
    isMuted() { return muted; },
    toggleMute() {
      muted = !muted;
      localStorage.setItem('amq_muted', muted ? '1' : '0');
      if (!muted) this.correct();
      return muted;
    },
  };
})();

// ── Confettis ──
function burstConfetti(count = 28) {
  let layer = document.getElementById('confetti-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'confetti-layer';
    layer.className = 'confetti-layer';
    document.body.appendChild(layer);
  }
  const colors = ['#6c8cff', '#8a6cff', '#3ec98a', '#ffb648', '#ff5d8f', '#3aa0ff'];
  for (let i = 0; i < count; i++) {
    const bit = document.createElement('span');
    bit.className = 'confetti-bit';
    bit.style.left = Math.random() * 100 + '%';
    bit.style.background = colors[(Math.random() * colors.length) | 0];
    bit.style.animationDelay = Math.random() * 0.25 + 's';
    bit.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.appendChild(bit);
    setTimeout(() => bit.remove(), 2200);
  }
}
