# Seconde revue indépendante du sous-lot D03-01, après corrections

**Rôle :** Independent Senior TypeScript Reviewer, Test Engineer et Architecture Compliance Auditor, en lecture seule
**Worktree :** `resonances-d03-01-snapshots` (worktree local, depuis retiré)
**Branche :** `codex/d03-01-snapshots`
**Commit de départ :** `0de39c6337482372494a427ffc1058981ac75a80`
**Changements examinés :** quatre fichiers non suivis, aucun commit
**Date :** 9 octobre 2026
**Verdict : READY TO COMMIT**

> **Revue précédente :** [première revue D03-01](D03-01-SNAPSHOTS-REVIEW-0de39c6.md), verdict READY WITH CONDITIONS. Elle décrit les constats M1, m1 à m4 et i1 à i7, dont cette revue vérifie la correction.
>
> Les numéros de ligne cités se rapportent aux fichiers non suivis tels qu'examinés après les corrections, avant tout commit D03-01.

Lecture seule stricte : aucun fichier, index ou worktree modifié, aucun commit. Les sondes de compilation et les mutants ont été exécutés sur une copie dans un répertoire temporaire hors dépôt.

## 1. État Git et périmètre examiné

- Branche `codex/d03-01-snapshots`, `HEAD = 0de39c6337482372494a427ffc1058981ac75a80`, inchangé.
- Toujours quatre fichiers non suivis, et rien d'autre hors `node_modules/` (ignoré) :
  - `src/editorial/instant-us.ts` : 24 lignes
  - `src/editorial/snapshots.ts` : 75 lignes
  - `src/editorial/operations.ts` : 266 lignes
  - `tests/snapshots.test.ts` : 500 lignes
- Aucun fichier suivi modifié. `src/editorial/types.ts` est identique à `HEAD` : `git diff --quiet` ne signale rien et la comparaison octet par octet, une fois les CRLF normalisés, est identique.
- Autres worktrees inchangés :
  - `resonances` : `M README.md`, `?? docs/design/` et le premier rapport D03-01, non suivi ;
  - `resonances-d03-integration` : propre.

## 2. Suivi des observations

| Obs.                                | Statut                | Preuve                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** — exhaustivité du diff       | **Résolu**            | Garde `AssertNever<Exclude<DiffField<S>, liste>>` (`operations.ts:116-122`) et `satisfies` sur les listes (`:108`, `:114`) ; tests paramétrés de 10 champs Publication et 7 champs Reflection (`snapshots.test.ts:260-317`). |
| **M1** — construction des snapshots | **Résolu**            | Tous les champs non nuls sont testés pour les deux types (`snapshots.test.ts:126-182`).                                                                                                                                      |
| **m1** — année 0000                 | **Résolu**            | Refus dans `instant-us.ts:8` et `:16-17` ; tests aux lignes `:83-90` et `:114-115`, frontières 0001 et 9999 comprises.                                                                                                       |
| **m2** — invariants secondaires     | **Résolu**            | Voir §4.                                                                                                                                                                                                                     |
| **m3** — message `ParseDiagnostic`  | **Reporté (accepté)** | Aucune régression ; `types.ts` n'a pas été modifié.                                                                                                                                                                          |
| **m4** — propriétés supplémentaires | **Résolu**            | Projection explicite dans `canonicalSnapshot` (`operations.ts:124-155`) ; tests CREATE, UPDATE et NOOP (`snapshots.test.ts:350-397`).                                                                                        |

## 3. Preuves de M1

### Garde à la compilation

Chaque modification a été appliquée sur une copie hors dépôt. Pour chacune, j'ai vérifié que la modification s'appliquait réellement, et que la copie non modifiée compilait sans erreur.

| Modification                                                                             | Résultat de `tsc`                                                                                           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Retrait de `openQuestion`, `status` ou `coverMediaId` d'une liste                        | `TS2344 … does not satisfy the constraint 'never'`                                                          |
| Ajout de `slug` à `publicationFields`                                                    | `TS1360` et `TS2345`, refus par `satisfies`                                                                 |
| Nouveau champ `credit` sur `PublicationSnapshot`, `ReflectionSnapshot` ou `SnapshotBase` | `TS2344`, plus des erreurs dans `canonicalSnapshot`, dans `snapshotFromResolved` et dans les tables de test |

L'ajout d'un champ métier provoque donc une erreur de compilation tant que la comparaison, les projections et les tests n'ont pas été mis à jour.

### Clé éditoriale et diff

`type`, `id`, `locale` et `slug` restent exclus du diff. `locale` et `slug` sont contrôlés séparément, avant le diff (`operations.ts:206`). L'ordre du diff suit la liste des champs et reste donc déterministe.

### Mutants d'exécution

tsx supprime les types : ces mutants contournent donc la garde de compilation et mesurent uniquement l'efficacité des tests. Sur 60 mutants appliqués, 58 sont tués.

Mutants tués :

- les 13 retraits de champ, dont les six anciens survivants : `status`, `mediaAssetId`, `observation`, `openQuestion`, `excerpt` et `coverMediaId` ;
- le remplacement par `null` de 11 champs dans la projection canonique ;
- le remplacement par `null` de 11 champs dans `snapshotFromResolved` ;
- la suppression du contrôle de longueur des thèmes, puis celle de la comparaison élément par élément ;
- la suppression du contrôle de la clé éditoriale ;
- l'inversion de priorité de `TYPE_CHANGE` ;
- l'absence de `id` dans les conflits ;
- un CREATE sans projection canonique ;
- l'acceptation de l'année 0000 ;
- la troncature des microsecondes ;
- la réintroduction des propriétés supplémentaires par `...snapshot`.

Les deux survivants sont des mutants équivalents :

- `slug ?? null` ne change rien, puisque `slug` est déjà de type `string | null` ;
- un NOOP qui renvoie `before` au lieu de `after` produit la même projection, puisque les deux objets sont égaux sur tous les champs.

## 4. Couverture de m2

Tous les cas demandés sont couverts :

- CREATE d'une Reflection ;
- ajout seul et retrait seul d'un thème ;
- ordre et doublons de thèmes ;
- valeurs canoniques dans `before` et `after` ;
- priorité de `TYPE_CHANGE` sur la clé immuable ;
- changement simultané de `locale` et de `slug` ;
- timestamps techniques ignorés ;
- NOOP pour un même instant exprimé dans deux fuseaux ;
- entrées gelées non modifiées.

Seul manque un test du typage des unions d'opérations, par exemple avec `@ts-expect-error`. Les sondes de la première revue démontrent ce typage, et sa structure n'a pas changé, mais la suite de tests ne l'atteste pas elle-même.

## 5. Vérifications réellement exécutées

| Commande                                               | Résultat                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit`                                     | exit 0                                                                                                                                                                                                                                             |
| `npm run test:editorial`                               | 76/76 réussis                                                                                                                                                                                                                                      |
| `npx tsx --test tests/snapshots.test.ts`               | 35/35 réussis                                                                                                                                                                                                                                      |
| `prettier --check` sur les 4 fichiers D03-01           | réussi                                                                                                                                                                                                                                             |
| `npm run format:check`                                 | exit 1 sur les 13 mêmes fichiers préexistants. En mode `--end-of-line crlf`, la situation s'inverse : ces 13 fichiers passent et seuls les 4 nouveaux fichiers, en LF, échouent. Il s'agit donc du problème CRLF déjà connu, pas d'une régression. |
| Sondes de compilation et 60 mutants (copie hors dépôt) | voir §3                                                                                                                                                                                                                                            |
| Sonde de frontières parseur / snapshot                 | voir §6                                                                                                                                                                                                                                            |

**Non exécutés :** `npm test` et `db:verify`, faute d'instance PostgreSQL de test dédiée.

## 6. Nouveaux constats

### MINOR — Des dates acceptées par le parseur font échouer la construction du snapshot avec une `RangeError` brute

`0001-01-01T00:30:00+01:00` (année 0000 en UTC) et `9999-12-31T23:30:00-01:00` (année 10000 en UTC) passent `parseContent`. `snapshotFromResolved` lève ensuite une `RangeError` (`instant-us.ts:8-9`, vérifié par sonde).

Ce comportement ne produit ni faux NOOP ni perte de données. En revanche, cette erreur n'est pas une `ContentValidationError` : le futur plan d'import ne la classera donc pas automatiquement comme diagnostic.

Correction à prévoir en D03-03 : capturer l'erreur et la convertir en diagnostic du champ `published_at`. Resserrer plutôt la validation dans `parse.ts`, fichier préexistant, demanderait une décision séparée.

### INFORMATIONAL

- Les alias `PublicationFieldsComplete` et `ReflectionFieldsComplete` ne sont jamais utilisés. Ils déclencheraient `TS6196` si `noUnusedLocals` était activé un jour.
- TypeScript ne vérifie pas que l'implémentation surchargée de `canonicalSnapshot` respecte chaque surcharge ; les tests compensent.
- Les nouveaux fichiers ne contiennent toujours aucun commentaire (i6 de la première revue), notamment sur la branche CREATE dupliquée (`operations.ts:232-235`).

## 7. Risques résiduels pour D03-02 et D03-03

- **D03-02 :**
  - lire `published_at` à la microseconde et refuser les dates av. J.-C. ;
  - convertir en diagnostic les `RangeError` de `parseInstantUs` ;
  - conserver les UUID PostgreSQL tels quels, en minuscules.
- **D03-03 :**
  - `classifySnapshot` renvoie NOOP sur la seule égalité des valeurs ; l'appelant doit encore revalider les références et la préparation des médias ;
  - `TYPE_CHANGE` n'est détecté que si l'appelant transmet la ligne trouvée dans l'autre table ;
  - convertir la `RangeError` décrite au §6 ;
  - assurer la cohérence de `applicable` et le tri déterministe.

## 8. Corrections encore nécessaires

Aucune avant le commit. Pour D03-03, prévoir la conversion de cette `RangeError` en diagnostic.

## 9. Verdict

**READY TO COMMIT.** L'exhaustivité des champs métier est protégée à la fois par le typage et par les tests ; les mutants le confirment. Les observations M1, m1, m2 et m4 sont résolues, m3 reste reporté comme convenu, et aucune régression n'a été constatée. Ce verdict porte sur D03-01 seul et ne valide pas le moteur D03 complet.
