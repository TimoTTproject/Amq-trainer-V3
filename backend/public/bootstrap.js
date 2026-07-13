// Initialisation minimale exécutée avant le premier rendu. Ce fichier externe
// respecte la CSP `script-src 'self'`, contrairement aux anciens scripts inline.
window.BUILD_ID = document.documentElement.dataset.buildId || '';

try {
  if (localStorage.getItem('amq_theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
  }
} catch {
  // Stockage indisponible : thème sombre par défaut.
}
