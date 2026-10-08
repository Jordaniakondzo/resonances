# Résonances V1 — Politique cible des écrivains SQL

**Statut : politique opérationnelle cible pour D03 V1 ; permissions effectives à vérifier avant déploiement**

**Référence :** [contrat D03 approuvé](../RESONANCES-V1-D03-IMPORT-DESIGN.md), [décisions L0](../RESONANCES-V1-L0-DECISIONS.md), [Data Core](../RESONANCES-V1-DATA-CORE.md)

Ce document définit **qui doit écrire quoi** dans le circuit V1. Il ne crée aucun rôle PostgreSQL, n'applique aucun privilège et ne modifie pas le schéma. Aucun nom de rôle ci-dessous n'est supposé déjà configuré. La vérification effective des permissions appartient au travail de préparation du déploiement ; D07/D08 ne sont pas ouverts par cette politique.

## 1. Responsabilités et périmètres

| Composant ou circuit                      | Écritures normales autorisées par la politique                                                        | Limite                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Importeur éditorial privé D03             | `publications`, `reflections`, `publication_themes`, `reflection_themes` dans une transaction par lot | **Seul circuit applicatif normal** pour ces quatre tables ; pas d'écriture sur Theme ou MediaAsset.                                                      |
| Gestion contrôlée des thèmes              | `themes` selon une procédure distincte                                                                | Préserver les références existantes et coordonner tout changement de `(locale, slug)` avec l'import ; aucune création implicite par D03.                 |
| Gestion contrôlée des médias              | `media_assets` selon une procédure distincte                                                          | Vérifier provenance, métadonnées, droits et disponibilité hors base ; aucune création implicite par D03.                                                 |
| Application publique                      | Lectures publiques filtrées par les règles de visibilité                                              | Aucun privilège d'écriture éditoriale, d'import ou de migration.                                                                                         |
| Migrations versionnées                    | Modifications du schéma dans un circuit de déploiement contrôlé                                       | Relire le SQL généré ; ne pas utiliser l'identité de l'application publique.                                                                             |
| Maintenance administrative exceptionnelle | Correction ponctuelle documentée et autorisée                                                         | Accès temporaire, traçable et limité ; préserver les invariants ou documenter la réparation nécessaire. Ce n'est pas un second circuit éditorial normal. |

Les circuits Theme et MediaAsset peuvent être outillés plus tard, sans CMS ni interface d'administration publique en V1. Leur existence dans cette politique ne valide ni fournisseur média, ni pipeline D07/D08, ni nouveau rôle déjà installé.

## 2. Invariants que les écrivains doivent préserver

1. **Identité et clé éditoriale.** L'UUID reste stable. Après le premier import d'un UUID, `(locale, slug)` est immuable pour `draft`, `published` et `archived`, y compris `null`. Aucun transfert silencieux entre Publication et Reflection.
2. **Atomicité et idempotence.** L'import D03 valide le lot entier, recalcule son plan dans une transaction `SERIALIZABLE READ WRITE`, ne confirme le succès qu'après COMMIT et ne modifie aucune ligne ni association pour NOOP.
3. **Associations de thèmes.** Le lot exprime un ensemble déclaratif ; seuls les ajouts et retraits nécessaires sont écrits. Les clés étrangères et PK composites restent les derniers garde-fous.
4. **Références transactionnelles.** D03 revalide Theme et MediaAsset dans sa transaction. Les protections doivent distinguer l'existence de l'UUID, `(locale, slug)` des thèmes et les métadonnées média utilisées pour autoriser `published` ; la revalidation suit l'acquisition des protections nécessaires.
5. **Dry-run.** `REPEATABLE READ READ ONLY`, lectures ordinaires et zéro écriture. Aucun autre circuit ne doit interpréter un plan de dry-run comme une réservation ou une autorisation durable.
6. **Publication et visibilité.** Les médias d'un contenu destiné à `published` passent les contrôles automatiques D03 ; la vérification humaine de provenance, droits, attribution, alt et disponibilité reste obligatoire selon la [checklist éditoriale](EDITORIAL-PUBLICATION-CHECKLIST.md).

La gestion des thèmes doit considérer qu'un renommage de `(locale, slug)` peut rendre les sources Markdown non résolubles, même si la FK par UUID demeure valide. La gestion des médias doit considérer qu'un retrait ou une dégradation des métadonnées peut rendre un NOOP publié conflictuel au prochain import. Ces circuits doivent être coordonnés avec la publication ; aucun accès direct n'est un raccourci pour contourner la validation D03.

## 3. Permissions : principe du moindre privilège

**Politique cible, non état constaté :** attribuer des identités de connexion distinctes selon le besoin opérationnel. L'application publique doit disposer uniquement des lectures requises. L'importeur doit pouvoir lire les références et modifier les quatre tables éditoriales, sans permission générale de modifier `themes`, `media_assets` ou le schéma. Les circuits de gestion Theme et MediaAsset doivent être limités à leurs tables et aux lectures nécessaires. Les migrations et la maintenance exceptionnelle utilisent des accès séparés, contrôlés et non exposés à l'application publique.

Avant un déploiement réel, vérifier sur l'instance cible :

- les rôles **réellement** créés, leurs propriétaires, appartenances et identifiants de connexion ;
- les privilèges effectifs sur tables, séquences, schémas et fonctions, y compris privilèges hérités ou accordés à `PUBLIC` ;
- l'absence de capacité d'écriture éditoriale pour l'identité de l'application publique ;
- l'impossibilité pour l'identité de l'importeur de modifier Theme/MediaAsset ou d'appliquer des migrations ;
- la séparation des secrets, leur stockage et leur rotation ;
- l'audit des accès administratifs exceptionnels et une procédure de retrait de ces accès ;
- les tests d'intégration des opérations autorisées **et refusées** sur une instance dédiée.

Ce document n'exécute aucun `GRANT`, `REVOKE`, `CREATE ROLE` ou migration. Le choix des noms de rôles, de l'hébergement et du fournisseur média reste extérieur à ce lot.

## 4. Limites et conduite en cas d'écart

- Le schéma possède deux PK UUID distinctes : **l'unicité d'un UUID entre Publication et Reflection n'est pas une contrainte physique intertable**. Elle est garantie par le circuit privé D03 et sa discipline d'écriture ; un écrivain SQL externe peut la contourner.
- Les verrous et l'isolation protègent les lectures et écritures pendant la transaction concernée. Ils ne garantissent pas l'état des lignes après COMMIT ni la disponibilité des fichiers distants.
- Les FK et les champs média renseignés ne certifient ni les droits d'exploitation, ni les obligations d'attribution, ni l'existence effective des octets. La revue éditoriale reste une responsabilité humaine externe à D03.
- Un écrivain externe qui modifie directement les tables éditoriales peut violer l'immuabilité de la clé, le NOOP strict ou la cohérence intertype. Une opération de maintenance exceptionnelle doit être annoncée, limitée, documentée et suivie d'une vérification des invariants ; elle ne vaut pas autorisation générale d'écriture parallèle.

Si les permissions réelles divergent de cette politique, traiter l'écart avant le déploiement ou la diffusion publique. Ne pas présenter ce document comme preuve que la configuration PostgreSQL cible applique déjà ces restrictions.
