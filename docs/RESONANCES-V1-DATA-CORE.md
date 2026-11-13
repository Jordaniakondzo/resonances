# Résonances V1 — Premier bloc de données

Date : 27 septembre 2026.

Références : [spécification](RESONANCES-V1-SPECIFICATION.md), [décisions L0](RESONANCES-V1-L0-DECISIONS.md), [transition](RESONANCES-V1-TRANSITION.md).

## Périmètre réalisé

Un socle TypeScript compilable, Drizzle ORM/Kit, un enum content_status et six tables : media_assets, themes, publications, reflections, publication_themes, reflection_themes.

Le dossier initial ne contenait que docs/, sources/ et AGENTS.md, sans package.json, application ni dépôt .git local. Le socle de données est créé à la racine pour être intégré au futur monolithe Next.js. Ce lot ne crée aucune page, aucun serveur HTTP, aucun service d’import, aucune table supplémentaire du domaine. La compilation actuelle est TypeScript, pas un build Next.js.

D01–D06 restent validées. D07 et suivantes ne sont pas tranchées. sources/ reste en lecture seule. La règle de provenance ne reçoit aucun champ physique nouveau : outil IA et brief restent à localiser lors du workflow média.

## Plan exécuté

1. Inspection des trois documents et de AGENTS.md.
2. Socle npm/TypeScript et tests sur une instance PostgreSQL séparée.
3. Schéma code-first, génération SQL et vérification des invariants.
4. Comparaison d’une génération indépendante avec la migration, compilation et documentation.

## Structure et dépendances

- db/schema.ts : définition des tables, enum, contraintes et index.
- db/visibility.ts : prédicat réutilisable de visibilité, destiné aux futurs repositories.
- db/migrations/ : SQL généré et métadonnées Drizzle versionnables.
- drizzle.config.ts : génération hors connexion ; DATABASE_URL pour les opérations connectées.
- scripts/migrate.ts : application des migrations avec fermeture de la connexion.
- scripts/verify-schema.ts : régénération indépendante du SQL initial dans .local/.
- tests/schema.test.ts : contraintes PostgreSQL réelles et lecture Drizzle.
- package.json / package-lock.json : dépendances épinglées et installation reproductible.
- tsconfig.json, .gitignore, .env.example : compilation, exclusions et variables documentées.

Drizzle ORM/Kit sont imposés par D02 ; pg est le pilote PostgreSQL. TypeScript compile et vérifie les types ; tsx exécute les scripts/tests TypeScript ; les tests utilisent node:test sans framework supplémentaire. Les paquets @types fournissent les déclarations TypeScript et Prettier vérifie le formatage. Aucun runtime Next.js/React n’est installé tant qu’aucun code d’application ne l’utilise ; la stack cible reste inchangée.

## Choix physiques

### Identité et dates

UUID avec gen_random_uuid() côté PostgreSQL. Toutes les dates sont TIMESTAMPTZ. created_at et updated_at ont DEFAULT now(). **updated_at n’est pas automatiquement actualisé par un trigger** : les futures écritures devront le mettre à jour explicitement. TIMESTAMPTZ représente un instant ; l’affichage dépend du fuseau de session.

locale vaut fr par défaut et doit être non vide, sans espaces de bord. La normalisation des tags de langue relève du futur validateur ; ce CHECK ne prétend pas valider tout BCP 47.

### Brouillons et publication

Titre, slug, textes éditoriaux, média principal et couverture peuvent être NULL. Plusieurs brouillons sans slug sont autorisés. Un slug renseigné doit suivre la forme ASCII minuscule avec tirets ; l’import devra normaliser les titres accentués. UNIQUE(locale, slug) s’applique séparément aux publications et aux réflexions, ainsi qu’aux thèmes.

L’enum autorise draft, published, archived. Un CHECK exige published_at lorsque status = published. Une date future reste autorisée pour la programmation. Aucun CHECK ne dépend de now().

Le schéma n’impose pas la complétude éditoriale des textes, l’existence d’au moins un thème ni un média principal au passage en published. Ces règles devront être contrôlées par le service de publication/import avant toute exposition publique. **Ce lot ne fournit pas encore un circuit sûr de publication éditoriale complet.**

### Médias

original_url est une référence textuelle non vide obligatoire (URL ou référence de stockage), sans fournisseur imposé. Aucune donnée binaire en base. Les variantes web, dimensions, alt et informations de provenance peuvent être renseignées progressivement. Une dimension connue doit être strictement positive. L’import futur devra vérifier les métadonnées nécessaires, les droits et les alternatives textuelles avant publication.

Les références média des publications/réflexions utilisent ON DELETE RESTRICT. Les fichiers eux-mêmes ne sont ni créés ni supprimés par cette migration.

### Relations de thèmes

Les associations ont une PK composée, donc aucun doublon de paire. Les deux références sont obligatoires et contrôlées par FK. ON DELETE CASCADE côté contenu nettoie uniquement ses associations ; ON DELETE RESTRICT côté thème protège une taxonomie encore utilisée. Une association peut être supprimée explicitement. L’archivage reste la voie métier privilégiée.

Les associations n’imposent pas encore une égalité de langue contenu/thème : cette règle n’a pas été validée. Les futures règles d’import devront décider des associations multilingues.

### Index

L’unicité locale/slug fournit son index. Chaque FK de média et chaque recherche inverse par thème possède un index. La PK composée couvre déjà les recherches d’associations par contenu. Les index partiels des listes publiques portent sur locale, published_at DESC, id DESC et filtrent le statut publié avec date non nulle. La comparaison avec now() est effectuée à la lecture.

## SQL d’abord, Drizzle ensuite

Le contrat de visibilité, testé sur les deux tables :

~~~sql
SELECT id, slug
FROM publications
WHERE status = 'published'
  AND published_at IS NOT NULL
  AND published_at <= now()
ORDER BY published_at DESC, id DESC;
~~~

Sa traduction est centralisée dans publicContentWhere, utilisée dans le test par db.select().from(publications).where(publicContentWhere(publications)). Les jeux couvrent brouillon, archive, date future, date passée et égalité exacte à now() dans une transaction.

Exemple de jointure à utiliser lors de la future couche repository, non implémentée dans ce lot :

~~~sql
SELECT p.id, p.slug
FROM publications AS p
JOIN publication_themes AS pt ON pt.publication_id = p.id
JOIN themes AS t ON t.id = pt.theme_id
WHERE t.locale = 'fr' AND t.slug = 'confiance'
  AND p.status = 'published'
  AND p.published_at IS NOT NULL
  AND p.published_at <= now()
ORDER BY p.published_at DESC, p.id DESC;
~~~

## Reproduction

Prérequis vérifiés : Node 24.15.0, npm 11.12.1, PostgreSQL 18 local. Les versions npm exactes sont dans package-lock.json. Utiliser une instance PostgreSQL exclusivement dédiée aux tests et un rôle superutilisateur de test (voir « Instance PostgreSQL de test » : le socle seul n'exigeait que la création de bases temporaires, la suite complète actuelle exige un superutilisateur).

~~~powershell
npm ci
npm run build
npm run typecheck
npm run format:check
npm run db:check
npm run db:verify
$env:TEST_DATABASE_URL = 'postgresql://SUPERUSER_DE_TEST@127.0.0.1:55439/postgres'
npm test
~~~

L’instance attendue est décrite ci-dessous (« Instance PostgreSQL de test »). Les variables ne sont pas chargées automatiquement depuis .env ; les définir dans l’environnement (ou employer le mécanisme de chargement de Node). Ne pas versionner les secrets. Les tests n’utilisent jamais DATABASE_URL comme fallback : ils créent une base au nom UUID, y appliquent la migration, puis suppriment uniquement cette base. Aucun TRUNCATE/DROP n’est exécuté sur une base fournie par l’utilisateur.

Pour appliquer les migrations à une base de développement explicitement choisie :

~~~powershell
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5432/resonances'
npm run db:migrate
~~~

Cette commande n’a pas été exécutée contre le service PostgreSQL existant de l’utilisateur. Les migrations ont été appliquées par les tests sur des bases isolées. Réappliquer la même migration doit préserver les données.

## Instance PostgreSQL de test

### Une instance dédiée, jamais une instance partagée

Les tests ne se contentent pas de créer des bases temporaires : ils agissent sur des objets **communs à tout le cluster**. Ils créent et modifient des rôles de connexion (`resonances_*_test_*`, `resonances_t2_lock_migrator_*`…) et leurs mots de passe, provisionnent les rôles ADR-B1 et T2 (`resonances_importer`, `resonances_b1_owner`, `resonances_app_reader`, `resonances_public_views_owner`), ajoutent et retirent des appartenances à ces rôles, prennent un verrou consultatif partagé (`hashtext('b1-roles')`), terminent des sessions (`pg_terminate_backend`, `DROP DATABASE … WITH (FORCE)` sur leurs propres bases) et suppriment leurs bases `resonances_test_<uuid>`. Ils exigent donc un cluster PostgreSQL **réservé aux tests**, sans aucune donnée réelle, et un rôle **superutilisateur**.

Trois niveaux de privilèges à ne pas confondre :

- **Infrastructure de tests** : un superutilisateur est nécessaire pour la suite PostgreSQL complète (`tests/support/b1-roles.ts` : sondes directes du catalogue, verrou de `pg_auth_members`, `SET ROLE` sans appartenance). `CREATEDB` et `CREATEROLE` ne suffisent pas. Ce privilège n'existe que dans l'instance de test.
- **Rôles applicatifs** : privilèges minimaux, déjà provisionnés par `db/provisioning` (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`) ; le lecteur public ne lit que les vues `public_read`.
- **Production** : aucun superutilisateur applicatif ; les exigences sont celles du [provisionnement ADR-B1](operations/ADR-B1-ROLE-PROVISIONING.md) et du [provisionnement du lecteur public](operations/PUBLIC-READER-PROVISIONING.md). Rien dans ce document ne les modifie.

Limites à connaître :

- les tests ne suppriment que les bases qu’ils ont créées, mais les rôles de test restent définis dans le cluster entre deux exécutions ;
- une exécution interrompue (processus tué, panne) peut laisser une base `resonances_test_<uuid>` ou une appartenance temporaire au propriétaire des vues ; la reprise se fait à la main, dans ce cluster seulement ([procédure](operations/PUBLIC-READER-PROVISIONING.md)) ;
- **ne jamais lancer simultanément deux suites** (deux `npm test`, ou deux worktrees) contre la même instance : elles partagent les mêmes rôles, mots de passe et verrous, et se perturberaient mutuellement.

### Démarrage explicite sur 127.0.0.1:55439

L’instance locale de référence est `.local/postgres-tests` (ignorée par Git, PostgreSQL 18.6). Son `postgresql.conf` ne fixe pas de port : sans option, elle tenterait le port 5432 du service PostgreSQL déjà installé. La démarrer et l’arrêter explicitement :

Ces commandes s'exécutent **depuis la racine du dépôt**. `.local\postgres-tests` est un cluster **déjà initialisé et exclusivement dédié aux tests** ; `SUPERUSER_DE_TEST` est un **placeholder à remplacer** par le superutilisateur de ce cluster. Le port **55439** doit toujours être fixé explicitement, et le service PostgreSQL principal du port 5432 ne doit **jamais** être ciblé.

~~~powershell
$pgCtl = 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe'   # pg_ctl n'est pas dans le PATH ; adapter si l'installation diffère
if (-not (Test-Path $pgCtl)) { throw "pg_ctl.exe introuvable : $pgCtl" }
$log = Join-Path $env:TEMP 'resonances-pg-test.log'   # journal hors du dépôt
& $pgCtl -D .local\postgres-tests -l $log -o "-p 55439 -c listen_addresses=127.0.0.1" -w start
$env:TEST_DATABASE_URL = 'postgresql://SUPERUSER_DE_TEST@127.0.0.1:55439/postgres'
npm test
& $pgCtl -D .local\postgres-tests -m fast -w stop
~~~

Avant de lancer les tests, vérifier qu’on parle bien à cette instance (`SELECT inet_server_port()` et l’identifiant système de `pg_control_system()`). Le service PostgreSQL du port 5432 n’est jamais utilisé par les tests.

### Authentification

`pg_hba.conf` de l’instance de test :

~~~text
host    all             resonances_app_reader   127.0.0.1/32            scram-sha-256
host    all             resonances_app_reader   ::1/128                 scram-sha-256
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
(règles de réplication trust inchangées)
~~~

- Les deux règles SCRAM ciblées doivent **précéder** les règles `trust` : PostgreSQL applique la première règle qui correspond.
- Le lecteur public `resonances_app_reader` doit ainsi s’authentifier par mot de passe, comme en production : un mauvais mot de passe ou l’absence de mot de passe est refusé. Le test « a database failure surfaces as a generic error without SQL » (`tests/public-read.pg.test.ts`) dépend de ce refus ; il échoue sous `trust`.
- Les autres rôles restent en `trust` sur cette instance locale uniquement. Les mots de passe sont générés par les tests eux-mêmes ; aucun secret n’est stocké dans le dépôt. Ne jamais reprendre cette configuration `trust` hors de l’instance de test.
- L’instance n’écoute que sur `127.0.0.1` : la règle `::1` est inactive tant que l’écoute n’est pas étendue.

### Deux profils de validation

| Profil | Commande | Rôle |
|---|---|---|
| Parallèle (par défaut) | `npm test` | profil courant ; les fichiers s’exécutent en parallèle |
| Séquentiel | `npx tsx --test --test-concurrency=1 tests/*.test.ts` | même sélection de fichiers, un fichier à la fois |

Le test 7 de `tests/views-owner-lock.pg.test.ts` (« brutal interruption… ») n’interrompt sa session victime que si son détenteur est le prochain dans la file du verrou de rôle partagé ; sinon il **s’ignore** (`another session was queued for the role lock; not interrupted`) pour ne pas exposer l’appartenance résiduelle à un autre fichier. En profil parallèle, cette condition dépend de l’ordonnancement : le test peut être ignoré. Un test ignoré n’est pas un test exécuté : lorsqu’il est ignoré, valider ce scénario par le profil séquentiel ou par `npx tsx --test tests/views-owner-lock.pg.test.ts`.

Validation du 13 novembre 2026 (`main` @ `c8e9eca`, SCRAM ciblé actif) : profil parallèle 430 réussis, 0 échec, 1 ignoré sur 431, deux fois ; profil séquentiel 430/0/1 ; le seul test ignoré est « symbolic links are refused (file link) » (liens symboliques de fichiers non autorisés sous Windows) ; le test 7 a réellement exécuté son scénario dans chaque exécution. Lors d’une session précédente le même jour, il s’était ignoré dans trois exécutions parallèles sur trois : son exécution en profil parallèle n’est pas garantie. Aucune erreur `53300` ; pic de 28–29 connexions en parallèle, 10 en séquentiel, pour `max_connections = 100`.

## Vérification du SQL

npm run db:check contrôle les métadonnées Drizzle. npm run db:verify génère depuis zéro dans un répertoire temporaire .local/schema-check-UUID et compare le SQL à 0000_editorial_core.sql. Cela détecte aussi une modification manuelle de la migration que le seul snapshot ne détecterait pas. Ce vérificateur est explicitement limité à une migration initiale ; il faudra le faire évoluer lors de l’ajout de migrations.

Les SQL et snapshots générés ne sont pas reformatés manuellement. Les fichiers maintenus à la main sont formatés avec Prettier.

## Points restant ouverts

- La validation éditoriale et l’import privé, notamment la provenance détaillée.
- Les choix D07 et suivants, sans changement de statut.
- L’intégration Next.js, les versions correspondantes et les futures couches Service/Repository.
- La normalisation définitive des langues et les règles de taxonomie multilingue.
- L’audit npm signale quatre alertes modérées dans la chaîne de développement Drizzle Kit → esbuild-kit → esbuild. La correction automatique propose une rétrogradation majeure ; elle n’est pas appliquée. Aucun serveur esbuild/Studio n’est lancé par ce socle. Les dépendances runtime font l’objet d’un contrôle séparé.

Sources techniques : [Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql) et [contraintes Drizzle](https://orm.drizzle.team/docs/indexes-constraints), consultées le 27 septembre 2026.

## Prochaine étape proposée — à valider

Relire ce socle physique, puis définir les contrats Markdown/frontmatter et la validation éditoriale avant de développer l’import privé transactionnel. Ne pas commencer les pages ni les entités différées automatiquement.

## Résultats réellement obtenus

Environnement : Node 24.15.0, npm 11.12.1, PostgreSQL **18.6**. Instance séparée liée à 127.0.0.1:55439, créée sous .local/postgres-tests avec un rôle de test et authentification trust uniquement pour cette instance locale. Elle est arrêtée à la fin de la session ; aucune modification du service PostgreSQL existant. Ne jamais utiliser cette configuration trust en production. (Résultats historiques de la première session ; la configuration actuelle de l’instance, avec SCRAM ciblé pour le lecteur public, est décrite dans « Instance PostgreSQL de test ».)

| Vérification | Résultat |
|---|---|
| npm run build | Réussi : compilation TypeScript du socle |
| npm run typecheck | Réussi |
| npm run format:check | Réussi |
| npm run db:check | Réussi |
| npm run db:verify | SQL initial identique à une génération indépendante |
| npm test | 18 tests réussis, 0 échec, 0 ignoré |
| npm audit --omit=dev | 0 vulnérabilité signalée |
| npm audit --json | 4 alertes modérées dans l’outillage de développement, décrites ci-dessus |

Le premier test a échoué avec zéro table avant implémentation. Après génération, quatre tests attendaient à tort SQLSTATE 23503 lors d’une suppression RESTRICT : PostgreSQL 18.6 renvoie 23001. Le diagnostic a confirmé le bon comportement de la contrainte ; les attentes ont été corrigées. Les insertions avec références inexistantes restent vérifiées avec 23503. Les tests de visibilité ont ensuite été ajoutés et passés avec le prédicat Drizzle.

Commandes de réalisation effectivement exécutées, en plus des contrôles ci-dessus :

~~~powershell
npm install --save-exact drizzle-orm pg
npm install --save-dev --save-exact drizzle-kit typescript tsx @types/node @types/pg prettier
npm run db:generate -- --name=editorial_core
npx prettier --write "db/*.ts" tests scripts drizzle.config.ts tsconfig.json package.json
npm ls --depth=0
~~~

L’instance isolée a été créée avec initdb et démarrée/arrêtée avec pg_ctl du PostgreSQL installé. Chaque exécution de npm test a créé puis supprimé sa propre base temporaire. npm ci figure dans la procédure de reproduction, mais n’a pas été exécuté pendant cette session. Aucun linter ESLint n’est configuré dans ce socle ; formatage et typage ont été contrôlés.

Les fichiers SQL sont numérotés et accompagnés du journal/snapshot Drizzle. Le dossier ne possède pas encore de dépôt Git initialisé : aucun commit ni push n’a été effectué. Il faudra initialiser/versionner le dépôt pour bénéficier de l’historique Git, en conservant .local/, node_modules/, dist/ et les secrets exclus.

