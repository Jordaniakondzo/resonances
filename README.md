# Résonances

**Voir, ressentir, questionner l’amour.**  
_Baseline de travail provisoire._

## Présentation

Résonances est un projet de plateforme éditoriale et visuelle francophone autour de l’amour. Une image y ouvre un parcours de ressenti, d’interprétation, de réflexion et de questionnement.

Le projet explore ce qui nourrit les liens, mais aussi leurs dimensions fragiles, ambiguës ou difficiles. Il commence par l’amour romantique, avec une ouverture progressive vers d’autres formes de relations. La V1 est un site éditorial d’auteur, sans fonctionnalités de réseau social.

### Direction artistique

Les premières explorations visuelles de Résonances sont conservées dans le [dossier design](docs/design/README.md).

Ce dossier présente le moodboard éditorial et une maquette historique de la Galerie V1. Ces références illustrent les intentions artistiques du projet ; elles sont indicatives et non contractuelles, et ne remplacent pas les spécifications et décisions validées.

## Vision éditoriale

**Voir → Ressentir → Comprendre → Questionner**

L’étape **Échanger** appartient aux phases communautaires ultérieures. L’écriture distingue ce que l’image montre de ce qu’elle peut évoquer, sans imposer une interprétation universelle.

Une publication de Galerie suit cette structure souple :

**Image → Titre → Accroche → Observation → Évocation → Réflexion → Question ouverte → Thèmes**

La Galerie part d’une image ; les articles de la section Réflexions partent d’une idée à approfondir.

## Objectifs

- **Produit et éditorial :** construire une bibliothèque visuelle et réflexive cohérente, agréable à explorer, avec une écriture personnelle et nuancée.
- **Apprentissage :** progresser en programmation web, architecture logicielle, TypeScript, Next.js, PostgreSQL, SQL, Drizzle, tests, gestion de contenu, accessibilité et performance.

Les choix doivent rester compréhensibles et reproductibles. Les requêtes relationnelles importantes sont raisonnées en SQL avant leur traduction en Drizzle.

## Périmètre prévu pour la V1

- Accueil, Galerie, publications individuelles, Réflexions et leurs articles, À propos.
- Navigation thématique, contenus associés et mise en avant éditoriale.
- Recherche simple sur les titres, accroches/résumés et thèmes, couvrant publications et réflexions.
- Interface responsive, accessibilité, SEO de base et médias optimisés.

### Hors V1

Comptes lecteurs, profils, likes, commentaires, chat, notifications, contributions publiques, recommandations IA, recherche vectorielle ou sémantique, CMS et interface d’administration.

## Architecture cible

Résonances est conçu comme un **monolithe modulaire** :

```text
Page / UI → Service / Use Case → Repository → Drizzle → PostgreSQL
```

Les médias seront stockés hors PostgreSQL, dans un stockage objet ; la base conserve leurs métadonnées et références.

Le circuit éditorial retenu repose sur des fichiers **Markdown structurés avec frontmatter**, versionnés dans Git, puis un import privé vers PostgreSQL : validation, dry-run, transaction et idempotence. Le contrat, la validation et la résolution des références sont implémentés ; le chargement des sources, le plan d’import et le dry-run en lecture seule (D03-01 à D03-04) sont implémentés, en attente de revue indépendante ; l’import transactionnel (D03-06, `runImport`) est implémenté et testé sur PostgreSQL réel, en attente de revue indépendante ; aucun script ni route d’exécution n’existe encore.

## Stack technique retenue

- **Application :** Next.js App Router, React et TypeScript.
- **Interface :** CSS Modules ; Playfair Display pour les titres, Inter pour le corps et l’interface.
- **Données :** PostgreSQL, Drizzle ORM et Drizzle Kit, avec schéma code-first et migrations SQL inspectables.
- **Versionnement et collaboration :** Git / GitHub.
- **Médias :** stockage objet, fournisseur encore à choisir.

L’hébergement et le pipeline média définitif restent ouverts. Le socle TypeScript, les outils PostgreSQL/Drizzle et le socle Web Next.js minimal (T1) sont installés ; aucune page éditoriale ni lecture de données n’existe encore.

## État actuel

- ✅ Cadrage produit et éditorial, architecture V1 et décisions L0 D01–D06 validés.
- ✅ Premier socle PostgreSQL/Drizzle : médias, thèmes, publications, réflexions et associations de thèmes.
- ✅ Migration SQL initiale numérotée, journal et snapshot Drizzle.
- ✅ Tests d’intégrité et de visibilité sur PostgreSQL réel.
- ✅ Contrats Markdown/frontmatter, validation éditoriale et résolution des références.
- ✅ Moteur privé D03 implémenté (D03-01 à D03-06) : chargement des sources, plan d’import, dry-run en lecture seule (`runDryRun`) et import transactionnel/idempotent (`runImport`) ; en attente de revue indépendante ; aucun script ni route d’exécution.
- ✅ Utilisation de D03 vérifiée **en environnement de test uniquement** : suites PostgreSQL du moteur et jeu de données synthétique T3 (bootstrap Theme/MediaAsset, dry-run, import, NOOP au second import, visibilité) sur base jetable ([compte rendu](docs/RESONANCES-V1-T3-DATASET.md)) ; données de développement, jamais un corpus autorisé.
- ⬜ Avant toute véritable diffusion publique : point d’entrée d’exécution, vérification des rôles et privilèges réels ([politique des écrivains SQL](docs/operations/SQL-WRITER-POLICY.md)), support privé des fiches, [checklist éditoriale](docs/operations/EDITORIAL-PUBLICATION-CHECKLIST.md) et décision humaine **AUTORISÉ POUR DIFFUSION** avant tout import pouvant rendre un contenu public.
- ✅ Socle Web T1 : Next.js App Router, tokens CSS, polices, page d’accueil provisoire et page 404.
- ⬜ Composants du design system (navigation, cartes, etc.) et pages de contenu.
- ⬜ Première tranche verticale complète, de l’import à la lecture publique.

Le [compte rendu du socle](docs/RESONANCES-V1-DATA-CORE.md) documente **18 tests réussis sur PostgreSQL 18.6** lors de sa validation. Seule une page d’accueil provisoire et une page 404 existent. Les migrations sont versionnées dans Git.

## Structure du dépôt

```text
docs/                 Spécification, décisions et guides techniques
db/                   Schéma Drizzle, visibilité et migrations SQL
scripts/              Application et vérification des migrations
tests/                Tests éditoriaux et intégration PostgreSQL
tests/fixtures/       Jeu de données synthétique T3 (références + Markdown)
src/                  Parsing éditorial et lectures de références
src/app/              Routes et layouts Next.js (composants serveur)
src/styles/           Tokens CSS et styles globaux
content/              Exemples Markdown synthétiques
sources/              Documents de référence — lecture seule
AGENTS.md             Consignes de travail sur le projet
drizzle.config.ts     Configuration Drizzle Kit
next.config.ts        Configuration Next.js
tsconfig.json         Contexte TypeScript Node (moteur éditorial, tests, scripts)
tsconfig.web.json     Contexte TypeScript Web (TSX, types générés par Next.js)
package.json          Dépendances et commandes disponibles
package-lock.json     Versions verrouillées
.env.example          Exemples de variables d’environnement
```

**Ne pas modifier les fichiers de `sources/`.** `src/` contient le premier module éditorial ; `content/` contient des exemples synthétiques. Le dépôt étant public, un fichier `draft` versionné ici reste visible sur GitHub : conserver les vrais brouillons confidentiels dans des sources Git privées.

## Développement local

### Prérequis

- **Node.js 24 ou supérieur** et npm ; environnement validé avec Node 24.15.0 et npm 11.12.1.
- **PostgreSQL 18** pour reproduire les tests, validés sur 18.6.
- Une instance de test dédiée et un rôle disposant des privilèges `CREATEDB` et `CREATEROLE` (la migration ADR-B1 dépend de rôles de cluster ; voir [provisionnement ADR-B1](docs/operations/ADR-B1-ROLE-PROVISIONING.md)).

Depuis la racine du projet :

```sh
npm ci
npm run build
npm run typecheck:all
npm run build:web
npm run check:client-bundle
npm run test:web-boundaries
npm run format:check
npm run db:check
npm run db:verify
npm run test:editorial
```

`build` compile toujours le **socle TypeScript** (moteur éditorial) ; l’application Next.js se construit avec `build:web`.

### Lancer le site (socle Web)

```sh
npm run dev          # serveur de développement : http://localhost:3000
npm run build:web    # build de production
npm run start        # sert le build de production
```

- Les polices (Inter 400/500, Playfair Display 500/700) sont téléchargées depuis Google Fonts **au build** par `next/font` ; un build hors ligne échoue tant qu’elles ne sont pas disponibles.
- `typecheck` vérifie le contexte Node (`tsconfig.json`), `typecheck:web` le contexte Web (`tsconfig.web.json`, types générés par `next typegen`) ; `typecheck:all` exécute les deux.
- Le socle Web ne se connecte pas encore à PostgreSQL. T2 fournit la couche de lecture publique (`src/services/public-publications.ts`, `src/repositories/public-*.ts`) qui lit `APP_DATABASE_URL` côté serveur avec le rôle `resonances_app_reader`, qui ne lit que les vues `public_read` ([procédure](docs/operations/PUBLIC-READER-PROVISIONING.md) : rôles avant la migration 0002, vérification après activation de LOGIN) ; aucune page ne l’appelle encore (T4).
- Les fichiers de `src/app/` ne doivent pas importer le moteur d’import, les scripts, les migrations ni un pilote PostgreSQL : `test:web-boundaries` (source) et `check:client-bundle` (après `build:web`) le contrôlent.

### Versions retenues (T1)

| Paquet | Version | Remarque |
|---|---|---|
| Next.js | 16.4.5 | stable (`latest`), Turbopack |
| React / React DOM | 19.3.1 | |
| `@types/react` / `@types/react-dom` | 19.3.0 | |
| TypeScript | 7.0.2 | inchangé ; un seul compilateur |

Avec TypeScript 7, Next.js 16.4.5 exécute le `tsc` natif du projet pour son contrôle de types (l’API JavaScript de TypeScript n’existe plus) et lit `typescript.tsconfigPath`, ici `tsconfig.web.json`. Les erreurs de types font échouer `next build`. Écarts connus : `next build` complète `tsconfig.web.json` (`allowJs`, `esModuleInterop`) ; `next dev` pourrait modifier `AGENTS.md`, désactivé par `agentRules: false`. ESLint n’est pas installé : dette d’outillage à traiter avant la recette finale.

`format:check` utilise `--end-of-line auto` : il accepte les fins de ligne LF et CRLF (par exemple sous Windows avec `core.autocrlf=true`). `next-env.d.ts` est généré par Next.js et ignoré par Git.

**Limites des contrôles de frontière serveur/client.** `tests/web-boundaries.test.ts` ne couvre que les formes d’imports actuellement analysées, et `scripts/check-client-bundle.ts` ne recherche que des marqueurs déterminés dans les artefacts client. Ces contrôles ne prouvent pas, de façon générale, l’absence de fuite pour tous les imports dynamiques, alias ou noms de secrets. Leur couverture devra être réévaluée lorsque T2 introduira les accès aux données publiques.

Pour les tests, définir `TEST_DATABASE_URL` vers l’instance dédiée. Exemple PowerShell, avec des valeurs à remplacer :

```powershell
$env:TEST_DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5432/postgres'
npm test
```

Les fichiers `.env` ne sont pas chargés automatiquement. Ne pas versionner les secrets. Les procédures de génération et d’application des migrations sont détaillées dans le [guide du socle](docs/RESONANCES-V1-DATA-CORE.md).

## Tests et vérifications

Les tests appliquent les migrations sur **PostgreSQL réel**, dans une base temporaire créée pour chaque exécution. Ils vérifient notamment les contraintes d’unicité, les foreign keys, les suppressions protégées, les cascades, les brouillons incomplets et la visibilité des contenus.

Seule la base temporaire créée par les tests est supprimée ; aucune base utilisateur ne doit être détruite. `DATABASE_URL` n’est pas utilisé comme valeur de secours pour les tests.

`db:check` contrôle les métadonnées de migrations. `db:verify` compare la migration initiale à une génération indépendante du schéma Drizzle ; ce contrôle est actuellement limité à cette première migration.

## Documentation

Le [contrat éditorial](docs/RESONANCES-V1-EDITORIAL-CONTRACT.md) détaille la syntaxe, les validations, les limites et les tests sans base.

Le README présente le projet ; les documents de référence détaillés restent dans `docs/` :

- [Spécification Résonances V1](docs/RESONANCES-V1-SPECIFICATION.md) — vision, périmètre, données, design system et critères de réussite.
- [Décisions techniques L0](docs/RESONANCES-V1-L0-DECISIONS.md) — décisions D01–D06 validées.
- [Transition vers l’implémentation](docs/RESONANCES-V1-TRANSITION.md) — lots, dépendances et progression.
- [Premier bloc de données](docs/RESONANCES-V1-DATA-CORE.md) — choix physiques, commandes, résultats des tests et limites connues.
- [Jeu de données T3](docs/RESONANCES-V1-T3-DATASET.md) — dataset synthétique, bootstrap des références, passage par D03 et commande `npm run test:t3-dataset`.

Les commentaires du code et des scripts sont rédigés en anglais ; la documentation du projet est en français.

## Médias et provenance

Par défaut, les images sont créées par l’auteur ou générées spécifiquement pour Résonances avec des outils dont les conditions permettent l’usage prévu. Les images externes nécessitent une licence, une provenance et des obligations d’attribution vérifiées et documentées.

Une image disponible ou téléchargeable sur Internet ne constitue pas une autorisation d’utilisation. La traçabilité des créations IA est conservée en interne. La politique complète figure dans la section **10.1.1 de la spécification**, sans dépendance à un fournisseur IA particulier.

## Roadmap

- **V1 :** noyau éditorial, Galerie, Réflexions et recherche simple.
- **V1.1 :** recherche PostgreSQL Full Text Search et classement enrichi, améliorations SEO et performance.
- **V2 :** comptes et favoris.
- **V3+ :** communauté progressive, avec modération dès les premières contributions.
- **Phases ultérieures :** recherche sémantique, recommandations et parcours personnalisés.

Cette progression ne constitue pas un engagement de calendrier.

## Statut

Résonances est actuellement en développement actif.
