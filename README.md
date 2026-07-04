# AMQ Trainer — Anime Music Quiz + Gacha

Site de quiz d'openings/endings d'anime avec économie de tokens, collection de
cartes (gacha à rareté finie), multijoueur temps réel et fonctions sociales.
En production : **https://amqtrainer.fr**

## Stack

- **Backend** : Node.js (≥ 20), Express 5, Socket.io (multijoueur)
- **Base de données** : PostgreSQL via Prisma 6 (SQLite en local possible, voir limites)
- **Auth** : email/mot de passe (bcrypt + JWT en cookie httpOnly), OAuth AniList & Google
- **Frontend** : HTML/CSS/JS statiques servis par Express (`backend/public/`)
- **Cache/atomicité** : Redis optionnel (jetons de manche, rate-limit) — repli mémoire si absent
- **Médias** : stockage Cloudflare R2 (S3 SDK) avec repli AnimeThemes
- **Données** : catalogue importé depuis AniList + AnimeThemes

> Tout le code applicatif vit dans `backend/`. Le frontend est dans
> `backend/public/` (et non un dossier `frontend/` séparé) car le service
> Railway a pour *root directory* `backend` → seul ce dossier est déployé.

## Démarrage local

```bash
cd backend
cp .env.example .env   # puis renseigner les valeurs (voir ci-dessous)
npm install
npm start              # → http://localhost:3000
```

`npm run dev` lance le serveur avec rechargement (`node --watch`).

### Limite base de données en local

Le schéma Prisma est en `provider = postgresql`. Avec un `DATABASE_URL` SQLite
(`file:./dev.db`), `prisma db push` échoue → pas de vraie BDD en local. En
pratique on **teste la logique pure** localement (voir Tests) puis on déploie
et on vérifie en prod. Pour un vrai test BDD local, pointer `DATABASE_URL` vers
un Postgres local ou l'URL publique du Postgres Railway.

## Variables d'environnement

| Variable | Requis | Description |
|----------|--------|-------------|
| `JWT_SECRET` | **oui en prod** | Secret de signature des tokens. Chaîne aléatoire longue (`openssl rand -hex 32`). Un avertissement est loggé au démarrage si absent ou trop faible. |
| `DATABASE_URL` | **oui en prod** | URL de connexion PostgreSQL. |
| `NODE_ENV` | recommandé | Mettre `production` en déploiement → cookies marqués `secure`. |
| `PORT` | non | Port HTTP (défaut 3000). |
| `FRONTEND_URL` | non | Origine du front pour CORS/redirections OAuth. |
| `RESEND_API_KEY` / `AUTH_FROM_EMAIL` | non | Envoi des liens « mot de passe oublié » via Resend. En développement sans clé, le lien est écrit dans les logs. |
| `REDIS_URL` | non | Active Redis (jetons de manche + rate-limit multi-instance). Sinon repli mémoire. |
| `ANILIST_CLIENT_ID` / `ANILIST_CLIENT_SECRET` / `ANILIST_REDIRECT_URI` | non | Active le bouton OAuth AniList. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | non | Active le bouton OAuth Google. |
| `ADMIN_EMAILS` | non | CSV des emails admin (défaut `melfisk6@gmail.com`). |
| `R2_ACCOUNT_ID` / `R2_BUCKET` / `R2_ENDPOINT` / `R2_PUBLIC_URL` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | non | Stockage médias Cloudflare R2 (voir `src/storage/r2.js`). |

La config est vérifiée au démarrage par `src/util/env.js` : des avertissements
sont loggés si quelque chose manque, sans jamais bloquer le démarrage.

## Tests

```bash
cd backend
npm test
npm run test:e2e  # parcours public/invité, bureau + mobile (Chromium)
```

Tests de **logique pure** (sans base de données), via `node:test` :
matching de réponses, raretés gacha, MMR classé, recommandations, flux médias,
boucle multijoueur. Les tests Playwright couvrent aussi l'entrée publique,
le parcours invité direct, le responsive et les headers de sécurité. La CI
GitHub Actions (`.github/workflows/ci.yml`) lance l'ensemble sur chaque push
`main` et chaque pull request.

## Structure

```
backend/
  src/
    server.js          point d'entrée (Express + Socket.io)
    auth/              email/mot de passe + OAuth, JWT, middleware
    catalog/           import/scan AniList + AnimeThemes
    quiz/              quiz solo, matching, jeton de manche anti-triche
    tower/             mode survie « Château de l'Infini »
    mp/                multijoueur temps réel (rooms, classé, MMR)
    gacha/             tirages, raretés, stock fini (CardInstance)
    trade/ shop/ friends/ quests/   social & économie
    economy/ leaderboard/ profile/ stats/ admin/
    util/              env, store (Redis/mémoire), rate-limit, stream
  prisma/schema.prisma
  scripts/             import-top, import-characters, backfills
  test/
  public/              frontend (servi statiquement)
```

## Déploiement

- **Hébergement** : Railway (root directory = `backend`), auto-deploy sur `git push main`.
- **Base** : PostgreSQL Railway. Le schéma est déployé via des migrations Prisma
  versionnées (`prisma/migrations`, script `prestart`).
- La première migration sert de **baseline** : le script reconnaît automatiquement
  la base historique déjà remplie et la marque comme appliquée avant le premier
  `prisma migrate deploy`. Une base neuve reçoit le schéma complet.
- Pour modifier le schéma : lancer `npm run db:migrate -- --name description`,
  relire le SQL généré, puis versionner simultanément le schéma et la migration.
- **DNS** : domaine OVH délégué à Cloudflare, CNAME apex en **DNS only (gris)**
  pour que Railway émette son certificat HTTPS.
- **Auto-deploy capricieux** : si Railway ne redéploie pas sur push, pousser un
  commit vide (`git commit --allow-empty`) ou « Deploy Latest Commit ». Toujours
  vérifier qu'un déploiement est bien passé (tester une route récente).

## Sauvegardes base de données

Pas de migrations versionnées → la donnée est la seule source de vérité. Faire
un dump régulier (avant tout changement de schéma, et idéalement planifié) :

```bash
# DATABASE_URL = l'URL PUBLIQUE du Postgres Railway (…proxy.rlwy.net:…)
pg_dump "$DATABASE_URL" -Fc -f amq-backup-$(date +%F).dump      # sauvegarde
pg_restore --clean --if-exists -d "$DATABASE_URL" fichier.dump  # restauration
```

Railway propose aussi des backups automatiques du plugin PostgreSQL (à activer
dans le service) — les garder en complément du dump manuel avant migration.

## Crédits

Données et médias : [AniList](https://anilist.co) et
[AnimeThemes](https://animethemes.moe).
