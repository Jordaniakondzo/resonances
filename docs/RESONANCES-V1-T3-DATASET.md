# Résonances V1 — T3 : jeu de données éditorial synthétique contrôlé

**Date :** 12 novembre 2026  
**Branche :** `codex/t3-editorial-dataset` (depuis `main` a2339af)  
**Références :** [contrat D03](RESONANCES-V1-D03-IMPORT-DESIGN.md), [contrat éditorial](RESONANCES-V1-EDITORIAL-CONTRACT.md), [politique des écrivains SQL](operations/SQL-WRITER-POLICY.md), [checklist éditoriale](operations/EDITORIAL-PUBLICATION-CHECKLIST.md), [ADR-B1](adr/ADR-B1-PRIVILEGED-REFERENCE-LOCKING.md)  
**Statut :** implémenté et vérifié sur PostgreSQL 18.6 jetable ; en attente de revue indépendante.

## 1. Rôle

T3 fournit un petit jeu de données **synthétique, déterministe et publicisable** qui passe par le moteur D03 existant, sans second moteur ni écriture éditoriale parallèle. Il démontre le trajet :

```text
bootstrap des références (Theme, MediaAsset)
→ Markdown/frontmatter
→ dry-run D03
→ import D03
→ PostgreSQL
→ lectures publiques existantes
```

et fournit aux tranches applicatives suivantes les cas de visibilité utiles : publié passé, brouillon, publié à date future, archivé, pour les deux types de contenu.

**Données de développement, pas corpus autorisé.** Les textes, thèmes et médias sont fictifs. Les URL des médias utilisent le domaine réservé `.test` et ne désignent aucun fichier. Les valeurs `source` et `license` du média « prêt » satisfont seulement le contrôle automatique D03 (texte non blanc) ; elles déclarent explicitement qu’aucune licence ni autorisation de diffusion n’a été vérifiée. Rien dans ce jeu ne vaut validation juridique, revue de la [checklist éditoriale](operations/EDITORIAL-PUBLICATION-CHECKLIST.md) ni décision **AUTORISÉ POUR DIFFUSION**. Il ne doit jamais être importé dans une base de diffusion publique.

## 2. Emplacement

```text
tests/fixtures/t3-dataset/
  references.sql                 bootstrap Theme + MediaAsset (hors D03)
  content/publications/*.md      4 Publications (sources D03)
  content/reflections/*.md       2 Reflections (sources D03)
tests/t3-dataset.pg.test.ts      preuve de bout en bout sur base jetable
```

Le jeu est placé sous `tests/fixtures/` et non dans `content/` : `content/` reste le répertoire des sources éditoriales du dépôt (aujourd’hui deux exemples brouillons sans slug), destiné à terme au corpus réel. `loadSources(racine)` accepte n’importe quelle racine contenant `content/publications` et `content/reflections` ; le jeu T3 n’est donc jamais chargé par une découverte sur la racine du dépôt.

## 3. Deux circuits distincts

| Circuit | Fichier | Tables écrites | Justification |
| --- | --- | --- | --- |
| Bootstrap des références | `references.sql` | `themes`, `media_assets` uniquement | D03 ne crée jamais Theme ni MediaAsset ; ce fichier joue le rôle du circuit contrôlé distinct décrit par la politique des écrivains SQL, pour une base isolée seulement. |
| Import éditorial D03 | `content/**/*.md` via `runDryRun` puis `runImport` | `publications`, `reflections`, `publication_themes`, `reflection_themes` | Seul circuit d’écriture des contenus éditoriaux. |

`references.sql` n’est **pas** une migration : il est hors de `db/migrations`, ne change aucune structure et n’est pas inscrit au journal Drizzle. C’est une seule transaction d’`INSERT` à identifiants fixes : une seconde exécution sur la même base échoue sur les clés primaires et n’écrit rien. Aucun `ON CONFLICT` ne masque une ligne existante différente. Le test vérifie statiquement que ce fichier n’écrit aucune des quatre tables éditoriales.

## 4. Jeu de données exact

Locale `fr` partout. Tous les documents portent dès leur premier import leur **slug définitif**, brouillons compris (D03-SLUG-01).

### Références

| Type | UUID | Clé | Remarque |
| --- | --- | --- | --- |
| Theme | `73a00000-0000-4000-8000-000000000001` | `confiance` | Confiance |
| Theme | `73a00000-0000-4000-8000-000000000002` | `presence` | Présence |
| Theme | `73a00000-0000-4000-8000-000000000003` | `distance` | Distance |
| MediaAsset A | `73b00000-0000-4000-8000-000000000001` | deux tasses | Métadonnées complètes, variante Web, 1600×1067 : passe le contrôle automatique D03 pour `published`. |
| MediaAsset B | `73b00000-0000-4000-8000-000000000002` | quai et valise | Ni alt, ni source, ni licence, ni variante Web, ni dimensions : réservé aux contenus non publics. |

### Contenus et visibilité attendue

| Fichier | Type | UUID | Statut | `published_at` | Média | Thèmes | Public |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `deux-tasses-a-la-fenetre.md` | Publication | `73c0…0001` | published | 2026-03-14T09:30:00Z | A | confiance, presence | **oui** |
| `le-quai-avant-le-depart.md` | Publication | `73c0…0002` | draft | — | B | distance | non |
| `la-tasse-encore-pleine.md` | Publication | `73c0…0003` | published | 2099-01-01T08:00:00Z | A | presence | non (date future) |
| `une-valise-pres-du-banc.md` | Publication | `73c0…0004` | archived | 2026-02-01T10:00:00Z | B | distance, confiance | non (archive) |
| `etre-la-sans-tout-dire.md` | Reflection | `73d0…0001` | published | 2026-04-02T18:15:00Z | A (couverture) | presence, distance | **oui** (règle de visibilité) |
| `la-distance-qui-protege.md` | Reflection | `73d0…0002` | draft | — | B (couverture) | confiance | non |

`presence` est partagé entre une Publication et une Reflection publiées ; trois contenus portent plusieurs thèmes ; 9 associations au total. Les Publications publiées respectent Observation → Évocation → Réflexion → Question ouverte, avec une évocation explicitement interprétative. Le média A sert deux Publications (P1 et P3) : c’est une simplification du jeu, P3 n’étant visible qu’en 2099.

## 5. Commande reproductible

Prérequis : une instance PostgreSQL **dédiée aux tests** (jamais une base existante), un rôle **superutilisateur** de test (`CREATEDB` et `CREATEROLE` ne suffisent pas : bootstrap des références, sondes du catalogue et verrou de `pg_auth_members` l'exigent, comme pour le reste de la suite), démarrée et configurée comme décrit dans [Instance PostgreSQL de test](RESONANCES-V1-DATA-CORE.md#instance-postgresql-de-test) (SCRAM pour le lecteur public, une seule suite à la fois). Exemple PowerShell :

```powershell
$env:TEST_DATABASE_URL = 'postgresql://SUPERUSER_DE_TEST@127.0.0.1:55439/postgres'
npm run test:t3-dataset
```

Le test crée une base temporaire `resonances_test_<uuid>`, provisionne les rôles ADR-B1 et T2 avec les fichiers de `db/provisioning`, applique les migrations, puis enchaîne : bootstrap des références (superutilisateur), dry-run et import (un rôle de connexion propre au test, doté des seuls privilèges de l’importeur), lectures publiques (rôle `resonances_app_reader`). Il supprime ensuite **seulement** sa base temporaire. Le rôle de connexion `resonances_t3_test_import_login` reste défini dans l’instance de test, comme les rôles de connexion des autres fichiers de test. `npm test` inclut aussi ce fichier.

Aucun script CLI d’import n’est ajouté : le moteur D03 reste sans script ni route d’exécution (contrat D03 §11). Préparer une base de développement persistante à partir de ce jeu demanderait un tel point d’entrée, ce qui relève d’une tâche ultérieure.

## 6. Ce que le test prouve

`tests/t3-dataset.pg.test.ts` exécute neuf étapes ordonnées d’un même scénario :

1. le chargement trouve exactement les six documents, chacun avec locale et slug définitifs ;
2. le bootstrap crée exactement trois thèmes et deux médias, aucune ligne éditoriale ; A passe `mediaReadinessProblems`, B échoue sur `alt_text`, `source`, `license` ;
3. le dry-run renvoie `PLANNED`, plan applicable de six CREATE, sans commande de mutation, sans appel `d03_priv`, avec des versions de lignes (`xmin`) identiques avant/après ;
4. l’import renvoie `APPLIED`, `committed: true`, une tentative, compteurs 6/0/0, **plan committé identique au plan du dry-run** ; verrous B1 dans l’ordre et le mode attendus (trois `lock_theme`, `lock_media_ready` pour A, `lock_media_key` pour B) ; seules les quatre tables éditoriales reçoivent des `INSERT` ;
5. lignes, `published_at` à la microseconde, références média et associations de thèmes conformes ;
6. toutes les lignes éditoriales portent la même version de transaction, distincte de celle du bootstrap ;
7. le même import relancé renvoie `APPLIED` avec six NOOP (0/0/6), **aucune commande de mutation émise**, aucune version de ligne, `updated_at` ou association modifiée, et la préparation du média A revalidée sous `lock_media_ready` ;
8. via le service et les vues publiques T2 sous le rôle lecteur : seule la Publication publiée passée apparaît dans la liste et par slug ; brouillon, date future et archive renvoient `null` ; thèmes, image Web, alt et dimensions exposés ; URL originale jamais exposée ; les associations publiques ne concernent que cette Publication ;
9. pour les Reflections, la règle partagée `publicContentWhere` ne retient que la Reflection publiée passée.

**Portée du détecteur de mutations.** Le journal des commandes SQL est filtré par une expression régulière (`isMutation`) qui reconnaît les commandes commençant par `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` ou `MERGE`, c’est-à-dire les formes actuellement émises par D03. Il ne couvre pas toutes les constructions SQL possibles (par exemple une écriture dans une CTE `WITH … INSERT`, une fonction appelée par un `SELECT` ou un commentaire en tête de commande). L’absence de mutation n’en dépend pas seule : elle est aussi établie par les commandes observées (contrôle positif de l’étape 4, qui voit les `INSERT` du premier import), par le contenu des tables et par l’identité des `xmin` et de `updated_at` avant et après le second import. Une évolution de D03 vers d’autres formes d’écriture demanderait de réexaminer ce filtre.

## 7. Limites et écarts constatés

- **Aucune frontière de lecture publique pour les Reflections.** T2 n’expose que les Publications (`public_read.publications`, `public_read.publication_themes`). Le rôle lecteur n’a aucun droit sur `reflections` (le test le constate : `42501`). La visibilité des Reflections n’est donc vérifiée qu’avec la règle `publicContentWhere` appliquée aux tables, pas à travers une couche publique. L’ajout d’une vue publique demanderait une nouvelle migration et relève d’une tâche ultérieure (lecture des Réflexions).
- **Identité du lecteur.** Le test ne se connecte pas avec le mot de passe de `resonances_app_reader`, possédé par `tests/public-read.pg.test.ts` qui peut s’exécuter en parallèle : il ouvre des sessions superutilisateur basculées au démarrage sur ce rôle (`-c role=…`, plus `default_transaction_read_only=on`). Les contrôles de privilèges portent sur `current_user`, vérifié égal au rôle lecteur ; l’authentification du rôle lui-même n’est pas exercée ici.
- **Horloge.** La visibilité dépend de `now()` de PostgreSQL. La Publication datée du 1er janvier 2099 deviendra visible à cette date sans nouvel import.
- **Écart dry-run / import.** Aucun pour ce jeu sur base isolée sans écrivain concurrent ; le test l’affirme par égalité stricte des deux plans. Ce n’est pas une garantie générale (contrat D03 §10).
- **Ordre du plan.** Les opérations sortent dans l’ordre `(type, id)` (contrat D03 §6), non dans l’ordre des chemins.
- Les médias ne sont ni téléchargés ni vérifiés : aucun fichier n’existe aux URL indiquées.
