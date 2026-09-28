# Résonances V1 — Contrat Markdown et validation

Version 1.0 — 28 septembre 2026.

Autorité : [D03](RESONANCES-V1-L0-DECISIONS.md#d03--circuit-éditorial), [spécification](RESONANCES-V1-SPECIFICATION.md), [Data Core](RESONANCES-V1-DATA-CORE.md). D01–D06 restent validées ; D07/D08 restent ouvertes. Aucune migration ni refonte du Data Core.

## Portée réalisée

Parsing pur, validation éditoriale, normalisation et résolution de références existantes en lecture seule. Aucun import, upsert, plan de mutations, rendu HTML, page publique ou dry-run complet n’est implémenté.

Le dépôt applicatif est public : `status: draft` protège la visibilité future dans l’application, **pas la confidentialité du fichier sur GitHub**. Les exemples de `content/` sont synthétiques et publicisables. Les brouillons confidentiels et traces privées de provenance devront rester dans des sources Git privées ; le futur import pourra lire ces fichiers séparément. D03 impose Git, pas un dépôt public pour les contenus confidentiels.

## Choix et alternatives

- UUID stable : identité technique, conservée lors des changements de titre, slug et chemin. Le futur upsert cible l’UUID dans la table indiquée par `type`. Un changement de type sera une opération explicite, jamais une conversion silencieuse.
- Thèmes par slug : écriture lisible, résolution exacte par `(locale, slug)`, sans création automatique ni fallback de langue. Un renommage de thème exige la mise à jour des sources. Les UUID seraient plus stables lors des renommages, mais moins pratiques à éditer. Cette règle de ce circuit n’ajoute pas une contrainte SQL globale interdisant toute association multilingue.
- `excerpt` obligatoire en publication : garantit les aperçus et le corpus D01. L’alternative d’extraire le début du corps a été écartée pour éviter une sélection implicite.
- Clés inconnues et doublons YAML rejetés : les fautes sont signalées plutôt qu’ignorées.
- Dates ISO avec fuseau explicite : pas d’interprétation dépendant du poste de travail. Les dates futures restent acceptées ; `publicContentWhere` reste inchangé.
- Aucun stockage de provenance ajouté. À terme, une fiche associée au média devrait regrouper source/auteur/licence et, pour l’IA, outil, date, brief/prompt, retouches et droits. Un manifeste privé versionné pourrait garder les détails sensibles ; base ou manifeste restent à arbitrer avec D07.

## Organisation et API

```text
content/publications/*.md
content/reflections/*.md

source + chemin → parseContent → ParsedPublication | ParsedReflection
                                   ↓
                         resolveReferences(reader)
                                   ↓
                       contenu normalisé + themeIds
```

`parseContent(source, file)` ne lit ni disque ni base. Le chemin sert uniquement à vérifier le type et à localiser les erreurs : fichier `.md` directement sous `content/publications` ou `content/reflections`, chemins Windows et POSIX acceptés. Le lecteur appelant doit fournir le chemin réel. Aucun hash ni identifiant n’est dérivé de ce chemin.

`resolveReferences(content, reader, file)` attend un résultat du parseur. Son interface de lecture est indépendante de Drizzle. L’adaptateur `editorialReferences(db)` contient seulement des SELECT paramétrés. Il vérifie aussi les références fournies sur un brouillon ou une archive. Les erreurs sont des `ContentValidationError` avec fichier, champ et message ; la première erreur arrête le document.

Les types normalisés emploient les noms TypeScript du schéma : `publishedAt`, `mediaAssetId`, `coverMediaId`, `openQuestion`. Drizzle les mappe déjà à `published_at`, `media_asset_id`, `cover_media_id`, `open_question`. Les sections et le corps restent du Markdown, jamais du HTML généré.

## Frontmatter

Délimiteurs `---` sur une ligne, en tête du fichier. YAML 1.2 core, mapping uniquement, clés uniques, tags personnalisés et alias refusés. BOM initial et fins de ligne Windows acceptés. Maximum : 1 000 000 caractères ; NUL interdit.

Champs obligatoires pour tous les statuts : `type`, `id`, `locale`, `status`.

| Champ                    | Contrat                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `type`                   | `publication` ou `reflection`, cohérent avec le répertoire                                                                           |
| `id`                     | UUID canonique version 1–8, normalisé en minuscules ; aucun UUID créé par le parseur                                                 |
| `locale`                 | Tag reconnu par `Intl.getCanonicalLocales`, langue de 2–3 lettres ; forme canonique, p. ex. `fr-CA`. Aucun multilingue public ajouté |
| `status`                 | `draft`, `published`, `archived`                                                                                                     |
| `slug`                   | ASCII minuscule, chiffres, tirets internes ; même règle que SQL                                                                      |
| `title`                  | Chaîne non vide si fournie                                                                                                           |
| `themes`                 | Liste de slugs ; absente/null → ensemble vide ; doublons éliminés et ordre trié                                                      |
| `published_at`           | Absente/null ou `YYYY-MM-DDTHH:mm:ss[.SSS]Z` / décalage `±HH:mm` ; date réelle, précision maximale milliseconde                      |
| `hook`, `media`          | Uniquement Publication ; média sous forme `{id: UUID}`                                                                               |
| `excerpt`, `cover_media` | Uniquement Reflection ; couverture facultative sous forme `{id: UUID}`                                                               |

Les chaînes sont débarrassées des espaces de bord. Un champ éditorial absent/null devient null ; une chaîne explicitement vide est une erreur (utiliser null). Les types incorrects ne sont pas convertis. Les champs SQL `created_at` et `updated_at` sont gérés par le futur import, pas par l’auteur.

### Brouillons et archives

Les quatre champs obligatoires suffisent. Les champs présents restent soumis à leur validation syntaxique et de sécurité. Une archive peut être incomplète ; son statut ne contourne pas la validation d’une référence fournie.

### Publication publiée

Exige slug, titre, hook, média, au moins un thème, date et quatre sections non vides. Les sections sont des H2 simples, uniques et ordonnées :

```markdown
## Observation

Description de la scène.

## Évocation

Interprétation explicitement subjective.

## Réflexion

Développement de l’idée.

## Question ouverte

Une question au lecteur ?
```

H3–H6 autorisés à l’intérieur. Pas de préambule, de H1 ou d’autre H2. En draft, les sections peuvent manquer mais celles présentes respectent l’ordre. Les titres dans les blocs de code ne sont pas des séparateurs. Les définitions de liens doivent rester dans la section qui les utilise, puisque les colonnes sont stockées indépendamment.

### Reflection publiée

Exige slug, titre, excerpt, corps, au moins un thème et date. Headings libres ; pas de couverture obligatoire.

## Markdown et sécurité

### Contenu éditorial substantif

Précision du 29 septembre 2026 : pour `published`, chacune des quatre sections d’une Publication et le corps d’une Reflection doivent contenir du contenu substantif. Dans l’AST CommonMark V1, les nœuds `text`, `inlineCode` et `code` comptent si leur valeur contient au moins un caractère non blanc. Les conteneurs `paragraph`, `blockquote`, `list`, `listItem`, `emphasis`, `strong`, `link` et `linkReference` sont parcourus récursivement.

Les headings (y compris leur texte), définitions de liens, séparateurs et sauts de ligne ne suffisent pas. Une liste ou citation composée uniquement de headings ne suffit donc pas non plus. Un heading suivi de prose, un code non vide ou un lien au libellé non vide restent acceptés ; une URL ou une définition seule ne constitue pas un libellé. Les brouillons et archives restent autorisés à être incomplets. Cette règle vérifie la présence de matière, pas sa qualité littéraire.

`yaml@2.9.1` évite un parseur YAML artisanal. `mdast-util-from-markdown@2.0.3` produit l’AST CommonMark et les positions nécessaires à l’extraction des sections. Compatibilité ESM/Node 24 vérifiée par compilation et tests. Pas de MDX, extension exécutable, `eval`, rendu ou plugin d’exécution.

Les nœuds HTML bruts sont rejetés, y compris dans les métadonnées textuelles. Les exemples de HTML dans les blocs de code sont du texte inerte et restent autorisés. Les expressions ressemblant à du JavaScript restent du texte : elles ne sont jamais compilées. Le futur renderer devra échapper les métadonnées et le code, ne pas activer MDX ni réinterpréter du HTML échappé.

Liens autorisés : HTTP(S), mailto, chemins commençant par un seul `/`, ancres `#`. Autres protocoles, chemins relatifs ambigus, contrôles et antislashs rejetés. Les entités des liens sont décodées par le parseur avant contrôle. Les images Markdown du corps sont provisoirement refusées, car elles contourneraient la référence `MediaAsset` et sa provenance ; leur syntaxe contrôlée reste à concevoir avec le workflow média.

Ce validateur ne prouve ni la qualité littéraire, ni les droits, ni l’existence du fichier média, ni la sécurité d’un futur renderer. Résoudre un UUID de média prouve seulement l’existence de sa ligne ; les métadonnées de publication/provenance doivent encore être vérifiées avant un import de production.

## SQL avant Drizzle

```sql
SELECT id FROM themes WHERE locale = $1 AND slug = $2 LIMIT 1;
SELECT id FROM media_assets WHERE id = $1 LIMIT 1;
```

La première requête utilise l’unicité `(locale, slug)` ; la seconde, la PK. Pas de création de thème ni de média. L’adaptateur effectue une lecture par thème, suffisante pour les petits documents V1 ; pas de traitement massif spéculatif.

## Contrat pour la prochaine étape

- Détecter les UUID répétés entre fichiers et les conflits de slug dans un lot avant écriture.
- L’identité de l’upsert est l’UUID, jamais le slug ; vérifier les changements de type.
- Les thèmes forment un ensemble déclaratif : remplacer l’ancien ensemble, pas seulement ajouter.
- Un document strictement inchangé doit devenir un no-op, y compris pour `updated_at`. Comparer valeurs normalisées, instants et ensembles ; le chemin n’intervient pas.
- Préparer un plan par des lectures uniquement pour le dry-run. Écrire puis rollback est écarté : les séquences et effets externes ne sont pas nécessairement annulés.
- Révalider les références et conflits dans la transaction d’import ; une résolution préalable seule ne protège pas d’une suppression concurrente. Les FK restent le dernier garde-fou.
- Définir la politique des changements de slug et des redirections avant les pages publiques.

## Vérifications

`npm run test:editorial` exécute la validation sans base. `npm test` inclut les tests PostgreSQL et exige `TEST_DATABASE_URL` vers une instance dédiée, comme décrit dans le Data Core. Les tests créent et suppriment seulement leur base temporaire.

Les tests couvrent les drafts, exigences de publication, erreurs YAML, dates impossibles/futures, type/répertoire, sections, headings libres, HTML, liens, identité stable et références. La résolution PostgreSQL est exercée dans une transaction READ ONLY après préparation des fixtures : c’est une preuve sur ce parcours, pas une preuve du futur import ou du dry-run complet. L’idempotence en base et le no-op ne sont pas encore implémentés ni testés.

Sources : [YAML](https://eemeli.org/yaml/) et [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown), consultées le 28 septembre 2026.

## Résultats de cette étape

Vérifications du 28 septembre 2026 :

| Commande                    | Résultat                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------- |
| npm run build               | Réussi, socle TypeScript                                                            |
| npm run typecheck           | Réussi                                                                              |
| npm run format:check        | Réussi                                                                              |
| npm run db:check            | Réussi                                                                              |
| npm run db:verify           | Migration initiale identique à une génération indépendante                          |
| npm test                    | 64 tests réussis : 44 éditoriaux, 18 Data Core, 2 parcours de résolution PostgreSQL |
| npm audit --omit=dev --json | 0 vulnérabilité signalée                                                            |
| npm audit --json            | 4 alertes modérées préexistantes dans la chaîne Drizzle Kit/esbuild                 |

Dépendances ajoutées avec versions exactes : `npm install --save-exact yaml@2.9.1 mdast-util-from-markdown@2.0.3` et `npm install --save-dev --save-exact @types/mdast@4.0.4`. Les types mdast sont déclarés directement parce que le code les importe. Aucun framework de validation supplémentaire.

Tests ciblés exécutés : `node --import tsx --test tests/editorial.test.ts`, puis `npm run test:editorial` ; résolution : `node --import tsx --test --test-name-pattern=editorial tests/schema.test.ts`. Les 35 premiers tests ont échoué face au point d’entrée vide avant implémentation ; les deux tests de résolution ont ensuite échoué sur le résolveur vide. Un test supplémentaire a révélé qu’une section ne contenant qu’un séparateur était acceptée ; le contrôle a été corrigé, puis toute la suite relancée.

L’instance PostgreSQL isolée existante a été démarrée avec `pg_ctl -D .local/postgres-tests -l .local/postgres-tests.log -o "-h 127.0.0.1 -p 55439" start`. Le premier démarrage sans ces options n’avait pas pu ouvrir le port par défaut ; les tests avaient alors échoué en connexion, avant d’être relancés correctement. Les tests utilisent `TEST_DATABASE_URL` vers cette instance et créent leur propre base temporaire ; ils ne modifient aucune base utilisateur. L’instance est arrêtée après vérification.

Prettier a été exécuté sur les fichiers TypeScript nouveaux/modifiés, package.json, tsconfig.json, README, le présent contrat et les exemples. Le schéma, la visibilité et les migrations existantes n’ont aucun diff. Aucun commit ni push effectué pendant cette étape.
