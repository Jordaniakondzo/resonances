# Résonances V1 — Provisionnement des rôles et installation ADR-B1

**Statut : implémentation D03-05 prête pour revue de sécurité indépendante ; non validée opérationnellement**

**Références :** [ADR-B1](../adr/ADR-B1-PRIVILEGED-REFERENCE-LOCKING.md), [politique des écrivains SQL](SQL-WRITER-POLICY.md), [contrat D03](../RESONANCES-V1-D03-IMPORT-DESIGN.md).

Ce document décrit ce que D03-05 installe réellement et ce que l'administrateur doit fournir avant. Il ne remplace pas la vérification des privilèges effectifs sur l'instance cible.

## 1. Ordre d'installation

1. **Administration des rôles** (circuit distinct, compte pouvant créer des rôles) : exécuter `db/provisioning/d03-b1-roles.sql`. Le script est idempotent, ne fixe aucun mot de passe et n'accorde aucun droit de table. Il crée `resonances_b1_owner` (`NOLOGIN`, sans aucun attribut privilégié, sans appartenance) et `resonances_importer` (`NOLOGIN` par défaut ; l'opérateur décide de son authentification hors dépôt).
2. **Autorisation de l'identité de migration** : `GRANT resonances_b1_owner TO <rôle_de_migration> WITH INHERIT FALSE, SET TRUE;` (exécuté par l'administrateur). La migration doit pouvoir faire `SET ROLE` vers le propriétaire pour créer le schéma et les fonctions à son nom, sans hériter de ses droits. Un superutilisateur n'en a pas besoin ; l'usage d'un compte non superutilisateur est recommandé.
3. **Migration** `db/migrations/0001_adr_b1_privileged_locking.sql` via `npm run db:migrate`, par l'identité de migration, qui possède les tables de référence. Aucun rôle n'est supposé exister : la migration commence par un contrôle préalable et échoue, sans rien créer, si les rôles sont absents ou mal formés.
4. **Droits de l'importeur sur les tables** : hors périmètre de D03-05. Les tests lui accordent la politique cible (lecture des six tables ; écriture sur `publications`, `reflections`, `publication_themes`, `reflection_themes`). Le circuit de production correspondant reste à définir avant D03-06.

## 2. Ce que la migration garantit (et vérifie avant de valider)

- Schéma `d03_priv` possédé par `resonances_b1_owner`, sans accès pour `PUBLIC`, `USAGE` pour l'importeur seulement.
- Trois fonctions `SECURITY DEFINER`, `plpgsql`, `STRICT`, `VOLATILE`, `PARALLEL UNSAFE`, SQL statique, tables qualifiées, `search_path = pg_catalog, pg_temp`. Le propriétaire est créé par `SET LOCAL ROLE`, donc propriétaire dès la création.
- `EXECUTE` révoqué à `PUBLIC` dans la même transaction que la création ; `ALTER DEFAULT PRIVILEGES` du propriétaire révoque aussi `EXECUTE` pour ses futures fonctions.
- Contrôle préalable : propriétaire non privilégié, `NOLOGIN`, sans appartenance, ne possédant pas les tables ; importeur non privilégié et incapable d'hériter du propriétaire ou de faire `SET ROLE` vers lui ; identité de migration autorisée à faire `SET ROLE`.
- Contrôles préalables ajoutés après le constat de revue sur les ACL (voir §2 bis) : privilèges par défaut du propriétaire, objets déjà possédés, chemins d'accès au propriétaire.
- Post-conditions ACL en liste blanche exacte (voir §2 bis), avec vérification des privilèges **effectifs** (héritage compris) de tous les rôles non superutilisateurs.

## 2 bis. Privilèges par défaut et préconditions du propriétaire B1

**Mécanisme.** `CREATE SCHEMA d03_priv AUTHORIZATION resonances_b1_owner` applique les privilèges par défaut enregistrés `FOR ROLE resonances_b1_owner` (`pg_default_acl`, `ALTER DEFAULT PRIVILEGES … ON SCHEMAS`). `REVOKE ALL ON SCHEMA … FROM PUBLIC` ne retire que `PUBLIC` : une entrée accordée à un autre rôle (par exemple `CREATE` à un rôle non fiable) subsiste. Les fonctions créées ensuite par le propriétaire héritent de la même façon de ses défauts sur les fonctions. Cette reproduction est couverte par le test « root cause » de `tests/b1-security.pg.test.ts`. Les défauts d'un autre rôle (par exemple l'identité de migration) ne s'appliquent pas aux objets créés pour le propriétaire.

**Préconditions (fail-closed, rien n'est réparé automatiquement).** La migration s'arrête, sans rien créer, si :

- une entrée `pg_default_acl` du propriétaire accorde un droit à un autre rôle ou à `PUBLIC` (seules les entrées dont le bénéficiaire est le propriétaire lui-même sont admises). L'administrateur inspecte `pg_default_acl` et retire l'entrée (`ALTER DEFAULT PRIVILEGES FOR ROLE resonances_b1_owner REVOKE …`) avant de relancer ;
- le propriétaire possède déjà un objet dans la base (dépendances propriétaire de `pg_shdepend`, hors ses propres entrées `pg_default_acl`) ;
- une appartenance au propriétaire hérite de ses droits (`INHERIT`) ou peut l'administrer (`ADMIN OPTION`), ou est détenue par l'importeur ou par un rôle dont l'importeur est membre.

**Post-conditions (vérifiées avant validation, toute dérive annule la transaction entière).**

- ACL du schéma et de chacune des trois fonctions : seuls le propriétaire, et pour l'importeur un `USAGE` (schéma) ou `EXECUTE` (fonctions) non transmissible, sont admis ; une ACL `NULL` sur une fonction est refusée.
- Privilèges effectifs : aucun rôle non superutilisateur autre que le propriétaire n'a `CREATE` sur `d03_priv` ; seuls l'importeur et les rôles qui en héritent ont `USAGE` sur le schéma ou `EXECUTE` sur les fonctions. Les rôles prédéfinis `pg_*` sont ignorés (par exemple `pg_read_all_data` a `USAGE` sur tous les schémas par conception, sans `CREATE` ni `EXECUTE`).
- Le propriétaire possède exactement un schéma, trois fonctions et, au plus, ses entrées `pg_default_acl` ; ses défauts n'accordent rien à un autre rôle ; aucun chemin par héritage, `ADMIN OPTION` ou importeur.

**Limite assumée.** Une appartenance `SET`-seul (`WITH INHERIT FALSE, SET TRUE`) au propriétaire est une décision de l'administrateur à l'échelle du cluster : elle est admise pour l'identité de migration, mais la migration ne peut pas distinguer cette identité d'un autre rôle `SET`-seul. Avant l'installation en production, l'administrateur doit lister `pg_auth_members` pour `resonances_b1_owner` et ne conserver que l'identité de migration.
- Post-conditions : exactement trois fonctions, propriétaire, `SECURITY DEFINER`, `search_path`, aucun `EXECUTE` pour `PUBLIC`, `EXECUTE` pour l'importeur, aucun `CREATE` pour l'importeur sur `d03_priv`, propriétaire sans `UPDATE` de table ni `UPDATE(id)`, importeur sans aucun `UPDATE` sur les références. Toute dérive annule la transaction entière (migration 0000 comprise, vérifié par test).
- Le fichier doit s'exécuter dans la transaction du migrateur Drizzle ; hors transaction, `SET LOCAL ROLE` serait sans effet et les post-conditions refuseraient le résultat.

## 3. Droit `UPDATE` résiduel du propriétaire B1

PostgreSQL exige `UPDATE` sur au moins une colonne pour `FOR SHARE` / `FOR KEY SHARE`. Choix retenu : **`updated_at`** sur `themes` et sur `media_assets`.

| Critère                                                             | `updated_at`                        | Alternatives écartées                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Colonne non identitaire, hors clé primaire, unique et clé étrangère | oui                                 | `id` interdit par l'ADR                                                                                              |
| Hors champs de résolution et de préparation média lus par D03       | oui                                 | `locale`, `slug`, `original_url`, `alt_text`, `source`, `license`, `author`, `width`, `height` sont lus ou sensibles |
| Hors contenu éditorial ou public                                    | oui (aucun code du dépôt ne la lit) | `description`, `name`, `caption` sont du texte potentiellement publié                                                |
| Sans contrainte `CHECK` ni effet de visibilité                      | oui                                 | `mime_type`, `thumbnail_url`, `web_url` risquent de devenir des champs de diffusion en D07/D08                       |

Le droit reste une vraie capacité d'écriture (le propriétaire pourrait modifier cette date) ; la sûreté repose sur l'impossibilité pour l'importeur de devenir ce rôle ou de modifier les fonctions, démontrée par les tests. `SELECT` du propriétaire : colonnes lues uniquement (`id, locale, slug` ; `id, original_url, alt_text, source, license, author, width, height`).

## 4. Environnement de test

Les tests PostgreSQL (`TEST_DATABASE_URL`) exigent maintenant un compte pouvant **créer des rôles** en plus de `CREATEDB` : la migration 0001 dépend de rôles à l'échelle du cluster, que l'aide de test `tests/support/b1-roles.ts` provisionne en exécutant le même script SQL que la production. Les rôles de test (`resonances_b1_test_*`) et les deux rôles B1 persistent dans l'instance dédiée après les tests ; seules les bases temporaires sont supprimées. Ne jamais pointer `TEST_DATABASE_URL` vers une instance contenant des données ou des rôles réels.

## 5. Comportements PostgreSQL 18.6 observés (tests `tests/b1-security.pg.test.ts`)

- `SELECT … FOR SHARE` / `FOR KEY SHARE` direct par l'importeur : `42501`. Via les fonctions : accepté.
- `lock_theme` (`FOR SHARE`) : bloque (délai de verrou `55P03`) renommage, changement de locale, toute autre mise à jour et suppression ; autorise un autre `FOR SHARE` et l'insertion d'une association (contrôle FK).
- `lock_media_ready` (`FOR SHARE`) : bloque toute mise à jour (métadonnées, clé, `updated_at`) et la suppression.
- `lock_media_key` (`FOR KEY SHARE`) : bloque suppression et changement de clé seulement ; **laisse passer** les mises à jour non clés (`alt_text`, `license`, `original_url`, `updated_at`). Un `FOR KEY SHARE` direct sur un thème bloquerait déjà `(locale, slug)` mais pas `name` : c'est pourquoi `lock_theme` emploie `FOR SHARE`.
- Verrous conservés jusqu'à `COMMIT`/`ROLLBACK` de l'appelant ; libérés en autocommit ; libérés par `ROLLBACK TO` un savepoint antérieur à l'appel, conservés par un savepoint posé après.
- Écrivain concurrent en attente réelle (`wait_event_type = Lock`), qui reprend après le `COMMIT` de l'importeur.
- En `SERIALIZABLE`, ligne modifiée ou supprimée et validée après l'instantané : appel refusé en `40001`, sauf `lock_media_key` face à une modification **non clé**, qui réussit (la fonction suit la nouvelle version ; l'instantané de l'importeur voit l'ancienne valeur). Ces issues sont des observations ; la politique de reprise appartient à D03-06.

## 6. Limites non démontrées par D03-05

Service d'import, reprises `40001`/`40P01`, deadlocks entre importeurs, NOOP sous transaction d'import : à démontrer en D03-06. Surveillance de contention, journaux et rotation des secrets : opérationnels. Un importeur compromis peut toujours verrouiller des UUID arbitraires ; les fonctions ne certifient pas l'appartenance au lot. Aucune validation sur l'instance de production.
