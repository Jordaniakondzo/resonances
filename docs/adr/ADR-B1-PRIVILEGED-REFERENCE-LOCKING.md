# ADR-B1 — Privileged reference locking for D03

**Statut : APPROVED — Implementation and security verification pending**

**Date :** 9 octobre 2026 (Europe/Moscow)

**Autorité :** décision explicite du propriétaire du projet pour la première tranche D03.

**Documents liés :** [contrat d'import D03](../RESONANCES-V1-D03-IMPORT-DESIGN.md), [politique des écrivains SQL](../operations/SQL-WRITER-POLICY.md), [checklist de diffusion](../operations/EDITORIAL-PUBLICATION-CHECKLIST.md), [décisions L0](../RESONANCES-V1-L0-DECISIONS.md), [contrat éditorial](../RESONANCES-V1-EDITORIAL-CONTRACT.md).

## 1. Contexte

D03 valide les références Theme et MediaAsset dans un import privé `SERIALIZABLE READ WRITE`. Son protocole exige `FOR SHARE` sur Theme et sur les médias destinés à `published`, et `FOR KEY SHARE` sur les médias seulement référencés par drafts ou archives. Le dry-run `REPEATABLE READ READ ONLY` n'acquiert aucun verrou de ligne explicite. Les six tables métier et leurs contraintes sont décrites par `db/schema.ts` et la migration initiale ; aucune fonction ni aucun rôle B1 n'y est actuellement installé.

## 2. Problème B1

PostgreSQL 18 exige un privilège `UPDATE` sur au moins une colonne de chaque table sélectionnée avec `FOR SHARE` ou `FOR KEY SHARE`, en plus des `SELECT` nécessaires. Accorder ce droit directement à l'importeur rendrait possible un véritable `UPDATE` sur cette colonne, alors que la politique V1 réserve les modifications de `themes` et `media_assets` à des circuits distincts. Il n'existe pas de droit PostgreSQL autonome « verrouiller sans pouvoir modifier ». [Références : `SELECT`](https://www.postgresql.org/docs/18/sql-select.html), [`GRANT`](https://www.postgresql.org/docs/18/sql-grant.html), [privilèges](https://www.postgresql.org/docs/18/ddl-priv.html).

## 3. Options étudiées

| Option                                                  | Avantage                                                           | Coût ou risque déterminant                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| A — `UPDATE` limité à une colonne accordé à l'importeur | Installation simple, requêtes `FOR` directes                       | Droit de modification effectif sur Theme/MediaAsset ; aucune colonne « seulement verrouillable » n'est démontrée par le schéma. |
| B — fonctions `SECURITY DEFINER` spécialisées           | Préserve les modes D03 et refuse l'`UPDATE` direct à l'importeur   | Nouvelle migration de sécurité, fonctions privilégiées, rôles, vérification et surveillance de contention.                      |
| C — transaction `SERIALIZABLE` sans verrou explicite    | Aucun privilège `UPDATE` nécessaire à l'importeur pour verrouiller | Change D03-TX-01 ; les garanties dépendent du protocole réel des autres écrivains et demandent une autre démonstration.         |

Un `GRANT UPDATE (description)` sur `themes` et `GRANT UPDATE (caption)` sur `media_assets` illustrerait l'option A : ces colonnes existent, mais leur modification est possible. Il ne s'agit ni d'une recommandation de colonnes pour la décision B, ni d'un privilège sans écriture. Un trigger pour empêcher l'UPDATE direct demanderait lui aussi une migration, du code privilégié et des tests. L'option C reste une révision architecturale distincte, non autorisée par cette décision. [Référence : isolation sérialisable](https://www.postgresql.org/docs/18/transaction-iso.html).

## 4. Décision et justification

**VALIDATED — adopter l'option B.** Trois fonctions PostgreSQL `SECURITY DEFINER`, à tables et modes fixes, assurent les verrous requis sans accorder à l'importeur un `UPDATE` direct sur `themes` ou `media_assets`. Elles s'exécutent avec les droits de leur propriétaire et dans la transaction de l'appelant. Cette frontière conserve le protocole D03, la séparation des écrivains et l'absence de nouvelles tables métier. Elle ne constitue pas encore une preuve que l'installation cible est sûre : permissions, durée des verrous, concurrence et comportement du repository doivent être testés sur PostgreSQL réel. [Références : `CREATE FUNCTION`](https://www.postgresql.org/docs/18/sql-createfunction.html), [verrous explicites](https://www.postgresql.org/docs/18/explicit-locking.html).

## 5. Architecture des trois fonctions

| Fonction privée                   | Table et mode internes                     | Retour minimal nécessaire                                                                                                         |
| --------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `d03_priv.lock_theme(uuid)`       | `public.themes` avec `FOR SHARE`           | `id`, `locale`, `slug` pour revalider le couple résolu.                                                                           |
| `d03_priv.lock_media_key(uuid)`   | `public.media_assets` avec `FOR KEY SHARE` | `id` pour confirmer l'existence d'un média seulement utilisé par draft/archive.                                                   |
| `d03_priv.lock_media_ready(uuid)` | `public.media_assets` avec `FOR SHARE`     | `id`, `original_url`, `alt_text`, `source`, `license`, `author`, `width`, `height` pour revalider un média destiné à `published`. |

La fonction forte est choisie si un même média sert à la fois un contenu destiné à `published` et un draft ou une archive. Aucun paramètre ne choisit une table, une colonne, un rôle, un fragment SQL ou un mode de verrouillage. Un UUID absent produit zéro ligne ; le service classe cette absence comme conflit. Les résultats d'une fonction ne remplacent pas la revalidation du plan complet après acquisition de toutes les protections.

Esquisse **illustrative, non exécutée** :

```sql
CREATE FUNCTION d03_priv.lock_theme(p_id uuid)
RETURNS TABLE (id uuid, locale text, slug text)
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Lock one fixed table and return the values needed for revalidation.
  RETURN QUERY
    SELECT t.id, t.locale, t.slug
    FROM public.themes AS t
    WHERE t.id = p_id
    FOR SHARE OF t;
END;
$fn$;
```

Les deux fonctions média suivent la même structure avec `public.media_assets` et leur mode propre. Le code SQL exact, les types retournés, le comportement de `RETURN QUERY` et l'adaptateur Drizzle/`pg` devront être vérifiés sur PostgreSQL réel avant la migration. Les fonctions n'ouvrent, ne valident et n'annulent aucune transaction. L'import les appelle une ligne à la fois, sur la même connexion, dans l'ordre global Theme UUID croissant, puis MediaAsset UUID croissant, puis contenu existant `(type, id)` croissant. Les verrous doivent durer jusqu'au `COMMIT` ou `ROLLBACK` appelant ; un rollback à un savepoint peut libérer ceux acquis après lui. [Référence : verrous explicites](https://www.postgresql.org/docs/18/explicit-locking.html).

`FOR KEY SHARE` protège la clé pertinente, mais n'empêche pas tout `UPDATE` non clé. Il ne faut pas déduire le comportement de `themes.locale` ou `themes.slug` de celui de `media_assets.alt_text` : les colonnes participant à un index unique admissible comme clé peuvent influer sur le mode de verrouillage d'un UPDATE. D03 choisit `FOR SHARE` pour Theme afin de protéger le couple de résolution sans dépendre d'une telle inférence. [Référence : modes de verrouillage](https://www.postgresql.org/docs/18/explicit-locking.html).

## 6. Rôles et permissions cibles

| Identité                 | Droits cibles                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Importeur privé          | Lectures nécessaires ; écritures métier sur `publications`, `reflections`, `publication_themes` et `reflection_themes` ; `USAGE` sur le schéma privé et `EXECUTE` sur les trois fonctions B1. Aucun `UPDATE` direct sur Theme/MediaAsset, aucune propriété des fonctions, aucune appartenance permettant `INHERIT` ou `SET ROLE` vers leur propriétaire. |
| Propriétaire B1          | Rôle dédié `NOLOGIN`, non superutilisateur, distinct des propriétaires de tables ; `SELECT` sur les colonnes lues et `UPDATE` limité à une **colonne non identitaire** de chaque table de référence. Aucun `UPDATE` de table entière.                                                                                                                    |
| Application publique     | Lectures publiques requises ; aucun `EXECUTE` B1 ni droit d'écriture éditoriale.                                                                                                                                                                                                                                                                         |
| Migration et maintenance | Accès privilégiés distincts, contrôlés, audités et non disponibles à l'application publique.                                                                                                                                                                                                                                                             |

La colonne résiduelle exacte du propriétaire B1 sera choisie après vérification du schéma et des contraintes dans la préparation de migration. **Ne pas accorder par défaut `UPDATE(id)` ni `UPDATE` sur une clé primaire.** Même sur une colonne non identitaire, le droit permet une vraie modification ; la sûreté dépend de l'impossibilité pour l'importeur de devenir ce rôle ou de modifier le corps des fonctions. Les noms de rôles ci-dessus désignent des responsabilités, pas des rôles déjà constatés sur une instance.

La future migration doit créer ou utiliser un schéma de fonctions protégé, refuser `CREATE` aux identités non fiables, fixer un `search_path` sûr avec `pg_temp` en dernier, qualifier les objets SQL, exclure le SQL dynamique, révoquer `EXECUTE` accordé par défaut à `PUBLIC` **dans la transaction de création**, puis accorder `EXECUTE` sur chaque signature exacte à l'importeur. Les appartenances, droits de propriété, droits hérités et surcharges doivent être audités. [Références : sécurité des fonctions](https://www.postgresql.org/docs/18/sql-createfunction.html), [`GRANT`](https://www.postgresql.org/docs/18/sql-grant.html), [`ALTER DEFAULT PRIVILEGES`](https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html).

## 7. Menaces et protections

| Menace                                                                         | Protection et limite                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Détournement par `search_path`, objets temporaires ou objets SQL non qualifiés | `SET search_path = pg_catalog, pg_temp`, qualification des tables, schéma privé sans `CREATE` non fiable ; tester des objets homonymes.                                                                                                                   |
| Fonction remplacée ou surchargée                                               | Propriété réservée, migrations inspectées, contrôle des signatures et droits `CREATE` du schéma ; auditer après déploiement.                                                                                                                              |
| Privilèges hérités ou `SET ROLE`                                               | Tester les appartenances directes et indirectes, ainsi que le droit effectif de devenir le propriétaire B1.                                                                                                                                               |
| `EXECUTE` implicite de `PUBLIC`                                                | Révoquer dans la même transaction que la création ; vérifier l'application publique et les privilèges par défaut.                                                                                                                                         |
| SQL dynamique, paramètre de table ou fuite par retour/erreur                   | Requêtes fixes, seul paramètre UUID, retours minimaux, erreurs et journaux privés revus.                                                                                                                                                                  |
| Importeur compromis                                                            | Il peut appeler les fonctions sur des UUID arbitraires et créer de la contention ; les fonctions ne prouvent pas qu'un UUID appartient au lot. Protéger les identifiants, limiter la durée des transactions, surveiller les verrous et mesurer ce risque. |
| Écrivain externe ou modification après COMMIT                                  | La fonction ne rend pas la protection permanente et ne remplace ni FK, ni UNIQUE, ni coordination opérationnelle.                                                                                                                                         |

`SECURITY DEFINER` retire l'UPDATE direct au rôle appelant ; il ne rend pas automatiquement sûre une fonction mal écrite ou possédée par un rôle trop puissant. [Références : sécurité des fonctions](https://www.postgresql.org/docs/18/sql-createfunction.html), [sécurité générale](https://www.postgresql.org/docs/18/perm-functions.html).

## 8. Impact sur D03, Drizzle et les migrations

- Le [contrat D03](../RESONANCES-V1-D03-IMPORT-DESIGN.md) conserve `SERIALIZABLE READ WRITE`, les trois modes de protection, l'ordre global, la revalidation après verrou, les trois tentatives complètes pour `40001`/`40P01` et le NOOP sans mutation métier. Il remplace les verrous directs de référence par les appels B1.
- Le dry-run `REPEATABLE READ READ ONLY` emploie les lectures ordinaires et n'appelle jamais les fonctions privilégiées. « Zéro écriture » désigne zéro commande SQL de modification et zéro mutation métier émise par D03, sans prétendre que PostgreSQL n'effectue aucune activité physique interne. [Référence : `SET TRANSACTION`](https://www.postgresql.org/docs/18/sql-set-transaction.html).
- Une **nouvelle migration SQL de sécurité** est nécessaire avant l'import transactionnel pour installer fonctions et permissions ; le provisionnement des rôles peut nécessiter un circuit de déploiement distinct. Aucune des six tables métier ni la migration initiale ne doit être modifiée pour B1.
- Le repository transactionnel devra appeler les fonctions sur la connexion de l'import, vérifier leurs résultats puis recalculer le plan. Le repository de dry-run reste en lecture ordinaire. Les détails Drizzle/`pg` seront vérifiés à l'implémentation.
- Cette décision ne rouvre pas D01–D06, D07/D08, le stockage média ni un CMS.

## 9. Tests requis, non exécutés

| Niveau                      | Cas et preuve attendue                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions positives       | L'importeur invoque exactement les trois fonctions et reçoit les valeurs de revalidation attendues.                                                                                                   |
| Permissions négatives       | L'importeur ne peut modifier directement Theme/MediaAsset, remplacer les fonctions, devenir leur propriétaire ou appliquer une migration ; l'application publique ne peut appeler aucune fonction B1. |
| Privilèges effectifs        | Inspecter propriétaires, rôles, héritages, droits de table et colonne, `PUBLIC`, `EXECUTE`, schémas et surcharges sur l'instance cible.                                                               |
| Sécurité du code SQL        | Objets homonymes en `pg_temp`, schémas non fiables, UUID nul/absent/arbitraire, absence de SQL dynamique et retours limités.                                                                          |
| Verrous sur deux connexions | Theme renommé, média supprimé, métadonnées publiées modifiées, média de draft modifié hors clé ; mesurer blocage, issue de sérialisation et conservation jusqu'à la fin de la transaction appelante.  |
| Ordre et retries            | UUID en ordre inverse, deux imports concurrents, `40001` et `40P01` ; plan entier relu et trois tentatives au maximum.                                                                                |
| NOOP et dry-run             | NOOP publié revalide sous `FOR SHARE` sans mutation métier ; dry-run n'appelle aucune fonction B1 ni commande SQL de modification.                                                                    |
| Déploiement                 | Installation et remplacement atomiques ; aucune fenêtre d'`EXECUTE` pour `PUBLIC` ; privilèges inchangés hors périmètre.                                                                              |

Les tests existants ne démontrent pas ces propriétés. Une faisabilité documentée n'est pas une validation opérationnelle.

## 10. Limites résiduelles et conditions de validation

Les fonctions verrouillent uniquement les lignes qu'elles trouvent. Les références absentes restent soumises à la validation métier, aux contraintes FK/UNIQUE et au traitement des erreurs SQL. Un écrivain externe peut agir après `COMMIT` ou contourner des invariants non exprimés physiquement, notamment l'unicité UUID entre Publication et Reflection. Les fonctions ne certifient ni les droits ni la disponibilité des fichiers média. Une identité d'import compromise peut demander des verrous sur des UUID arbitraires et retarder d'autres écrivains.

**BLOCKING — avant validation opérationnelle :** choisir et justifier les colonnes non identitaires du droit `UPDATE` résiduel ; installer la migration de sécurité dans un environnement dédié ; vérifier les rôles et privilèges réels ; exécuter les tests positifs, négatifs et concurrents du §9 ; confirmer les appels Drizzle/`pg` sur la même transaction ; examiner les risques de contention et les limites de temps. Le propriétaire a approuvé **l'architecture B1**, pas son implémentation future ni une configuration PostgreSQL encore inexistante.
