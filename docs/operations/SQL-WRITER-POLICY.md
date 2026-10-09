# Résonances V1 — Politique cible des écrivains SQL

**Statut : politique opérationnelle cible pour D03 V1 ; permissions effectives à vérifier avant déploiement**

**Référence :** [contrat D03 approuvé](../RESONANCES-V1-D03-IMPORT-DESIGN.md), [ADR-B1 approuvé](../adr/ADR-B1-PRIVILEGED-REFERENCE-LOCKING.md), [décisions L0](../RESONANCES-V1-L0-DECISIONS.md), [Data Core](../RESONANCES-V1-DATA-CORE.md)

Ce document définit **qui doit écrire quoi** dans le circuit V1. Il ne crée aucun rôle PostgreSQL, n'applique aucun privilège et ne modifie pas le schéma. Aucun nom de rôle ci-dessous n'est supposé déjà configuré. La vérification effective des permissions appartient au travail de préparation du déploiement ; D07/D08 ne sont pas ouverts par cette politique.

## 1. Responsabilités et périmètres

| Composant ou circuit                      | Écritures normales autorisées par la politique                                                        | Limite                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Importeur éditorial privé D03             | `publications`, `reflections`, `publication_themes`, `reflection_themes` dans une transaction par lot | **Seul circuit applicatif normal** pour ces quatre tables ; aucune mutation métier ni `UPDATE` direct sur Theme/MediaAsset ; verrous via B1.             |
| Gestion contrôlée des thèmes              | `themes` selon une procédure distincte                                                                | Préserver les références existantes et coordonner tout changement de `(locale, slug)` avec l'import ; aucune création implicite par D03.                 |
| Gestion contrôlée des médias              | `media_assets` selon une procédure distincte                                                          | Vérifier provenance, métadonnées, droits et disponibilité hors base ; aucune création implicite par D03.                                                 |
| Application publique                      | Lectures publiques filtrées par les règles de visibilité                                              | Aucun privilège d'écriture éditoriale, d'import ou de migration.                                                                                         |
| Migrations versionnées                    | Modifications du schéma dans un circuit de déploiement contrôlé                                       | Relire le SQL généré ; ne pas utiliser l'identité de l'application publique.                                                                             |
| Maintenance administrative exceptionnelle | Correction ponctuelle documentée et autorisée                                                         | Accès temporaire, traçable et limité ; préserver les invariants ou documenter la réparation nécessaire. Ce n'est pas un second circuit éditorial normal. |

**VALIDATED — frontière ADR-B1.** Les lectures verrouillantes PostgreSQL demandent `UPDATE` sur au moins une colonne, mais l'importeur ne reçoit aucun `UPDATE` direct sur `themes` ou `media_assets`. Il reçoit seulement `EXECUTE` explicite sur `d03_priv.lock_theme(uuid)`, `lock_media_key(uuid)` et `lock_media_ready(uuid)`. Ces fonctions fixes sont possédées par un rôle dédié `NOLOGIN`, non superutilisateur, distinct des propriétaires des tables ; il reçoit les `SELECT` nécessaires et un `UPDATE` limité à une colonne non identitaire de chaque table, choisie et vérifiée avant la migration. Ce droit résiduel permet réellement une modification de cette colonne par le propriétaire, même si les fonctions approuvées ne font que verrouiller et lire. Aucun `UPDATE` de table entière ni `UPDATE(id)`/clé primaire par défaut. Aucun rôle ou privilège n'est encore créé par ce document.

Les circuits Theme et MediaAsset peuvent être outillés plus tard, sans CMS ni interface d'administration publique en V1. Leurs écrivains doivent coordonner les modifications de clés et métadonnées avec le protocole de revalidation D03, respecter autant que possible l'ordre global des protections et participer aux tests de concurrence. Leur existence dans cette politique ne valide ni fournisseur média, ni pipeline D07/D08, ni nouveau rôle déjà installé.

## 2. Invariants que les écrivains doivent préserver

1. **Identité et clé éditoriale.** L'UUID reste stable. Après le premier import d'un UUID, `(locale, slug)` est immuable pour `draft`, `published` et `archived`, y compris `null`. Aucun transfert silencieux entre Publication et Reflection.
2. **Atomicité et idempotence.** L'import D03 valide le lot entier, recalcule son plan dans une transaction `SERIALIZABLE READ WRITE`, ne confirme le succès qu'après COMMIT et ne modifie aucune ligne ni association pour NOOP.
3. **Associations de thèmes.** Le lot exprime un ensemble déclaratif ; seuls les ajouts et retraits nécessaires sont écrits. Les clés étrangères et PK composites restent les derniers garde-fous.
4. **Références transactionnelles.** D03 revalide Theme et MediaAsset dans sa transaction `SERIALIZABLE` au moyen des trois fonctions ADR-B1 : `FOR SHARE` pour Theme et média destiné à `published`, `FOR KEY SHARE` pour média seulement utilisé par draft/archive. Les valeurs retournées sont revalidées après protection ; les verrous restent actifs jusqu'à la fin de la transaction sous réserve des savepoints.
5. **Dry-run.** `REPEATABLE READ READ ONLY`, lectures ordinaires et aucune fonction B1, aucune commande SQL de modification ni mutation métier. Cela ne promet pas l'absence d'activité physique interne de PostgreSQL. Aucun autre circuit ne doit interpréter un plan de dry-run comme une réservation ou une autorisation durable.
6. **Publication et visibilité.** Les médias d'un contenu destiné à `published` passent les contrôles automatiques D03 ; la vérification humaine de provenance, droits, attribution, alt et disponibilité reste obligatoire selon la [checklist éditoriale](EDITORIAL-PUBLICATION-CHECKLIST.md), avant un import immédiatement visible ou programmé pour devenir visible sans nouvel import.

La gestion des thèmes doit considérer qu'un renommage de `(locale, slug)` peut rendre les sources Markdown non résolubles, même si la FK par UUID demeure valide. La gestion des médias doit considérer qu'un retrait ou une dégradation des métadonnées peut rendre un NOOP publié conflictuel au prochain import. Ces circuits doivent être coordonnés avec la publication ; aucun accès direct n'est un raccourci pour contourner la validation D03.

## 3. Permissions : principe du moindre privilège

**Politique cible, non état constaté :** attribuer des identités de connexion distinctes selon le besoin opérationnel. L'application publique doit disposer uniquement des lectures requises. L'importeur doit pouvoir lire les références, modifier les quatre tables éditoriales et invoquer les trois fonctions B1 ; il reçoit donc `USAGE` sur le schéma privé `d03_priv` et `EXECUTE` sur leurs signatures exactes, **sans aucun `UPDATE` direct** sur `themes` ou `media_assets` et sans droit de modifier le schéma ou les fonctions. Il n'est ni propriétaire des fonctions ni membre, directement ou par chaîne, du rôle propriétaire avec capacité `INHERIT` ou `SET ROLE`. Les circuits de gestion Theme et MediaAsset sont distincts ; migrations et maintenance exceptionnelle utilisent des accès contrôlés et non exposés à l'application publique.

Le schéma des fonctions doit refuser `CREATE` aux rôles non fiables. Chaque fonction fixe son `search_path` à des schémas sûrs, qualifie explicitement ses objets SQL, n'emploie aucun SQL dynamique et n'accepte qu'un UUID. La migration future retire `EXECUTE` à `PUBLIC` dans la transaction de création, puis l'accorde seulement à l'importeur. Elle ne doit ouvrir ni terminer la transaction de l'appelant. Limiter les résultats retournés, inspecter les erreurs et les journaux, et surveiller l'abus possible : un importeur compromis pourrait appeler les fonctions sur des UUID arbitraires et créer de la contention. La séparation des privilèges réduit les dégâts directs, sans rendre ce compte inoffensif.

Avant un déploiement réel, vérifier sur l'instance cible :

- les rôles **réellement** créés, leurs propriétaires, appartenances et identifiants de connexion ;
- les privilèges effectifs sur tables, séquences, schémas et fonctions, y compris privilèges hérités ou accordés à `PUBLIC` ;
- les colonnes non identitaires retenues pour l'`UPDATE` résiduel du propriétaire B1, ainsi que l'absence de droit `UPDATE` sur toute la table ;
- le propriétaire réel, la définition et les surcharges éventuelles des trois fonctions, leur `search_path`, les droits `CREATE` du schéma privé et les droits `EXECUTE` de `PUBLIC` et de l'application publique ;
- l'absence d'appartenance permettant à l'importeur d'hériter des droits du propriétaire B1 ou de devenir ce rôle via `SET ROLE` ;
- l'absence de capacité d'écriture éditoriale pour l'identité de l'application publique ;
- l'impossibilité pour l'identité de l'importeur de modifier directement Theme/MediaAsset, de remplacer une fonction B1 ou d'appliquer des migrations ;
- la séparation des secrets, leur stockage et leur rotation ;
- l'audit des accès administratifs exceptionnels et une procédure de retrait de ces accès ;
- les tests positifs, négatifs et de concurrence sur une instance PostgreSQL dédiée, avec deux connexions pour démontrer la durée et l'effet des verrous, les retries et le dry-run sans appel B1.

Ce document n'exécute aucun `GRANT`, `REVOKE`, `CREATE ROLE` ou migration. La future migration SQL de sécurité ADR-B1 doit précéder l'import transactionnel sans modifier les six tables métier. Le choix des noms de rôles, de l'hébergement et du fournisseur média reste extérieur à ce lot.

## 4. Limites et conduite en cas d'écart

- Le schéma possède deux PK UUID distinctes : **l'unicité d'un UUID entre Publication et Reflection n'est pas une contrainte physique intertable**. Elle est garantie par le circuit privé D03 et sa discipline d'écriture ; un écrivain SQL externe peut la contourner.
- Les verrous et l'isolation protègent les lectures et écritures pendant la transaction concernée. Ils ne garantissent pas l'état des lignes après COMMIT ni la disponibilité des fichiers distants.
- Les FK et les champs média renseignés ne certifient ni les droits d'exploitation, ni les obligations d'attribution, ni l'existence effective des octets. La revue éditoriale reste une responsabilité humaine externe à D03.
- Un écrivain externe qui modifie directement les tables éditoriales peut violer l'immuabilité de la clé, le NOOP strict ou la cohérence intertype. Une opération de maintenance exceptionnelle doit être annoncée, limitée, documentée et suivie d'une vérification des invariants ; elle ne vaut pas autorisation générale d'écriture parallèle.

Si les permissions réelles divergent de cette politique, traiter l'écart avant le déploiement ou la diffusion publique. Ne pas présenter ce document comme preuve que la configuration PostgreSQL cible applique déjà ces restrictions.
