# Résonances V1 — Frontière SQL de lecture publique (T2)

**Statut : implémentation T2 après revue de sécurité ; permissions effectives à vérifier sur l'instance cible avant déploiement.**

L'application publique ne lit jamais les tables éditoriales. Elle lit deux vues `security_barrier` du schéma `public_read`, créées par la migration `0002_public_read_views`.

## 1. Architecture

| Élément                                                                 | Rôle                                                                                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `resonances_public_views_owner` (`NOLOGIN`)                             | Possède `public_read` et ses vues. `SELECT` par colonnes sur les sources, aucune écriture, aucun accès à `original_url`/`original_filename`. |
| `resonances_app_reader`                                                 | Identité de l'application (`APP_DATABASE_URL`). `USAGE` sur `public_read`, `SELECT` sur les deux vues, **rien d'autre**.                   |
| `public_read.publications`                                              | Publications visibles : `status = 'published' AND published_at IS NOT NULL AND published_at <= now() AND slug IS NOT NULL`. Image Web seulement (jointure média avec `web_url` non vide). |
| `public_read.publication_themes`                                        | Thèmes des publications visibles (même règle appliquée à la publication parente).                                                          |

- Les vues s'exécutent avec les droits de leur propriétaire (pas de `security_invoker`) : c'est ce qui permet de ne donner aucun droit sur les tables au lecteur.
- `security_barrier` empêche une fonction placée dans la clause `WHERE` d'un appelant de s'exécuter avant le filtre de visibilité.
- L'horloge est celle de PostgreSQL (`now()`). Aucun paramètre d'instant n'existe dans le code applicatif.
- Aucun nouveau statut éditorial. Le retrait reste `archived` (ou tout passage hors de `published`).

## 2. Ordre d'installation

1. **Rôles** (administrateur pouvant créer des rôles) : `db/provisioning/app-reader.sql`. Il crée les rôles manquants en `NOLOGIN` et **ne modifie jamais un rôle existant** : un rôle dans un état inattendu (attribut privilégié, appartenance à un autre rôle, propriétaire avec `LOGIN`, membre du lecteur) fait échouer le script sans rien changer. Il est donc rejouable uniquement sur un état conforme.
2. **Autorisation de migration, le temps de la migration seulement** : `GRANT resonances_public_views_owner TO <rôle_de_migration> WITH INHERIT FALSE, SET TRUE;` — `<rôle_de_migration>` est le seul rôle qui peut jamais détenir le propriétaire des vues (§2 bis).
3. **Migration** `0002` via `npm run db:migrate`, exécutée par ce rôle. Son contrôle préalable refuse les rôles absents ou mal formés, toute appartenance non autorisée au propriétaire (§2 bis) et tout droit en trop du propriétaire (§2 ter) ; ses post-conditions annulent toute la transaction en cas de dérive. Elle retire aussi les anciens droits directs du lecteur sur les tables. Ensuite, **retirer l'appartenance** : `REVOKE resonances_public_views_owner FROM <rôle_de_migration>;` (si le processus a été interrompu entre-temps : §5).
4. **Activation de `LOGIN`** (hors Git) : `ALTER ROLE resonances_app_reader LOGIN PASSWORD '…';` puis `APP_DATABASE_URL` côté serveur uniquement.
5. **Vérification opérationnelle** (§3), à refaire après chaque activation ou changement de rôle.

## 2 bis. Qui peut atteindre le propriétaire des vues (C4)

`NOLOGIN` n'empêche pas `SET ROLE` : tout membre d'`resonances_public_views_owner` peut en prendre l'identité. La règle est donc stricte :

- **Un seul rôle autorisé** : le rôle migrateur. Dans la migration, c'est `current_user`. Dans `app-reader.sql` et `app-reader-verify.sql`, on le nomme explicitement avant l'exécution : `SET resonances.migration_role = '<rôle_de_migration>';`. Sans cette déclaration, **aucune** appartenance n'est acceptable (cas recommandé : après la migration, l'appartenance est retirée).
- **`SET` seul** : le migrateur ne doit avoir ni `INHERIT` ni `ADMIN OPTION`.
- **Tout autre membre est refusé**, même `SET` seul, directement ou **par une chaîne de rôles** (un rôle membre du migrateur est refusé : il atteindrait le propriétaire). Les superutilisateurs sont hors de ce que ces contrôles peuvent borner.
- **Aucune révocation silencieuse** : le contrôle échoue avec la liste des membres trouvés (`rôle (INHERIT SET ADMIN)`) et ne change rien. L'opérateur inspecte `pg_auth_members`, révoque délibérément, puis relance.

Les mêmes règles sont appliquées à trois endroits : le contrôle préalable de la migration, le provisionnement et la vérification.

## 2 ter. Droits effectifs du propriétaire des vues (C5)

Le propriétaire doit pouvoir lire **exactement** ces colonnes sources, et rien d'autre : `publications` (`id, locale, slug, title, status, published_at, hook, observation, evocation, reflection, open_question, media_asset_id`), `publication_themes` (`publication_id, theme_id`), `themes` (`id, slug, name`), `media_assets` (`id, web_url, thumbnail_url, alt_text, caption, author, source, license, width, height`).

Le contrôle porte sur les droits **effectifs** (`has_column_privilege`, `has_table_privilege`, `has_sequence_privilege`), donc sur les droits directs, hérités et accordés à `PUBLIC` — pas seulement sur les `GRANT` des scripts. Sur toute relation qu'il ne possède pas, il refuse : tout `SELECT` hors de la liste (notamment `reflections`, `description`, `original_url`, `original_filename`, `created_at`), tout droit d'écriture, tout droit sur une séquence. Il exige aussi les `SELECT` nécessaires aux vues. La migration échoue avant d'avoir accordé quoi que ce soit si un état non conforme préexiste, et sans le corriger.

## 3. Vérification après activation de LOGIN

Depuis un compte d'administration (lecture du catalogue seulement, aucune modification) :

```sh
# Seulement si le migrateur détient encore le propriétaire des vues (sinon, ne rien déclarer) :
#   PGOPTIONS="-c resonances.migration_role=<rôle_de_migration>"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f db/provisioning/app-reader-verify.sql
```

Elle échoue au premier écart : attributs privilégiés ; appartenance, héritage ou `SET ROLE` vers un autre rôle ; privilège sur une relation, colonne, séquence, schéma, fonction ou la base autre que `SELECT` sur les deux vues ; définition des vues ; droits d'écriture ou d'accès aux originaux du propriétaire.

Puis, connecté **en tant que le lecteur** avec la chaîne utilisée par l'application :

```sh
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/provisioning/app-reader-selfcheck.sql
```

Elle prouve depuis la session réelle : identité (`session_user`), impossibilité de changer de rôle, refus de lire les tables sources ou d'écrire, lecture possible des vues.

Elle passe dans les deux modes de session et indique lequel dans sa notice finale (`read-only transaction: true|false`) :

- **Lecture-écriture** (`psql` ci-dessus, sans option) : c'est ce mode qui prouve les **privilèges** du rôle, car aucun refus n'y est dû au mode de la transaction.
- **Lecture seule**, comme le pool de l'application (`default_transaction_read_only=on`) : `PGOPTIONS="-c default_transaction_read_only=on" psql …`. Toute création y est refusée par la transaction (SQLSTATE `25006`), y compris celle d'une table temporaire, quel que soit le droit `TEMPORARY` ; l'auto-contrôle le constate sans le signaler comme anomalie (C9). Ce mode ne prouve donc pas les privilèges : `default_transaction_read_only` n'est qu'une valeur par défaut que le rôle peut changer (`BEGIN READ WRITE`), et ce sont les privilèges qui forment la frontière.
À vérifier hors SQL : `pg_hba.conf` et le réseau, le stockage et la rotation du mot de passe, l'absence du secret dans le client (`check:client-bundle`).

## 4. Limites assumées

- Les superutilisateurs et les rôles prédéfinis `pg_*` sont hors de ce que ces contrôles peuvent borner.
- **`TEMPORARY` (C6).** T2 ne révoque pas `TEMPORARY` : c'est un droit de la base, accordé à `PUBLIC` par défaut, et la base est partagée ; le retirer pour tous n'est pas décidé par T2. Conséquence : **le lecteur peut créer des objets temporaires**, qui n'existent que le temps de sa session et ne sont visibles de personne d'autre (un test le vérifie). Il ne peut pas créer d'objet permanent (`CREATE` refusé sur tout schéma et sur la base), ne peut lire aucune table source (une table temporaire n'ouvre aucun accès) et ne peut écrire aucune donnée éditoriale. La vérification affiche le droit effectif et s'il vient de `PUBLIC`. L'auto-contrôle distingue le **droit** (catalogue) de ce que la **transaction courante** permet : création réussie seulement si le droit est accordé et la transaction en lecture-écriture ; refus attendu en lecture seule quel que soit le droit ; refus pour privilège seulement si le droit manque (§3). Révoquer `TEMPORARY` sur la base reste une décision d'exploitation distincte.
- `PUBLIC` garde `USAGE` sur le schéma `public` (défaut PostgreSQL) ; le lecteur n'y lit ni n'y crée rien, et sa session est en lecture seule.
- La règle de visibilité est écrite dans les vues **et** dans `db/visibility.ts` (contrat des tables). Un test compare les deux sur les cas limites ; toute évolution de la règle doit toucher les deux.
- Les performances des vues n'ont pas été mesurées sur des volumes représentatifs.

## 5. Interruption entre `GRANT` et `REVOKE` (C8)

L'appartenance temporaire du rôle de migration (§2, étapes 2 et 3) ne peut pas tenir dans une seule transaction : le migrateur Drizzle ouvre et valide sa propre transaction sur sa propre connexion, qui ne voit un `GRANT` fait par une autre session qu'une fois celui-ci validé. Si le processus est interrompu brutalement après le `GRANT` (processus tué, connexion perdue), **la fin de session libère les verrous mais n'annule pas un `GRANT` validé** : l'appartenance reste. La migration 0002, elle, est atomique : elle est appliquée entièrement ou pas du tout (journal `drizzle.__drizzle_migrations`).

Une appartenance restante n'est **jamais** retirée automatiquement : son origine ne peut pas être prouvée par un programme. Les contrôles (migration, provisionnement, vérification, outil de test) la refusent avec la liste `rôle (options; granted by …)`. Reprise, par un administrateur pouvant gérer le rôle :

1. **S'assurer qu'aucune migration n'est en cours** : aucun processus de migration actif ; pour les suites de tests, aucune session ne détient le verrou de rôles (`pg_locks`, verrou consultatif `hashtext('b1-roles')`).
2. **Relever l'état** :
   ```sql
   SELECT r.rolname AS member, m.inherit_option, m.set_option, m.admin_option, g.rolname AS grantor
   FROM pg_auth_members m
   JOIN pg_roles r ON r.oid = m.member
   LEFT JOIN pg_roles g ON g.oid = m.grantor
   WHERE m.roleid = 'resonances_public_views_owner'::regrole;
   ```
3. **Établir l'origine** de chaque appartenance : rôle de migration de l'opération interrompue, `SET` seul, accordé par l'administrateur qui l'a lancée. Une appartenance d'origine inconnue relève d'un incident de sécurité, pas d'un nettoyage.
4. **Révoquer explicitement la ligne identifiée**, seulement celle dont l'origine est établie, en nommant son membre **et** son grantor relevés à l'étape 2 (un même membre peut détenir plusieurs appartenances, une par grantor) : `REVOKE resonances_public_views_owner FROM <rôle_de_migration> GRANTED BY <grantor>;`
5. **Relancer `app-reader-verify.sql`** (sans déclarer `resonances.migration_role`), puis la migration si elle n'était pas appliquée.

**Suites de tests.** Les fichiers de test s'exécutent en parallèle sur un même cluster. Toute opération de test qui lit ou modifie des appartenances de rôle (provisionnement, `ALTER ROLE`, scénarios négatifs C4, vérification, migration) prend le **même** verrou consultatif (`hashtext('b1-roles')`, `tests/support/b1-roles.ts`). Pour un cycle `GRANT` → migration → `REVOKE`, ce verrou est tenu au niveau de la session, et à l'intérieur d'une transaction pour le reste (C7). Il est toujours pris dans la base de `TEST_DATABASE_URL`, car un verrou consultatif ne vaut que dans sa base. Ce verrou est **coopératif** : il ne lie que le code qui le prend.

L'outil `migrateWithViewsOwner` (C8, C10) :

- vérifie l'absence de tout membre et accorde l'appartenance **dans une même transaction** ;
- relève l'**identité exacte** de la ligne créée : OID de la ligne, du rôle, du membre et du grantor, options, et version de ligne (`xmin`, qui change à toute modification, même annulée ensuite) ;
- après la migration, ne la révoque (`REVOKE … GRANTED BY …`) que si elle est restée **strictement identique** et qu'**aucune autre** appartenance n'existe. Sinon, il ne révoque **rien** et décrit chaque écart : disparition, remplacement, changement d'options, de grantor ou de version, appartenance étrangère.

La vérification et l'action qui la suit se font dans une transaction qui verrouille `pg_auth_members` (`SHARE ROW EXCLUSIVE`). Ce verrou-là s'impose à **toute** session, coopérative ou non : `GRANT`, `REVOKE`, `CREATE`/`DROP ROLE` et toute écriture directe dans le catalogue attendent la fin de la transaction, tandis que les lectures ne sont pas bloquées. Pendant la migration elle-même, rien n'est verrouillé : une modification faite à ce moment est **détectée** au nettoyage, pas empêchée. L'outil exige un superutilisateur.

Après un arrêt brutal, la reprise suit les étapes ci-dessus ; `tests/views-owner-lock.pg.test.ts` en démontre le déroulement.
