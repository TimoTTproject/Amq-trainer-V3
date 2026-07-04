// Déploie les migrations Prisma et prend en charge une seule fois la base
// historique, créée avant l'introduction des migrations versionnées.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const BASELINE = '20260704130000_baseline';

function runPrisma(args) {
  const cli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`prisma ${args.join(' ')} a échoué (${result.status})`);
}

async function migrationState(prisma) {
  const tables = await prisma.$queryRaw`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN ('User', '_prisma_migrations')
  `;
  const names = new Set(tables.map((row) => row.table_name));
  const hasAppSchema = names.has('User');
  const hasMigrationTable = names.has('_prisma_migrations');
  let appliedMigrations = 0;

  if (hasMigrationTable) {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
        AND rolled_back_at IS NULL
    `;
    appliedMigrations = Number(rows[0]?.count || 0);
  }

  return { hasAppSchema, hasMigrationTable, appliedMigrations };
}

async function main() {
  const prisma = new PrismaClient();
  let state;
  try {
    state = await migrationState(prisma);
  } finally {
    await prisma.$disconnect();
  }

  // Base de production historique : son schéma courant correspond au baseline.
  // On ne le marque appliqué que si aucune autre migration n'a jamais été validée.
  if (state.hasAppSchema && state.appliedMigrations === 0) {
    console.log(`Base existante détectée : enregistrement du baseline ${BASELINE}.`);
    runPrisma(['migrate', 'resolve', '--applied', BASELINE]);
  }

  runPrisma(['migrate', 'deploy']);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Déploiement des migrations impossible :', error.message);
    process.exitCode = 1;
  });
}

module.exports = { BASELINE, migrationState };
