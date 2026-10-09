# Revue finale du lot documentaire D03 / ADR-B1, commit `f40d675`

**Rôle :** Independent Architecture Reviewer et PostgreSQL Security Reviewer, en lecture seule
**Branche :** `codex/d03-import-design`
**Commit examiné :** `f40d6754c9d9f383dc0c9ad3348abe05a7bf4fe0`
**Commit documentaire précédent :** `1c89328bb67fbc981cf53acccc25d03f8f565d65`
**Date :** 9 octobre 2026
**Verdict : READY WITH CONDITIONS**

> **Revue précédente :** [revue du commit `1c89328`](D03-DOCUMENTATION-REVIEW-1c89328.md), verdict NOT READY. Elle décrit les constats B1, M1, M2 et m1–m4 dont cette revue vérifie la correction.

J'ai travaillé strictement en lecture seule. Je n'ai créé aucun fichier dans le dépôt, aucun rôle, aucune fonction ni aucune migration. Le working tree est identique avant et après la revue : `README.md` modifié, `docs/audits/` et `docs/design/` non suivis.

## 1. Périmètre Git vérifié

| Contrôle                                                                                                             | Résultat                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Parent                                                                                                               | `1c89328` ✅                                                                                                               |
| Fichiers touchés (`git diff --name-status 1c89328 f40d675`)                                                          | 4 exactement : `M` contrat D03, `A` `docs/adr/ADR-B1-PRIVILEGED-REFERENCE-LOCKING.md`, `M` checklist, `M` politique SQL ✅ |
| Code, migrations, tests, scripts, `package*.json`, `content/`, `sources/`, `README.md`, `AGENTS.md` depuis `5d4f9ae` | Aucun diff ✅                                                                                                              |
| `main` et `origin/main`                                                                                              | Tous deux à `5d4f9ae`, inchangés ✅                                                                                        |
| Changements locaux étrangers à la mission                                                                            | Préservés, aucun n'est dans le commit ✅                                                                                   |

## 2. État des anciennes observations

### B1 — Contradiction entre verrouillage et privilèges : **résolue au niveau de la conception**

L'option B est retenue (ADR §4) : trois fonctions `SECURITY DEFINER` à table et mode fixes. Les trois documents sont maintenant cohérents :

| Point                           | ADR-B1                                                                                                                                                                                                | Contrat D03                                                               | Politique SQL       | Verdict       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------- | ------------- |
| Fonctions et modes              | §5, l.37-39 : `lock_theme` FOR SHARE, `lock_media_key` FOR KEY SHARE, `lock_media_ready` FOR SHARE                                                                                                    | l.156, l.311-313, l.318                                                   | l.20, l.29          | ✅ identiques |
| Importeur                       | `USAGE` sur le schéma privé + `EXECUTE`, aucun `UPDATE` direct, aucune appartenance `INHERIT` / `SET ROLE` (l.73)                                                                                     | l.322                                                                     | l.20, l.37, l.47-49 | ✅            |
| Propriétaire                    | `NOLOGIN`, non superutilisateur, distinct du propriétaire des tables, `SELECT` sur les colonnes lues, `UPDATE` sur une seule colonne non identitaire (l.74, l.78)                                     | l.322                                                                     | l.20, l.45          | ✅            |
| Durcissement                    | `search_path = pg_catalog, pg_temp`, objets qualifiés, pas de SQL dynamique, `REVOKE … FROM PUBLIC` dans la transaction de création, pas de `CREATE` pour les rôles non fiables (l.52, l.80, l.86-90) | l.322                                                                     | l.39, l.46          | ✅            |
| Durée des verrous               | Jusqu'à la fin de la transaction appelante, réserve sur les savepoints (l.65)                                                                                                                         | l.322                                                                     | l.29                | ✅            |
| Ordre et revalidation           | Theme → Media → contenu, une ligne à la fois (l.65)                                                                                                                                                   | l.320 : un résultat vide est un conflit, plan recalculé après les verrous | —                   | ✅            |
| Dry-run                         | N'appelle jamais les fonctions (l.99)                                                                                                                                                                 | l.156, l.316, l.330                                                       | l.30                | ✅            |
| SERIALIZABLE et retries         | Conservés (l.98)                                                                                                                                                                                      | l.320, l.340 : `40001`/`40P01`, trois tentatives                          | l.27, l.29          | ✅            |
| Migration de sécurité préalable | l.100                                                                                                                                                                                                 | l.23, l.322, l.434 (sous-lot 5 avant le 6), l.438                         | l.54                | ✅            |

**Validité PostgreSQL de la conception :**

- Dans une fonction `SECURITY DEFINER`, l'exigence d'`UPDATE` posée par `FOR SHARE` / `FOR KEY SHARE` est vérifiée contre le propriétaire de la fonction. Le verrou de ligne appartient à la transaction appelante.
- `pg_temp` placé en dernier et les tables qualifiées neutralisent le détournement par homonymes. PostgreSQL ne cherche jamais les fonctions ni les opérateurs dans `pg_temp`.
- `STRICT` fait qu'un UUID nul renvoie zéro ligne.
- L'esquisse qualifie toutes les colonnes (`t.id`…), ce qui évite le conflit PL/pgSQL avec les colonnes `OUT` de `RETURNS TABLE`.

Aucune contradiction de conception ne subsiste. Ce qui reste relève de la preuve à apporter pendant l'implémentation (§6).

### M1 — Brouillon sans slug : **résolu**

- La clé `(locale, slug)` reste immuable (l.244).
- L'impasse est documentée explicitement : « slug définitif avant son premier import » (l.248).
- La divergence avec le contrat éditorial est reconnue (l.250).
- Le point est repris dans la checklist (l.30), la matrice de tests (l.394), les critères d'acceptation (l.405) et la traçabilité (l.416).

### M2 — Autorisation avant diffusion : **résolu**

- La séquence en 6 étapes place l'autorisation **avant** l'import (l.272, checklist §6 l.63-81).
- La publication programmée est couverte (l.272, checklist l.65 et l.81, politique l.31).
- Le contrôle après import n'autorise jamais rétroactivement (l.272, checklist §7 l.86).
- La matrice contient une ligne opérationnelle dédiée (l.401).

### Observations mineures de la passe précédente

| #   | Sujet                                 | État                                                                                                                                                |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1  | Colonnes clés et `FOR KEY SHARE`      | ✅ Formulation corrigée et prudente (ADR l.67, D03 l.318). Le choix de `FOR SHARE` pour Theme ne dépend plus de l'inférence erronée.                |
| m2  | Audit non versionné                   | ✅ Requalifié explicitement : « non suivi par Git… sans garantie de présence » (l.19).                                                              |
| m3  | État du working tree dans le document | ✅ Supprimé de §1 (l.21).                                                                                                                           |
| m4  | Dimensions nullables                  | ✅ Explicites (l.258, l.274, checklist l.53-55, matrice l.395).                                                                                     |
| —   | « Zéro écriture » du dry-run          | ✅ Défini comme zéro commande SQL de modification et zéro mutation métier, sans promesse sur l'activité physique (l.330, ADR l.99, politique l.30). |

## 3. Nouvelles observations

**BLOCKING : aucune. MAJOR : aucune.**

### MINOR

| #   | Fichier : ligne                                           | Constat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Correction minimale                                                                                                                                                                                                             |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | `docs/RESONANCES-V1-D03-IMPORT-DESIGN.md:403`             | **Incohérence résiduelle confirmée.** La matrice exige « migrations inchangées pour cette tranche », alors que la migration de sécurité ADR-B1 est requise (l.23, l.322, l.434, l.438, l.460).                                                                                                                                                                                                                                                                                                        | « Migration initiale et six tables métier inchangées ; seule la migration de sécurité ADR-B1 est ajoutée. »                                                                                                                     |
| N2  | `docs/RESONANCES-V1-D03-IMPORT-DESIGN.md:3` contre `:460` | L'en-tête dit « APPROVED — Ready for implementation », le verdict « … **sous conditions B1** ».                                                                                                                                                                                                                                                                                                                                                                                                       | Aligner l'en-tête sur le verdict.                                                                                                                                                                                               |
| N3  | ADR §8, D03 l.438                                         | La migration de sécurité n'est pas située dans l'outillage D02. Elle ne sera pas générée depuis `schema.ts` : il faut une migration Drizzle Kit personnalisée, inscrite au journal. `db:verify` ne couvre que `0000` (Data Core). Les rôles sont globaux au cluster et leurs noms varient selon l'environnement, alors qu'une migration versionnée les cite (`GRANT`, `OWNER TO`). Enfin, les tests actuels créent une base temporaire par exécution et doivent donc disposer des rôles au préalable. | Ajouter au sous-lot 5 : migration personnalisée Drizzle Kit, extension de `db:verify`, stratégie de provisionnement des rôles pour les tests et le déploiement. Il s'agit d'une précision de plan, pas d'une nouvelle décision. |

### INFORMATIONAL

- **I1 — Le contrat éditorial n'est pas resynchronisé.** `docs/RESONANCES-V1-EDITORIAL-CONTRACT.md:15` dit encore que l'UUID est « conservé lors des changements de … slug », sans renvoi vers D03-SLUG-01. La divergence est reconnue côté D03 (l.250), mais pas dans le contrat éditorial lui-même. À synchroniser au sous-lot 7 (AGENTS §2).
- **I2 — Savepoints.** Les documents signalent le risque. Une règle explicite aiderait l'implémenteur : pas de savepoint ni de transaction Drizzle imbriquée entre le premier appel B1 et le COMMIT, et pas de bloc `EXCEPTION` PL/pgSQL qui intercepterait une erreur après verrouillage.
- **I3 — Politique §3 (l.37).** Elle ne mentionne pas `USAGE` sur le schéma `d03_priv`, alors que l'ADR (l.73) le fait. C'est sans conséquence, mais à aligner.
- **I4 — Modification d'un contenu déjà public.** Un UPDATE de contenu déjà `published` est visible dès le COMMIT. La formulation « toute opération susceptible de le rendre immédiatement public » et la règle de réexamen (checklist l.9) le couvrent implicitement ; le dire explicitement éviterait toute lecture restrictive.
- **Statuts :** cohérents avec les définitions de D03 l.13. `VALIDATED` est utilisé pour les arbitrages, `BLOCKING — avant validation opérationnelle` pour des conditions impératives (ADR l.123, D03 l.452), et `OPEN` ne révoque rien.
- **Compatibilité L0 :** D01–D06 et D07/D08 ne sont pas rouverts (ADR l.102). Le schéma réel est respecté : six tables inchangées, `UNIQUE(locale, slug)` non `DEFERRABLE`, dimensions nullables avec `CHECK`.
- **Garanties non démontrées :** jamais présentées comme acquises. L'esquisse SQL est marquée « illustrative, non exécutée » (ADR l.43), le §9 « Tests requis, non exécutés », et la séparation entre architecture approuvée et validation opérationnelle est nette (l.123, D03 l.452, l.460).

## 4. Vérifications réellement exécutées

- Commandes `git log`, `git show --stat`, `git diff --name-status 1c89328 f40d675` et `git diff --stat 5d4f9ae f40d675` sur `db`, `src`, `tests`, `scripts`, les manifestes, `content`, `sources`, `README` et `AGENTS` (aucun diff).
- `git rev-parse` de `main` et `origin/main`.
- `git status` avant et après la revue.
- Lecture intégrale des 4 documents.
- Recherches `git grep` ciblées sur N1, I1, I2 et I3.
- **Liens :** un script en lecture seule, hors dépôt, a résolu les liens relatifs sur l'arbre `f40d675`. **24 liens relatifs, 0 manquant.**
- **Base PostgreSQL :** la règle « locking clause ⇒ `UPDATE` » a été vérifiée dans la documentation PostgreSQL 18 lors de la passe précédente. Les liens externes n'ont pas été rechargés.
- **Non exécuté :** aucun test, aucun SQL, aucune création de rôle ou de fonction, conformément aux contraintes. Le commit est purement documentaire.

## 5. Risques acceptés

- Une identité d'import compromise peut verrouiller des UUID arbitraires et créer de la contention.
- Le propriétaire B1 garde un `UPDATE` résiduel effectif sur une colonne.
- L'unicité d'un UUID entre les deux tables n'est pas une contrainte physique.
- Rien n'est garanti après le COMMIT, et aucun historique d'URL n'est reconstruit.
- Les droits, la provenance et la disponibilité des médias relèvent d'une revue humaine, hors de l'importeur.

## 6. Preuves encore attendues pendant l'implémentation (non des régressions)

- Choix justifié des colonnes concernées par l'`UPDATE` résiduel.
- Migration de sécurité installée sur une instance dédiée.
- Tests positifs et négatifs des privilèges : importeur, application publique, `PUBLIC`, héritages, `SET ROLE`, remplacement de fonction.
- Test d'un objet homonyme dans `pg_temp`.
- Verrous observés sur deux sessions jusqu'à la fin de la transaction.
- Ordre de verrouillage, `40001`/`40P01` et trois tentatives au maximum.
- Dry-run sans appel B1.
- NOOP publié sous `FOR SHARE`.
- Précision microseconde avec Drizzle/`pg`.
- Appels faits sur la même connexion et dans la même transaction.

## 7. Verdict : **READY WITH CONDITIONS**

B1, M1, M2 et les quatre mineures sont résolus, et je ne trouve aucune contradiction de conception ni aucune garantie présentée à tort comme démontrée. Le lot peut être intégré à `main` comme référence architecturale après une petite correction rédactionnelle de N1 et N2 : la ligne 403 contredit l'autorisation de la migration de sécurité, et l'en-tête ne reflète pas les conditions B1. N3 peut aller soit dans ce même correctif, soit dans un engagement explicite du sous-lot 5. Les points informatifs relèvent du sous-lot 7 de synchronisation documentaire.
