// Configuration d'environnement centralisée + validation au démarrage.
// Objectif : échouer vite (fail-fast) si la production est mal configurée,
// plutôt que de servir le site avec un secret connu ou des cookies non sécurisés.

const isProduction = process.env.NODE_ENV === 'production';

// Secrets de repli connus → interdits en production (ils sont publics dans le repo).
const WEAK_SECRETS = new Set(['', 'change-me', 'dev-change-me']);

// Secret JWT. Le repli faible n'est toléré qu'en développement.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-change-me';

// Valide la configuration. Lève une erreur (arrête le serveur) si la prod est
// dangereuse ; émet seulement un avertissement en développement.
function validateEnv() {
  const errors = [];
  const warnings = [];

  if (WEAK_SECRETS.has(process.env.JWT_SECRET || '')) {
    const msg =
      'JWT_SECRET absent ou trop faible — génère une chaîne aléatoire longue (ex. `openssl rand -hex 32`).';
    (isProduction ? errors : warnings).push(msg);
  }

  if (isProduction && !process.env.DATABASE_URL) {
    errors.push('DATABASE_URL absent en production.');
  }

  // NODE_ENV non défini en prod = cookies non "secure" (flag basé sur isProduction).
  if (!process.env.NODE_ENV) {
    warnings.push(
      'NODE_ENV non défini : les cookies de session ne seront pas marqués "secure". ' +
        'Définis NODE_ENV=production en déploiement.'
    );
  }

  for (const w of warnings) console.warn(`  ⚠ ${w}`);

  if (errors.length) {
    console.error('\n  ✖ Configuration d\'environnement invalide :');
    for (const e of errors) console.error(`    - ${e}`);
    console.error('');
    throw new Error('Démarrage interrompu : configuration d\'environnement invalide.');
  }
}

module.exports = { isProduction, JWT_SECRET, validateEnv };
