# Résonances

**Voir, ressentir, questionner l’amour.**  
_Baseline de travail provisoire._

## Présentation

Résonances est un projet de plateforme éditoriale et visuelle francophone autour de l’amour. Une image y ouvre un parcours de ressenti, d’interprétation, de réflexion et de questionnement.

Le projet explore ce qui nourrit les liens, mais aussi leurs dimensions fragiles, ambiguës ou difficiles. Il commence par l’amour romantique, avec une ouverture progressive vers d’autres formes de relations. La V1 est un site éditorial d’auteur, sans fonctionnalités de réseau social.

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

Le circuit éditorial retenu repose sur des fichiers **Markdown structurés avec frontmatter**, versionnés dans Git, puis un import privé vers PostgreSQL : validation, dry-run, transaction et idempotence. Le contrat, la validation et la résolution des références sont implémentés ; le dry-run et l’import transactionnel restent à réaliser.

## Stack technique retenue

- **Application :** Next.js App Router, React et TypeScript.
- **Interface :** CSS Modules ; Playfair Display pour les titres, Inter pour le corps et l’interface.
- **Données :** PostgreSQL, Drizzle ORM et Drizzle Kit, avec schéma code-first et migrations SQL inspectables.
- **Versionnement et collaboration :** Git / GitHub.
- **Médias :** stockage objet, fournisseur encore à choisir.

L’hébergement et le pipeline média définitif restent ouverts. Actuellement, seuls le socle TypeScript et les outils PostgreSQL/Drizzle sont installés ; l’intégration Next.js/React est à venir.

## État actuel

- ✅ Cadrage produit et éditorial, architecture V1 et décisions L0 D01–D06 validés.
- ✅ Premier socle PostgreSQL/Drizzle : médias, thèmes, publications, réflexions et associations de thèmes.
- ✅ Migration SQL initiale numérotée, journal et snapshot Drizzle.
- ✅ Tests d’intégrité et de visibilité sur PostgreSQL réel.
- ✅ Contrats Markdown/frontmatter, validation éditoriale et résolution des références.
- ⬜ Dry-run et import privé transactionnel/idempotent.
- ⬜ Intégration Next.js et implémentation du design system déjà défini.
- ⬜ Première tranche verticale complète, de l’import à la lecture publique.

Le [compte rendu du socle](docs/RESONANCES-V1-DATA-CORE.md) documente **18 tests réussis sur PostgreSQL 18.6** lors de sa validation. Aucune page du site n’est encore implémentée. Les migrations sont versionnées dans Git.

## Structure du dépôt

```text
docs/                 Spécification, décisions et guides techniques
db/                   Schéma Drizzle, visibilité et migrations SQL
scripts/              Application et vérification des migrations
tests/                Tests éditoriaux et intégration PostgreSQL
src/                  Parsing éditorial et lectures de références
content/              Exemples Markdown synthétiques
sources/              Documents de référence — lecture seule
AGENTS.md             Consignes de travail sur le projet
drizzle.config.ts     Configuration Drizzle Kit
package.json          Dépendances et commandes disponibles
package-lock.json     Versions verrouillées
.env.example          Exemples de variables d’environnement
```

**Ne pas modifier les fichiers de `sources/`.** `src/` contient le premier module éditorial ; `content/` contient des exemples synthétiques. Le dépôt étant public, un fichier `draft` versionné ici reste visible sur GitHub : conserver les vrais brouillons confidentiels dans des sources Git privées.

## Développement local

### Prérequis

- **Node.js 24 ou supérieur** et npm ; environnement validé avec Node 24.15.0 et npm 11.12.1.
- **PostgreSQL 18** pour reproduire les tests, validés sur 18.6.
- Une instance de test dédiée et un rôle disposant du privilège `CREATEDB`.

Depuis la racine du projet :

```sh
npm ci
npm run build
npm run typecheck
npm run format:check
npm run db:check
npm run db:verify
npm run test:editorial
```

`build` compile le **socle TypeScript**, pas une application Next.js. Aucune commande de lancement du site n’est encore disponible.

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
