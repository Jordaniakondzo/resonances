# Revue indépendante du sous-lot D03-01 (snapshots, instants, diff, diagnostics)

**Rôle :** Independent Senior TypeScript Reviewer, Test Engineer et Architecture Compliance Auditor, en lecture seule
**Worktree :** `resonances-d03-01-snapshots` (worktree local, depuis retiré)
**Branche :** `codex/d03-01-snapshots`
**Commit de départ :** `0de39c6337482372494a427ffc1058981ac75a80` (identique à `main` et `origin/main`)
**Changements examinés :** quatre fichiers non suivis, aucun commit
**Date :** 9 octobre 2026
**Verdict : READY WITH CONDITIONS**

> Les numéros de ligne cités se rapportent aux fichiers non suivis tels qu'examinés le 9 octobre 2026, avant tout commit D03-01.
>
> **Suite :** les constats M1, m1, m2 et m4 ont été corrigés puis vérifiés dans la [seconde revue D03-01](D03-01-SNAPSHOTS-REREVIEW-0de39c6.md), verdict READY TO COMMIT.

Lecture seule stricte : aucun fichier du dépôt modifié, aucun commit. Les sondes et mutants ont été exécutés sur une copie dans un répertoire temporaire hors dépôt.

## 1. Périmètre Git vérifié

- Branche `codex/d03-01-snapshots`, `HEAD = 0de39c6337482372494a427ffc1058981ac75a80`.
- Exactement quatre fichiers non suivis :
  - `src/editorial/instant-us.ts` (22 lignes)
  - `src/editorial/snapshots.ts` (75 lignes)
  - `src/editorial/operations.ts` (220 lignes)
  - `tests/snapshots.test.ts` (241 lignes)
- Aucun fichier suivi modifié, aucun fichier ignoré ajouté hormis `node_modules/`.
- Autres worktrees inchangés : `resonances` (`codex/d03-import-design`, avec les changements préexistants `M README.md` et `?? docs/design/`) et `resonances-d03-integration` (`main`, propre).
- Aucune migration, aucun writer, aucun repository ajouté.

## 2. Conformité au contrat D03

- **§3 :** les types sont conformes au contrat. `InstantUs` est un type marqué (branded), plus strict qu'un simple `string`, ce que le §3 autorise (« syntaxe ajustable »).
- **§4 :**
  - les thèmes sont comparés comme des ensembles triés et dédupliqués ;
  - la comparaison de `null` est exacte ;
  - le chemin source et les timestamps techniques ne font pas partie du snapshot ;
  - la clé `(locale, slug)` est vérifiée avant le diff.
- **§5 et D03-SLUG-01 :**
  - CREATE, UPDATE avec diff non vide, NOOP, TYPE_CHANGE et IMMUTABLE_EDITORIAL_KEY sont corrects ;
  - les transitions `null → slug` et `slug → null` sont refusées pour tous les statuts.
- **§13 et §14 :** le sous-lot 1 n'est que partiellement couvert (voir M1 et m2).
- **Hors D03-01, conformément au §14 :**
  - la cohérence de `ImportPlan.applicable` et le tri déterministe des opérations relèvent du sous-lot 3 ;
  - la lecture PostgreSQL à la microseconde relève du sous-lot 2.

## 3. Constats

### BLOCKING

Aucun.

### MAJOR

**M1 — La complétude des champs comparés n'est garantie ni par le typage ni par les tests.**

- **Code concerné :** `operations.ts:98-113` et `:122`. Le paramètre `fields: readonly DiffField<S>[]` accepte un sous-ensemble des champs.
- **Mutants survivants dans le diff :** six retraits de champ sur sept passent les 10 tests : `status`, `mediaAssetId`, `observation`, `openQuestion`, `excerpt`, `coverMediaId`. Seul le retrait de `publishedAt` est détecté.
- **Conséquence possible :** un faux NOOP. Une transition `draft → published` ou un changement de média serait ignoré, ce qui viole §4 et §12.3.
- **Mutants survivants dans la construction des snapshots :** pour `snapshotFromResolved` (`snapshots.ts:78-96`), `excerpt`, `content` et `openQuestion` remplacés par `null` survivent. Seule une Publication aux sections nulles est testée.
- **Correction minimale :**
  - ajouter une garde d'exhaustivité typée, par exemple un objet `satisfies Record<DiffField<PublicationSnapshot>, true>` dont la liste est dérivée ;
  - ajouter un test en table qui modifie chaque champ isolément, pour les deux types ;
  - ajouter un test `snapshotFromResolved` pour une Reflection dont les champs sont non nuls.

### MINOR

**m1 — L'année 0000 est acceptée** (`instant-us.ts:3`, `:8`, `:14-18`).

- **Constat :** le parseur accepte `0001-01-01T00:00:00+01:00`, qui donne `"0000-12-31T23:00:00.000000Z"` (sonde exécutée). `parseInstantUs` accepte aussi l'année 0000.
- **Cause :** en JavaScript, l'année 0 correspond à l'an 1 av. J.-C. Le motif `to_char(... 'YYYY')` du §4 n'affiche pas l'ère et lirait `0001`.
- **Effet attendu :** un UPDATE perpétuel ou une date mal interprétée. Ce comportement reste à confirmer sur PostgreSQL réel.
- **Correction :** refuser les années inférieures à 0001 dans les deux fonctions. Le SQL du sous-lot 2 devra aussi refuser les dates av. J.-C.

**m2 — Invariants secondaires non testés** (les mutants survivent) :

- ajout de thème seul : la vérification de longueur (`operations.ts:130-131`) peut être supprimée sans échec de test ;
- `before` et `after` canoniques dans un UPDATE ;
- priorité de TYPE_CHANGE sur IMMUTABLE_EDITORIAL_KEY ;
- présence de `id` dans un CONFLICT ;
- CREATE d'une Reflection ;
- changement simultané de locale et de slug ;
- cas du §13 « timestamps techniques différents » ;
- NOOP pour un même instant exprimé dans deux fuseaux.

**m3 — Le message de `ParseDiagnostic` duplique le fichier et le champ** (`operations.ts:94`, `types.ts:32`).

- **Exemple :** `"content/x.md: title: Titre requis."`, alors que `file` et `field` sont déjà séparés.
- **Test :** le message n'est pas vérifié (`snapshots.test.ts:227-239`).
- **Correction :** conserver le message brut. Cela touche `types.ts`, un fichier préexistant ; la décision est à arbitrer.

**m4 — Les propriétés supplémentaires sont propagées dans les opérations** (`operations.ts:115-117`).

- **Constat :** une ligne de base portant `createdAt`, `updatedAt` et `sourcePath`, passée en `before`, se retrouve telle quelle dans `UPDATE.before` (sonde exécutée).
- **Impact :** l'égalité n'est pas faussée, car la comparaison repose sur une liste blanche de champs. Mais le plan peut exposer des champs techniques et le chemin source.
- **Correction :** construire les snapshots explicitement, ici ou dans les repositories.

### INFORMATIONAL

- **i1 — Échec de `format:check` sur 13 fichiers préexistants :**
  - la cause est la configuration `core.autocrlf=true`, qui donne des fichiers `i/lf w/crlf` ;
  - les versions commitées de ces fichiers passent Prettier, et tout passe avec `--end-of-line crlf` ;
  - les quatre nouveaux fichiers sont en LF et passent ;
  - ce n'est pas un problème de D03-01.
- **i2 — Contrat implicite de `classifySnapshot` pour les sous-lots suivants :**
  - NOOP signifie seulement que les valeurs sont égales ; l'appelant doit encore revalider les références et la préparation des médias ;
  - TYPE_CHANGE n'est détecté que si l'appelant passe en `before` la ligne de l'autre table ;
  - `before` est optionnel, donc son oubli produit un CREATE silencieux ;
  - un JSDoc et des tests au sous-lot 3 sont recommandés.
- **i3 — Conversions forcées :**
  - `as SnapshotDiff<S>` (`:141`), `as readonly string[]` (`:130-134`), `diff as [...]` (`:186`) et `as InstantUs` (`instant-us.ts:10`, `:21`) sont justifiées localement ; aucune ne masque d'incohérence aujourd'hui ;
  - le typage n'empêche toutefois pas de construire un UPDATE dont le diff contredit `before` et `after`, ni de forger un `InstantUs` par conversion.
- **i4 — Diagnostic de clé :** quand la locale et le slug changent tous les deux, seul `field: "locale"` est rapporté (`:174`).
- **i5 — Casse des UUID :** les comparaisons sont sensibles à la casse. La garantie repose sur le parseur (`parse.ts:115`, mise en minuscules) et sur la sortie `uuid` de PostgreSQL. Les repositories du sous-lot 2 ne doivent pas transformer ces valeurs.
- **i6 — Aucun commentaire dans les nouveaux fichiers :** le CREATE dupliqué (`operations.ts:196-199`) est nécessaire au rétrécissement de type (son retrait provoque `TS2322`, vérifié). Un bref commentaire en anglais aiderait (AGENTS.md §18).
- **i7 — Sémantique de `InstantUs` :** c'est une chaîne canonique de largeur fixe. L'égalité de chaînes équivaut à l'égalité d'instants, et l'ordre lexicographique correspond à l'ordre chronologique entre les années 0000 et 9999.

## 4. Tests réellement exécutés

| Commande                                       | Résultat                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit` (= `npm run typecheck`)     | exit 0                                                                                                                                                                                                            |
| `npm run test:editorial`                       | 76/76 réussis                                                                                                                                                                                                     |
| `npx tsx --test tests/snapshots.test.ts`       | 10/10 réussis                                                                                                                                                                                                     |
| `prettier --check` sur les 4 nouveaux fichiers | réussi                                                                                                                                                                                                            |
| `npm run format:check`                         | exit 1, 13 fichiers préexistants, cause CRLF (i1)                                                                                                                                                                 |
| 12 sondes de types (copie hors dépôt)          | 8 erreurs attendues confirmées (UPDATE mixte, diff vide, champ `slug` ou d'un autre type, `UpdateOperation<EditorialSnapshot>`, chaîne simple non acceptée comme `InstantUs`) ; 4 cas « doit compiler » compilent |
| 31 mutants (copie hors dépôt)                  | 16 survivants (M1, m2), dont 1 équivalent (« Date invalide » : `toISOString` lève déjà l'erreur)                                                                                                                  |
| Sondes d'exécution                             | année 0000, propriétés supplémentaires, casse des UUID, entrées gelées (NOOP sans mutation)                                                                                                                       |

**Non exécutés :** `npm test`, qui inclut `schema.test.ts` et nécessite PostgreSQL, et `db:verify`.

## 5. Risques pour les sous-lots suivants

- **Sous-lot 2 :**
  - lire `published_at` à la microseconde en refusant les dates av. J.-C. ;
  - convertir explicitement en diagnostic toute `RangeError` levée par `parseInstantUs`.
- **Sous-lot 3 :**
  - traiter un NOOP dont la revalidation échoue ;
  - rechercher l'UUID dans les deux tables ;
  - garantir la cohérence de `applicable` et le tri déterministe.
- **Construction manuelle d'opérations :** les sous-lots suivants ne doivent pas construire d'opérations à la main en contournant `classifySnapshot`.

## 6. Corrections minimales recommandées

1. **M1 (condition du verdict) :** ajouter la garde d'exhaustivité typée, les tests champ par champ pour les deux types, et le test `snapshotFromResolved` d'une Reflection.
2. **m1 (recommandé) :** refuser les années inférieures à 0001.
3. **Optionnel :** ajouter les tests de m2, arbitrer m3 et construire explicitement les snapshots (m4).

## 7. Verdict

**READY WITH CONDITIONS.** Aucun défaut n'a été constaté dans le comportement actuel. En revanche, le NOOP strict dépend d'une liste de champs que ni TypeScript ni les tests ne protègent : M1 doit être corrigé avant le commit, et m1 est recommandé.
