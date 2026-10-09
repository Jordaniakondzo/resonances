# Revue du commit documentaire D03 `1c89328`

**Rôle :** Independent code and architecture reviewer, en lecture seule
**Branche :** `codex/d03-import-design`
**Commit examiné :** `1c89328bb67fbc981cf53acccc25d03f8f565d65` (« docs(d03): approve import design and document operational policies »)
**Parent :** `5d4f9aed752711d04e82cb0368c7acd8fb32701a`
**Date :** 9 octobre 2026
**Verdict : NOT READY**

> **Statut historique.** Cette revue est conservée comme trace des problèmes rencontrés. Ses constats B1, M1, M2 et m1–m4 ont été traités par le commit `f40d675` (ADR-B1 et consolidation documentaire) ; voir [la revue finale](D03-ADR-B1-REVIEW-f40d675.md), verdict READY WITH CONDITIONS. Les numéros de ligne ci-dessous se rapportent à l'arbre du commit `1c89328`.

J'ai travaillé en lecture seule. Aucun test n'a été exécuté, car le commit ne contient que de la documentation. Mes vérifications sont la lecture des trois documents, le diff Git, la résolution des liens sur l'arbre du commit, l'inspection de la migration et deux pages de la documentation PostgreSQL 18.

## Périmètre du commit

- **Contenu conforme :** `git diff 5d4f9ae 1c89328 --name-status` liste exactement 3 ajouts (`A`), aucune modification ni suppression :
  - `docs/RESONANCES-V1-D03-IMPORT-DESIGN.md`
  - `docs/operations/EDITORIAL-PUBLICATION-CHECKLIST.md`
  - `docs/operations/SQL-WRITER-POLICY.md`
- **Travaux préexistants exclus :** `README.md`, `docs/audits/` et `docs/design/` restent hors du commit, en changements locaux.
- **Parent cohérent :** le parent est `5d4f9ae`, que `main` contient bien. L'affirmation du §1 (« `main` contient … ») est donc exacte.

## BLOCKING

### B1 — Le contrat D03 approuvé et la politique des écrivains SQL sont incompatibles

- **Où :**
  - Le contrat impose `SELECT … FOR SHARE` sur `themes` et `FOR SHARE` / `FOR KEY SHARE` sur `media_assets` pendant l'import (`D03-IMPORT-DESIGN.md:301-304`, `:309`, `:311`).
  - La politique interdit à l'importeur toute écriture sur ces tables (`SQL-WRITER-POLICY.md:13`, `:35`) et demande de vérifier « l'impossibilité pour l'identité de l'importeur de modifier Theme/MediaAsset » (`:42`).
- **Preuve :** la documentation PostgreSQL 18 de `SELECT` l'indique explicitement : _« The use of FOR NO KEY UPDATE, FOR UPDATE, FOR SHARE or FOR KEY SHARE requires UPDATE privilege as well (for at least one column of each table so selected). »_
- **Conséquence :** si la politique est appliquée telle qu'écrite, l'import approuvé échoue avec `permission denied` (42501). À l'inverse, accorder le droit de verrouiller donne à l'importeur un privilège `UPDATE`, ce que la politique interdit. Le contrat est déclaré « APPROVED — Ready for implementation » : l'implémenteur hériterait de cette contradiction.
- **À arbitrer, avec la correction la plus petite possible :**
  1. La politique accorde à l'importeur un `UPDATE` au niveau colonne, uniquement pour permettre le verrouillage, et documente cette capacité résiduelle ainsi que son contrôle.
  2. Le verrouillage passe par une fonction `SECURITY DEFINER` dédiée.
  3. La politique exige que les circuits Theme et MediaAsset s'exécutent eux aussi en `SERIALIZABLE`, et les verrous explicites sont abandonnés. Cela suppose de rouvrir D03-TX-01.

  Dans les trois cas, les deux documents doivent être mis à jour ensemble.

## MAJOR

### M1 — Un brouillon importé sans slug ne pourra jamais être publié sous son UUID

- **Ce que dit D03-SLUG-01 :** le passage `null → valeur` est interdit pour tout UUID existant, quel que soit le statut (`D03-IMPORT-DESIGN.md:32`, `:211`, `:242`).
- **Ce qui est autorisé ailleurs :**
  - le contrat éditorial accepte un brouillon avec les quatre champs obligatoires seulement, donc sans slug (`EDITORIAL-CONTRACT.md:64`) ;
  - une publication `published` exige un slug ;
  - la spécification prévoit le circuit « importer en brouillon → … → publier » en conservant les identifiants (`SPECIFICATION.md:307`, `:311`).
- **Scénario concret :** les deux exemples du dépôt (`content/publications/exemple.md`, `content/reflections/exemple.md`) sont des brouillons sans slug. Une fois importés, ils ne pourraient jamais être publiés sans changer d'UUID.
- **Ce qui manque :** le document traite « aucun renommage de draft » (`:427`) mais ne mentionne jamais cette impasse, et la checklist ne la signale pas.
- **Recommandation :** documenter explicitement la conséquence et ajouter une règle d'usage, par exemple « tout contenu destiné à être publié doit avoir son slug définitif dès son premier import ». À défaut, faire réarbitrer l'exception `null → valeur` par le propriétaire.

### M2 — La checklist place la décision humaine après l'import, alors que l'import d'un contenu `published` est déjà la diffusion

- **Ce que dit le contrat :** la revue humaine « précède la diffusion publique » (`D03-IMPORT-DESIGN.md:264`, `:436`).
- **Le problème d'ordre :**
  - La visibilité publique ne dépend que de `status = 'published' AND published_at <= now()` (`db/visibility.ts`). Importer un document `published` dont la date est passée le rend donc public dès le COMMIT.
  - Or la checklist enchaîne dry-run, puis import (« si l'import réel a été exécuté… », `CHECKLIST.md:61`), puis décision, et lie l'autorisation à « la version **réellement importée** » (`:79`).
- **Recommandation :**
  - lier la décision **AUTORISÉ POUR DIFFUSION** à la version source exacte (le commit Git) _avant_ tout import qui la rend publique ;
  - l'import peut se faire en brouillon, ou avec un `published_at` futur, pour la relecture ;
  - la vérification après import ne devient alors qu'un contrôle de conformité.

## MINOR

| #   | Fichier : ligne                                  | Constat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Recommandation                                                                                                               |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| m1  | `D03-IMPORT-DESIGN.md:309`                       | Affirmation inexacte, présentée comme VALIDATED : « `FOR KEY SHARE` n'empêche pas un UPDATE non clé de `themes.locale`, `themes.slug` ». Or `themes_locale_slug_unique` est une contrainte UNIQUE non partielle, utilisable par une FK (migration, ligne 82). D'après la doc PostgreSQL 18 (explicit locking), ces colonnes sont donc des colonnes clés : les modifier prend `FOR UPDATE`, ce qui **est** bloqué par `FOR KEY SHARE`. La conclusion (`FOR SHARE` pour Theme) reste sûre. L'affirmation est juste pour `alt_text`, `source` et `license`. | Corriger la justification et ne garder l'exemple que pour les colonnes média non clés.                                       |
| m2  | `D03-IMPORT-DESIGN.md:19`                        | Le document cite `docs/audits/D03-PRE-IMPLEMENTATION-AUDIT.md`, absent du commit (fichier non suivi). Après merge, la référence pointera vers un fichier inexistant.                                                                                                                                                                                                                                                                                                                                                                                     | Versionner l'audit, ou retirer ou requalifier la référence.                                                                  |
| m3  | `D03-IMPORT-DESIGN.md:21`                        | Un document normatif décrit l'état local du working tree (« `README.md` était modifié… »). L'information sera vite périmée.                                                                                                                                                                                                                                                                                                                                                                                                                              | La déplacer dans le message de commit ou la supprimer.                                                                       |
| m4  | `D03-IMPORT-DESIGN.md:252`, `CHECKLIST.md:51-52` | Aucun contrôle, automatique ou humain, n'exige que les dimensions du média existent pour un contenu publié. Le contrôle porte seulement sur « positives si présentes » et « dimensions connues ». AGENTS §13 demande de les consigner et §16 de réserver les dimensions de mise en page.                                                                                                                                                                                                                                                                 | Ajouter au moins une case dans la checklist, ou noter explicitement que le point est reporté à la tranche de rendu ou à D07. |

## INFORMATIONAL

- **Liens :** tous les liens Markdown relatifs des trois documents résolvent dans l'arbre du commit (`../RESONANCES-V1-*.md`, `operations/*.md`, liens croisés entre la checklist et la politique). Seul problème : la référence textuelle de m2.
- **Faits vérifiés :**
  - six tables, `updated_at` sans trigger ;
  - contraintes `UNIQUE(locale, slug)` non `DEFERRABLE`, avec NULL multiples autorisés (comportement par défaut) ;
  - `ReferenceReader` et `mediaExists` existent bien ;
  - les index et PK couvrent les accès décrits ;
  - les commentaires des exemples de code sont en anglais.
- **Cohérence avec L0 et le contrat éditorial :**
  - D01–D06 et le statut ouvert de D07/D08 sont respectés.
  - L'immuabilité du slug est plus stricte que l'exigence de redirection de la spécification, sans la contredire.
  - Les deltas de thèmes sont équivalents à l'« ensemble déclaratif » du contrat éditorial.
  - Le NOOP strict et le refus d'« écrire puis rollback » sont conformes au contrat éditorial.
- **« Zéro écriture » du dry-run (§10) :** il faut l'entendre comme zéro écriture _logique_. Des écritures physiques, comme les hint bits, restent possibles pendant une lecture. Une précision d'une ligne éviterait de surinterpréter le test.
- **Traçabilité des décisions :** les arbitrages D03-SLUG-01, D03-MEDIA-01, D03-TX-01 et D03-RESULT-01 n'existent que dans ce document. Ni le registre L0 ni le contrat éditorial (§« Contrat pour la prochaine étape ») ne renvoient vers lui. C'est cohérent avec un commit limité à trois fichiers, mais un renvoi devra suivre.
- **Prudence des documents :** ils ne présentent aucune garantie comme déjà démontrée. L'absence d'implémentation et de tests est affirmée clairement (§16) et la politique précise qu'elle n'est pas un état constaté (`:35`, `:56`).

## Verdict : **NOT READY**

Le périmètre du commit est propre, mais B1 rend le contrat « APPROVED — Ready for implementation » inapplicable tel quel avec la politique des écrivains SQL, qui est elle aussi normative. Il faut un arbitrage du propriétaire et une mise à jour conjointe des deux documents. M1 et M2 devraient être tranchés dans la même passe, puisqu'ils touchent le circuit de publication lui-même. Les MINOR peuvent suivre.
