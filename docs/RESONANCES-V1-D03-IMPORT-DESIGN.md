# Résonances V1 — Contrat technique de l'import D03

**Statut : APPROVED — Ready for implementation**

**Date :** 9 octobre 2026 (Europe/Moscow)

**Branche de rédaction :** `codex/d03-import-design`

**Commit de référence examiné :** `5d4f9aed752711d04e82cb0368c7acd8fb32701a`

> **Approbation du propriétaire — 9 octobre 2026.** L'architecture D03 est approuvée. D03-SLUG-01, D03-MEDIA-01, D03-TX-01 et D03-RESULT-01 sont validées ; leurs limites documentées sont acceptées pour cette tranche. [ADR-B1](adr/ADR-B1-PRIVILEGED-REFERENCE-LOCKING.md) valide désormais le recours à trois fonctions `SECURITY DEFINER` spécialisées pour les verrous de référence ; son implémentation et sa sécurité restent à vérifier. Les modalités techniques auparavant marquées PROPOSED dans ce contrat sont des exigences de conception approuvées, sauf les points explicitement désignés comme ajustements d'implémentation. Les garanties PostgreSQL restent à démontrer par des tests. Cette approbation ne signifie pas que le moteur d'import existe ou fonctionne déjà. Les procédures opérationnelles avant diffusion publique restent obligatoires.

**Lecture des statuts internes.** **CONFIRMED** désigne un fait vérifié ou une décision antérieure ; **VALIDATED** désigne un arbitrage D03 du propriétaire ; **APPROVED** désigne une exigence de ce contrat ; **IMPLEMENTATION DETAIL** désigne une technique à confirmer ou ajuster pendant l'implémentation sans affaiblir l'invariant approuvé ; **BLOCKING** et **OPEN** signalent respectivement une condition impérative et un détail opérationnel non fixé. Les points OPEN ne révoquent pas l'approbation de l'architecture.

## 1. Contexte, autorité et état du dépôt

Le lot D03 restant concerne Batch Validation, ImportPlan, comparaison d'EditorialSnapshot, dry-run à zéro écriture et import privé atomique et idempotent. Il prend en charge `draft`, `archived` et `published`. Il ne crée ni interface d'administration, ni API HTTP interne, ni moteur de rendu, ni stockage média, ni tables de domaine supplémentaires.

**CONFIRMED — Hiérarchie des sources.** `docs/RESONANCES-V1-L0-DECISIONS.md` et `docs/RESONANCES-V1-SPECIFICATION.md` portent les décisions et exigences validées ; `docs/RESONANCES-V1-EDITORIAL-CONTRACT.md` précise le contrat déjà implémenté ; le code et la migration décrivent l'état physique. Le rapport antérieur `docs/audits/D03-PRE-IMPLEMENTATION-AUDIT.md` est un document de travail non suivi par Git à la date de cette révision, sans autorité de décision ni garantie de présence dans le commit. `docs/RESONANCES-V1-DATA-CORE.md` est un compte rendu daté : ses mentions d'un dépôt Git absent et d'une validation éditoriale encore à faire sont historiques. D01–D06 ne changent pas ; D07/D08 restent ouverts et ne sont pas traités ici.

**CONFIRMED — État observé.** Au commit de référence, `main` contient `db/schema.ts`, une migration initiale, `src/editorial/{types,parse,resolve}.ts`, `src/repositories/editorial-references.ts`, des tests éditoriaux et PostgreSQL, ainsi que les scripts npm. `parseContent` renvoie deux types discriminés et des dates JavaScript ; `resolveReferences` lit les thèmes et l'existence du média. Aucun ImportPlan, dry-run complet ou import n'existe. Le schéma possède six tables, des PK UUID séparées, `UNIQUE(locale, slug)` séparément pour chaque type, et `updated_at DEFAULT now()` sans trigger. `tests/schema.test.ts` teste la migration, les contraintes et la résolution ; il ne teste pas l'idempotence de l'import.

**Périmètre de la future implémentation :** la migration SQL de sécurité ADR-B1, le service d'import, ses repositories, des tests ciblés et la documentation nécessaire. La présente approbation documentaire ne modifie ni le code, ni les migrations, ni les tests, ni `sources/`.

## 2. Décisions D03 confirmées et orientations de cette revue

| Statut                        | Règle                                                                                                                             | Conséquence pour le lot                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **CONFIRMED**                 | Markdown/frontmatter dans Git, import privé vers PostgreSQL, validation, dry-run, transaction, idempotence, aucun HTML exécutable | La base reste la source publique ; pas de CMS/admin V1.                                                  |
| **CONFIRMED**                 | Publication et Reflection sont deux modèles distincts ; l'UUID est l'identité stable du circuit éditorial                         | Le slug et le chemin ne sont jamais des clés d'upsert.                                                   |
| **CONFIRMED**                 | Les thèmes source sont des slugs résolus exactement par `(locale, slug)` ; le parseur les déduplique et les trie                  | Aucune création automatique de Theme ; l'association cible est déclarative.                              |
| **VALIDATED — D03-SLUG-01**   | Après le premier import d'un UUID, `(locale, slug)` est immuable pour tous les statuts ; aucun changement de type implicite       | Tout écart de clé éditoriale est `IMMUTABLE_EDITORIAL_KEY`. Pas de redirection ni migration dans ce lot. |
| **VALIDATED — D03-MEDIA-01**  | Existence de toute référence média ; préparation minimale bloquante pour `published` ; revue humaine externe avant diffusion      | Une ligne `MediaAsset` complète n'est pas une certification de droits ou de disponibilité.               |
| **VALIDATED — D03-TX-01**     | Dry-run `REPEATABLE READ READ ONLY`, import `SERIALIZABLE READ WRITE`, plan recalculé, atomicité et NOOP strict                   | Le dry-run informe sans réserver l'état ; l'import revalide les références et conflits.                  |
| **VALIDATED — D03-RESULT-01** | APPLIED, REJECTED, FAILED et UNKNOWN_COMMIT_OUTCOME ; trois tentatives complètes maximum pour `40001`/`40P01`                     | Aucun succès avant COMMIT confirmé et aucun retry automatique si son issue est inconnue.                 |
| **APPROVED**                  | Quatre opérations de plan : CREATE, UPDATE, NOOP et CONFLICT ; erreurs de parsing séparées                                        | Toute erreur ou tout conflit rend le lot entier non applicable.                                          |

## 3. Contrats TypeScript approuvés

Les signatures suivantes fixent les invariants de type. Leur syntaxe exacte peut être ajustée aux types de Drizzle pendant l'implémentation, sans changer les quatre opérations ni les garanties de cohérence. Les commentaires des exemples de code sont en anglais conformément à `AGENTS.md`. Les types existants `ParsedContent`, `ContentValidationError` et `ReferenceReader` sont réutilisés.

```ts
type ContentType = "publication" | "reflection";
type ContentStatus = "draft" | "published" | "archived";

// Canonical UTC instant, e.g. 2026-10-08T12:34:56.123456Z.
type InstantUs = string;

interface SnapshotBase {
  id: string;
  locale: string;
  slug: string | null;
  title: string | null;
  status: ContentStatus;
  publishedAt: InstantUs | null;
  themeIds: readonly string[];
}

interface PublicationSnapshot extends SnapshotBase {
  type: "publication";
  hook: string | null;
  mediaAssetId: string | null;
  observation: string | null;
  evocation: string | null;
  reflection: string | null;
  openQuestion: string | null;
}

interface ReflectionSnapshot extends SnapshotBase {
  type: "reflection";
  excerpt: string | null;
  coverMediaId: string | null;
  content: string | null;
}

type EditorialSnapshot = PublicationSnapshot | ReflectionSnapshot;
type DiffField<S extends EditorialSnapshot> = Exclude<
  keyof S,
  "type" | "id" | "locale" | "slug"
>;
type SnapshotDiff<S extends EditorialSnapshot> = {
  [K in DiffField<S>]: { field: K; before: S[K]; after: S[K] };
}[DiffField<S>];

interface CreateOperation<S extends EditorialSnapshot> {
  kind: "CREATE";
  file: string;
  after: S;
}
interface UpdateOperation<S extends EditorialSnapshot> {
  kind: "UPDATE";
  file: string;
  before: S;
  after: S;
  diff: readonly [SnapshotDiff<S>, ...SnapshotDiff<S>[]];
}
interface NoopOperation<S extends EditorialSnapshot> {
  kind: "NOOP";
  file: string;
  snapshot: S;
}

type ConflictCode =
  | "DUPLICATE_ID"
  | "DUPLICATE_SLUG"
  | "TYPE_CHANGE"
  | "IMMUTABLE_EDITORIAL_KEY"
  | "SLUG_COLLISION"
  | "MISSING_REFERENCE"
  | "MEDIA_NOT_READY";

interface ConflictDiagnostic {
  category: "CONFLICT";
  code: ConflictCode;
  file: string;
  field?: string;
  relatedFile?: string;
  message: string;
}

interface ParseDiagnostic {
  category: "PARSE_ERROR";
  code: "INVALID_DOCUMENT";
  file: string;
  field: string;
  message: string;
}

interface ConflictOperation {
  kind: "CONFLICT";
  file: string;
  id?: string;
  diagnostics: readonly [ConflictDiagnostic, ...ConflictDiagnostic[]];
}

type ImportOperation =
  | CreateOperation<PublicationSnapshot>
  | CreateOperation<ReflectionSnapshot>
  | UpdateOperation<PublicationSnapshot>
  | UpdateOperation<ReflectionSnapshot>
  | NoopOperation<PublicationSnapshot>
  | NoopOperation<ReflectionSnapshot>
  | ConflictOperation;

interface ImportPlan {
  operations: readonly ImportOperation[];
  parseErrors: readonly ParseDiagnostic[];
  applicable: boolean;
}
```

**APPROVED — Cohérence du plan.** `applicable` vaut `true` si et seulement si `parseErrors.length === 0` et qu'aucune opération n'est `CONFLICT`. Un fichier non parsable n'a pas d'opération métier, puisqu'aucun `id` ou `type` fiable n'est disponible. Un document parsé mais invalide vis-à-vis du lot ou de PostgreSQL reçoit `CONFLICT`. L'ordre des fichiers et diagnostics est déterministe : chemins normalisés pour l'affichage, tri stable par chemin puis code/champ, sans utiliser ce chemin comme identité. Le plan peut montrer des CREATE/UPDATE/NOOP informatifs malgré un autre fichier en erreur, mais **aucune** de ces opérations n'est exécutable tant que le lot entier n'est pas applicable. Le diff d'un UPDATE exclut `locale` et `slug` : leur variation est un conflit, jamais une modification autorisée. Les unions `UpdateOperation<PublicationSnapshot> | UpdateOperation<ReflectionSnapshot>` préservent la correspondance de type entre `before` et `after` ; l'égalité des valeurs de clé est un invariant vérifié à l'exécution.

**APPROVED — Interface des effets.** Le service ne reçoit pas un writer en dry-run ; dans l'import, lecteur et writer utilisent la même transaction. Les méthodes d'écriture sont typées par contenu. Une mise à jour de thème seule met à jour `updated_at` du parent.

**VALIDATED — ADR-B1.** Le lecteur d'import utilise les fonctions `d03_priv.lock_theme(uuid)`, `d03_priv.lock_media_key(uuid)` et `d03_priv.lock_media_ready(uuid)` dans sa transaction `SERIALIZABLE`. Elles retournent les valeurs nécessaires à la revalidation. Le lecteur du dry-run conserve des `SELECT` ordinaires et n'appelle jamais ces fonctions. Les interfaces TypeScript ci-dessous expriment les données métier ; l'adaptateur transactionnel peut ajouter des méthodes spécialisées pour invoquer les fonctions sans exposer de nom de table ou de mode SQL arbitraire.

```ts
interface ImportReader extends ReferenceReader {
  findPublications(ids: readonly string[]): Promise<PublicationSnapshot[]>;
  findReflections(ids: readonly string[]): Promise<ReflectionSnapshot[]>;
  findSlugOwners(
    type: ContentType,
    keys: readonly { locale: string; slug: string }[],
  ): Promise<readonly { id: string; locale: string; slug: string }[]>;
  findMedia(ids: readonly string[]): Promise<readonly MediaReadinessRow[]>;
}

interface ImportWriter {
  insertPublication(snapshot: PublicationSnapshot): Promise<void>;
  insertReflection(snapshot: ReflectionSnapshot): Promise<void>;
  updatePublication(snapshot: PublicationSnapshot): Promise<void>;
  updateReflection(snapshot: ReflectionSnapshot): Promise<void>;
  applyThemeDelta(
    type: ContentType,
    id: string,
    removeIds: readonly string[],
    addIds: readonly string[],
  ): Promise<void>;
}

interface MediaReadinessRow {
  id: string;
  originalUrl: string;
  altText: string | null;
  source: string | null;
  license: string | null;
  author: string | null;
  width: number | null;
  height: number | null;
}
```

Une méthode existante `mediaExists` reste utile à `resolveReferences`; la lecture des métadonnées nécessaires ne doit pas être réimplémentée par un second résolveur concurrent. L'adaptateur transactionnel peut composer cette méthode et `findMedia`. Les signatures de `findSlugOwners` n'autorisent que les deux tables attendues, jamais un nom de table fourni par un document.

## 4. EditorialSnapshot et égalité métier

**APPROVED — Canonicalisation.** Le snapshot source reprend les champs normalisés de `parseContent`, les UUID médias et les `themeIds` de `resolveReferences`, triés et dédupliqués. `publishedAt` est converti du `Date` source vers une chaîne UTC à six chiffres fractionnaires, par exemple `.123Z` devient `.123000Z`. Le snapshot base contient les mêmes champs lus de PostgreSQL à pleine précision. `created_at`, `updated_at`, chemin, ordre d'écriture des thèmes et métadonnées de provenance MediaAsset ne font pas partie de l'égalité du contenu. Le média référencé est revalidé séparément à chaque tentative.

**APPROVED — Lecture temporelle sans perte.** Le mapping actuel `timestamp(..., { withTimezone: true })` produit des `Date` JavaScript. Ne pas l'utiliser pour la valeur de comparaison issue de PostgreSQL. Lire un champ SQL calculé sous une forme canonique :

```sql
CASE WHEN p.published_at IS NULL THEN NULL
     ELSE to_char(
       p.published_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
     )
END AS published_at_us
```

La requête utilise l'alias de la table correspondante. Le format et ses limites de plage de dates doivent être vérifiés sur PostgreSQL réel. Une date hors plage représentable par le contrat source JavaScript est un diagnostic explicite, pas un NOOP. Ne jamais convertir un entier de microsecondes depuis l'époque en `number` JavaScript : sa valeur courante dépasse l'entier sûr. Une comparaison SQL exacte `published_at IS NOT DISTINCT FROM $n::timestamptz` peut compléter le test, mais le snapshot affiché dans le diff doit conserver la précision.

**VALIDATED — Clé éditoriale immuable.** Avant tout diff d'UPDATE, comparer séparément `locale` et `slug` du snapshot source et de la ligne de même UUID. Toute différence, y compris `null` vers une valeur ou l'inverse, produit `IMMUTABLE_EDITORIAL_KEY`, quel que soit `status`. Un UUID trouvé dans l'autre table produit `TYPE_CHANGE` ; il ne devient jamais une création dans la nouvelle table. Cette politique protège les UUID déjà présents à partir de l'adoption du circuit D03, sans prouver l'historique des URL antérieures.

**APPROVED — Comparaison.** Une fois la clé identique, comparer les autres champs métier de même type avec sémantique `null` exacte ; comparer `themeIds` comme ensembles canoniques ; produire un diff non vide pour UPDATE. Si aucun de ces champs ne diffère **et** que toutes les validations actuelles passent, produire NOOP. Un tableau de thèmes dont l'ordre source change seul reste NOOP. Le contenu stocké n'est pas reformaté arbitrairement lors de la lecture ; l'égalité porte sur la valeur que le parseur produirait pour le même document. Une valeur en base écrite hors du circuit peut provoquer un UPDATE de normalisation plutôt qu'un NOOP, sauf si elle implique une clé éditoriale différente : ce dernier cas reste CONFLICT.

## 5. Classification CREATE / UPDATE / NOOP / CONFLICT

| Situation après parsing et validation complète                                                      | Opération du plan                                                           |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Aucun UUID dans les deux tables ; slug final disponible                                             | CREATE dans la table indiquée par `type`.                                   |
| UUID dans la même table ; `(locale, slug)` identique ; autres valeurs métier ou thème(s) différents | UPDATE avec `before` et `after` du **même type** et diff non vide.          |
| UUID dans la même table ; valeurs métier égales ; références et préparation média encore valides    | NOOP, strictement sans commande de mutation.                                |
| UUID dans la même table ; `locale` ou `slug` différent, pour tout statut                            | CONFLICT `IMMUTABLE_EDITORIAL_KEY`, même si le nouveau couple serait libre. |
| UUID dans l'autre table, conflit de slug, référence invalide ou média non prêt pour publication     | CONFLICT ; lot entier non applicable.                                       |
| Frontmatter, Markdown, type ou chemin invalide selon `parseContent`                                 | `ParseDiagnostic` séparé ; lot entier non applicable.                       |

**CONFIRMED —** Il n'existe pas de suppression ou d'archivage implicite des contenus dont le fichier ne figure pas dans le lot. Une transition explicite vers `archived` est un UPDATE ; une ligne `archived` peut être incomplète conformément au contrat éditorial. Un changement de `type` n'est jamais une conversion silencieuse.

## 6. Batch Validation et état final projeté

**APPROVED — Séquence.** Charger les octets de chaque fichier une fois avant les tentatives transactionnelles afin que les retries SQL portent sur le même lot source ; normaliser les chemins pour les diagnostics. Parser chaque document et collecter la première erreur structurée de chacun, sans perdre les erreurs des autres fichiers. Trier les documents valides par `(type, id, file)` pour une sortie stable. Détecter les UUID répétés **globalement entre types**, puis les slugs finaux répétés par `(type, locale, slug)` ; ignorer `slug = null`. Un doublon de source rend les documents concernés conflictuels.

Résoudre toutes les références de documents valides en lecture seule. Lire, dans une image cohérente de la base, les UUID dans **les deux** tables, les associations de thèmes et les propriétaires de chaque slug final. Pour chaque UUID existant, contrôler d'abord le type et l'égalité de `(locale, slug)` ; classer les écarts comme conflits. L'état final projeté ajoute les CREATE et remplace virtuellement les **seules valeurs modifiables** des UPDATE ; toutes les autres lignes et toutes les clés éditoriales existantes restent présentes. Vérifier l'unicité des couples finaux contre cet état, y compris les drafts et archives. Ne créer ni Theme ni MediaAsset. N'effectuer aucune mutation tant qu'un seul conflit ou une seule erreur de parsing existe.

**APPROVED — Diagnostics distincts.** `IMMUTABLE_EDITORIAL_KEY` désigne un écart sur la ligne portant déjà l'UUID, même si aucun autre contenu n'utilise le nouveau couple. `DUPLICATE_SLUG` désigne deux sources du lot proposant le même couple ; `SLUG_COLLISION` désigne l'occupation de ce couple par une autre ligne de PostgreSQL. Avec les clés existantes immuables, il n'y a plus de transition entre deux propriétaires à ordonner : les seules clés nouvelles proviennent de CREATE et doivent être libres. Aucun diagnostic séparé de « transition non prise en charge » n'est nécessaire.

**OPEN — Taille du lot.** Aucun plafond ni pagination d'import n'est documenté. Garder un lot borné et petit pour V1, sans optimisation massive. Définir une limite opérationnelle si les temps de transaction ou les requêtes de paramètres le rendent nécessaire, avec un diagnostic explicite plutôt qu'une troncature silencieuse.

## 7. Politique de slug et transitions

**CONFIRMED —** `UNIQUE(locale, slug)` existe séparément sur `publications` et `reflections`, est immédiat, et inclut toutes les lignes quel que soit leur statut. Les slugs `NULL` multiples sont permis. La spécification demande une redirection permanente si le slug publié change, mais aucun stockage de redirection n'existe. PostgreSQL ne peut pas différer une contrainte UNIQUE non déclarée `DEFERRABLE` ([documentation](https://www.postgresql.org/docs/current/sql-set-constraints.html)).

**VALIDATED — D03-SLUG-01.** Dès qu'un UUID existe dans sa table, son couple `(locale, slug)` est immuable dans D03 V1, que son statut soit `draft`, `published` ou `archived`. Un UPDATE peut modifier d'autres valeurs métier et les thèmes, mais ni `locale`, ni `slug`. Le passage `null → valeur`, `valeur → null`, et le changement simultané de locale et de slug sont tous `IMMUTABLE_EDITORIAL_KEY`. Un UUID dans l'autre table relève de `TYPE_CHANGE`, même si le couple proposé est libre. NOOP conserve la clé sans mutation. Un fichier absent du lot ne change aucune clé.

CREATE accepte le couple fourni par le nouveau document si le contrat du statut le permet et si `(type, locale, slug)` est libre. Plusieurs nouveaux drafts ou archives peuvent avoir `slug = null`. Deux nouveaux documents portant la même clé non nulle sont `DUPLICATE_SLUG` ; une clé déjà occupée par une ligne PostgreSQL est `SLUG_COLLISION`. Comme aucune ligne existante ne libère sa clé dans ce circuit, un échange ou cycle entre lignes existantes est refusé **en amont** comme `IMMUTABLE_EDITORIAL_KEY`. Aucun ordre d'UPDATE, phase temporaire `NULL`, migration UNIQUE ni table de redirections n'est requis dans cette tranche.

**VALIDATED — Conséquence opérationnelle M1.** Un brouillon importé avec `slug = null` ne pourra pas être publié ultérieurement sous le même UUID, puisque `published` exige un slug et que D03-SLUG-01 interdit `null → valeur`. Tout contenu destiné à être publié plus tard doit donc posséder son **slug définitif avant son premier import PostgreSQL**. Un brouillon sans slug peut rester en préparation dans Git ; son import en base engage définitivement cette clé nulle dans la première tranche. Aucune exception n'est implicite.

Le contrat éditorial antérieur décrit la stabilité de l'UUID lors d'un changement de slug comme une possibilité générale ; la décision D03-SLUG-01, plus récente et propre à cette première tranche, refuse précisément ce changement après le premier import. Cette divergence de portée ne doit pas être interprétée comme une autorisation de renommage.

**Limite historique.** La base actuelle ne possède aucun historique de publication ou de slug. `status: archived`, `status: draft` et `published_at` ne démontrent pas à eux seuls si une URL a été publiquement utilisée. La nouvelle immutabilité s'applique aux UUID déjà présents et à tous ceux importés ensuite ; elle ne reconstitue pas l'histoire antérieure du site et ne certifie pas l'absence d'anciennes URL. La spécification conserve l'exigence d'une redirection si un slug publié change, mais **ce lot refuse le changement** plutôt que de créer le mécanisme de redirection.

## 8. Préparation média et limites de certification

**CONFIRMED —** `media_assets` possède `original_url` non nul et non vide après trim, dimensions positives lorsqu'elles existent, et des champs facultatifs `alt_text`, `source`, `license`, `author`. Les FK empêchent une référence inexistante au moment de l'écriture ; `resolveReferences` contrôle déjà l'existence des UUID fournis. Le schéma ne vérifie pas les droits ni l'existence d'un fichier objet.

**VALIDATED — D03-MEDIA-01, contrôle automatique.** Pour **tout** statut, une référence média fournie doit exister. Pour une cible `published`, vérifier en plus les métadonnées du média principal de Publication et, si elle existe, de la couverture de Reflection : `original_url`, `alt_text`, `source` et `license` (licence ou déclaration de droits) non blancs ; dimensions strictement positives **si elles sont renseignées**. La migration actuelle impose déjà cette positivité par `CHECK` et laisse `width` et `height` nullables : D03 ne crée pas d'exigence automatique de dimensions présentes. La Publication publiée exige un média principal ; la Reflection publiée peut ne pas avoir de couverture. Draft et archive peuvent référencer un média existant aux métadonnées incomplètes. Les images Markdown du corps restent refusées par le contrat actuel. `author` est requis lorsque pertinent, mais la pertinence et la valeur exacte ne sont pas inférables automatiquement des champs existants.

Le contrôle automatique est **bloquant** pour une cible `published` si un champ obligatoire manque. Il prouve seulement présence et forme minimale ; il ne certifie ni le caractère descriptif du `alt_text`, ni la cohérence juridique de `license`, ni la provenance, ni les droits d'exploitation, ni l'existence réelle du fichier. `MEDIA_NOT_READY` signale ces absences vérifiables, sans annoncer une certification en cas de succès.

**VALIDATED — Procédure éditoriale privée préalable à toute diffusion publique.** Le responsable éditorial doit, hors importeur :

1. Identifier l'origine du média et son auteur lorsqu'il est pertinent.
2. Vérifier les droits pour l'utilisation prévue, ainsi que les obligations de licence et d'attribution.
3. Relire la description alternative dans le contexte de son affichage éditorial.
4. Vérifier que le fichier et sa variante destinée au public sont réellement disponibles.
5. Conserver les informations de traçabilité de génération IA lorsque pertinentes, dans le support privé approprié.

Cette revue précède la diffusion publique et relève d'une responsabilité humaine. La [checklist éditoriale vierge](operations/EDITORIAL-PUBLICATION-CHECKLIST.md) en fournit le modèle public ; le support privé des fiches complétées reste à choisir avant une véritable diffusion. D03 ne crée aucun champ `approved`, table de certification, fournisseur ou interface d'administration, et ne peut **pas prouver automatiquement** que la procédure a été effectuée. Aucune attestation n'est fabriquée par le résultat d'import.

**VALIDATED — Séquence M2.** `status = published` avec `published_at` déjà atteint peut rendre un contenu visible dès le COMMIT. Pour toute opération susceptible de le rendre immédiatement public : (1) identifier et stabiliser la version source ; (2) exécuter le dry-run ; (3) compléter la revue humaine ; (4) obtenir **AUTORISÉ POUR DIFFUSION** pour cette version exacte ; (5) exécuter l'import transactionnel ; (6) vérifier le résultat et sa correspondance avec la version autorisée. La vérification après import contrôle la conformité, elle n'accorde pas rétroactivement l'autorisation. Un import en `draft` reste préparatoire. Un contenu `published` avec `published_at` futur peut devenir public automatiquement à l'échéance **sans nouvel import** : obtenir l'autorisation pour sa version exacte avant cet import programmé, ou le garder en draft jusqu'à décision. Le dry-run ne réserve pas l'état et l'import recalcule son plan ; vérifier que la version source effectivement importée est celle autorisée et réexaminer tout écart pertinent du plan.

La revue humaine vérifie aussi les dimensions nécessaires au rendu lorsque le pipeline de diffusion les exige. Ce contrôle opérationnel ne transforme pas `width` ou `height`, actuellement nullables, en contrainte automatique D03.

**VALIDATED — Revalidation avant NOOP.** Si le document source est identique mais que son média publié est devenu incomplet ou a disparu, le résultat est CONFLICT, **pas** NOOP. Si les contrôles automatiques actuels passent, le contenu reste NOOP et ne subit aucune mutation. L'import n'efface ni ne corrige automatiquement un contenu déjà public dont le média est devenu invalide : il rejette le lot et signale l'action éditoriale requise. Le protocole de protection transactionnelle est détaillé au §9 ; il ne garantit ni l'état des métadonnées après COMMIT, ni la disponibilité du fichier distant.

**OPEN — Valeurs de provenance.** La forme exacte des déclarations dans `source` et `license`, et le cas où `author` est pertinent, ne sont pas fixés par le schéma. Recommandation : documenter des valeurs éditoriales lisibles et une revue humaine par source, sans prétendre les valider sémantiquement par expression régulière. Ne pas rouvrir D07/D08 pour ajouter un fournisseur ou un modèle de certification dans ce lot.

## 9. Architecture SQL et lectures

**APPROVED —** Écrire d'abord les requêtes relationnelles sous forme SQL, inspecter les index/contraintes existants, puis traduire en Drizzle. Les requêtes sont paramétrées et les noms de tables proviennent uniquement de l'union `ContentType`.

```sql
-- Read both content tables by the same batch UUID set.
SELECT id, locale, slug, title, status,
       CASE WHEN published_at IS NULL THEN NULL
            ELSE to_char(published_at AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS published_at_us,
       hook, observation, evocation, reflection, open_question, media_asset_id
FROM publications WHERE id = ANY($1::uuid[]);

SELECT id, locale, slug, title, status,
       CASE WHEN published_at IS NULL THEN NULL
            ELSE to_char(published_at AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS published_at_us,
       excerpt, content, cover_media_id
FROM reflections WHERE id = ANY($1::uuid[]);

-- Read all slug owners, including drafts and archives.
SELECT id, locale, slug FROM publications
WHERE (locale, slug) IN (VALUES ($1, $2), ($3, $4));

SELECT publication_id, theme_id FROM publication_themes
WHERE publication_id = ANY($1::uuid[]);

SELECT id, original_url, alt_text, source, license, author, width, height
FROM media_assets WHERE id = ANY($1::uuid[]);

-- Import only: invoke fixed privileged functions, one UUID at a time.
SELECT * FROM d03_priv.lock_theme($1::uuid);
SELECT * FROM d03_priv.lock_media_key($1::uuid);
SELECT * FROM d03_priv.lock_media_ready($1::uuid);
```

Équivalents pour Reflection et `reflection_themes`. Les PK, index UNIQUE et PK composites couvrent les accès ciblés. Les ensembles lus sont triés en mémoire avant comparaison. La résolution de thèmes reste exacte par `(locale, slug)` via l'adaptateur existant, dans la transaction courante. Ces appels de fonctions sont réservés à l'import ; les `SELECT` du dry-run ne prennent **aucun** verrou de ligne explicite et n'invoquent aucune fonction privilégiée. Les trois fonctions et leurs droits sont définis par [ADR-B1](adr/ADR-B1-PRIVILEGED-REFERENCE-LOCKING.md) ; l'importeur n'exécute pas directement `SELECT ... FOR SHARE` ou `FOR KEY SHARE` sur les tables de référence.

**VALIDATED — D03-TX-01 et ADR-B1, protections à distinguer.** Dans l'import, l'existence de l'UUID Theme ou MediaAsset, les attributs `(locale, slug)` du Theme et les métadonnées média de publication ne sont pas le même invariant. `FOR KEY SHARE` protège contre la suppression et les changements des colonnes clés pertinentes, mais peut laisser passer un `UPDATE` de colonnes non clés ; son effet exact sur `themes.locale` et `themes.slug` dépend notamment des contraintes et index uniques utilisables comme clés, et ne doit pas être assimilé au cas des métadonnées média non clés. La fonction `lock_theme` emploie `FOR SHARE` pour protéger le couple de résolution sans dépendre de cette distinction. `lock_media_key` emploie `FOR KEY SHARE` pour l'existence d'un média utilisé seulement par des drafts/archives ; `lock_media_ready` emploie `FOR SHARE` pour les métadonnées d'un média destiné à `published`, y compris lorsque le contenu finit NOOP. Si un média est utilisé dans les deux contextes, choisir la fonction forte. Les lignes de contenu existantes concernées par UPDATE peuvent ensuite être verrouillées `FOR UPDATE`. Les absences d'UUID ou de slug ne sont pas verrouillables par un SELECT de ligne : `SERIALIZABLE`, l'unicité SQL et les SQLSTATE restent indispensables. [Modes de verrouillage PostgreSQL 18](https://www.postgresql.org/docs/18/explicit-locking.html).

**APPROVED — Ordre et revalidation.** Tous les imports concurrents acquièrent les protections dans le même ordre : `lock_theme` par UUID croissant, puis `lock_media_key` ou `lock_media_ready` par UUID croissant avec le mode le plus fort requis pour chaque ligne, puis contenu existant par `(type, id)` croissant ; à l'intérieur d'une catégorie, appeler les fonctions une ligne à la fois dans cet ordre. Les fonctions retournent les valeurs nécessaires ; relire ou exploiter ces valeurs protégées et reconstruire/valider le plan **après** acquisition des protections, sur la même connexion et dans la même transaction. Un résultat vide est un conflit de référence, jamais une validation implicite. Si une ligne a changé depuis le snapshot de la transaction sérialisable, PostgreSQL peut produire `40001` plutôt qu'une nouvelle version visible : rollback puis nouvelle tentative complète. L'ordre réduit les deadlocks entre importeurs conformes, sans les exclure avec des écrivains externes. Un autre écrivain qui ne respecte pas les règles de résolution peut changer l'état après COMMIT ; il peut aussi contourner l'invariant intertype absent du schéma. Les tests de concurrence doivent mesurer exactement ces limites.

**VALIDATED — Frontière de privilèges ADR-B1.** PostgreSQL exige `UPDATE` sur au moins une colonne pour `SELECT ... FOR SHARE` et `FOR KEY SHARE`. L'importeur reçoit seulement `EXECUTE` sur les trois fonctions fixes et aucun `UPDATE` direct sur `themes` ou `media_assets`. Le rôle propriétaire `NOLOGIN`, non superutilisateur, distinct du propriétaire des tables, reçoit les `SELECT` requis et un `UPDATE` limité à une colonne non identitaire par table, à choisir et tester avant la migration. Il ne reçoit pas d'`UPDATE` sur toute la table. Les droits effectifs, héritages, propriétaires, `EXECUTE` de `PUBLIC`, `CREATE` sur le schéma privé et `search_path` doivent être vérifiés avant déploiement. Les fonctions ne créent ni ne terminent de transaction ; leurs verrous doivent durer jusqu'à la fin de celle de l'import, sous réserve des savepoints. La future migration SQL de sécurité est un sous-lot préalable à l'import transactionnel, sans changement des six tables métier.

**IMPLEMENTATION DETAIL — Ajustements autorisés.** La syntaxe exacte des projections temporelles Drizzle/pg et le regroupement des lectures peuvent être adaptés après essais sur PostgreSQL réel, à condition de préserver la précision microseconde, l'ordre déterministe, les trois fonctions et modes validés, la revalidation après protection et tous les invariants de concurrence ci-dessus. Changer la frontière ADR-B1 ou affaiblir ces garanties exige une nouvelle revue architecturale.

**Limite — microsecondes et Drizzle/pg.** Le mapping `Date` actuel est utile au reste du code, mais ne suffit pas pour le snapshot d'égalité. Le repository d'import doit sélectionner `published_at_us` comme texte via une expression SQL typée, puis confirmer au test que Drizzle/pg ne reconvertit pas cette projection. Aucun changement global de parseur `pg` ni migration n'est requis a priori ; si l'expérience contredit cette hypothèse, documenter l'écart avant d'adopter une autre solution.

## 10. Contrat du dry-run à zéro écriture

**VALIDATED — D03-TX-01.** Ouvrir une transaction PostgreSQL `REPEATABLE READ READ ONLY` avant toute lecture de la base. Construire l'ImportPlan par parsing source, `SELECT` ordinaires de références/snapshots/propriétaires et fonctions pures de validation/projection/comparaison. Aucun `SELECT FOR UPDATE/SHARE/KEY SHARE`, aucune fonction privilégiée ADR-B1, aucune invocation de `ImportWriter`, ni `INSERT`, `UPDATE`, `DELETE`, DDL, séquence ou autre commande SQL de modification. « Zéro écriture » signifie ici zéro mutation métier et aucune commande SQL de modification émise par D03 ; ce terme ne promet pas l'absence de toute activité physique interne de PostgreSQL. Ne pas écrire puis rollback : cette technique ne satisfait pas le contrat. La transaction doit être fermée proprement même sur erreur.

Le résultat est informatif : il décrit une image cohérente de la base, n'acquiert aucun droit d'application futur et ne réserve pas les slugs. L'import ultérieur recalcule le plan dans sa propre transaction. Un changement concurrent entre les deux peut transformer CREATE en UPDATE, NOOP en UPDATE ou un plan applicable en conflit ; le résultat d'import doit rapporter **son** plan final, pas recopier le dry-run.

## 11. Import, concurrence, erreurs et résultats

**VALIDATED — D03-TX-01.** Après chargement immuable du lot source, démarrer une transaction `SERIALIZABLE READ WRITE`. Refaire dans cette transaction les lectures, la résolution des références, les protections justifiées au §9, puis la relecture et le calcul intégral du plan. Si le plan n'est pas applicable, ne rien écrire et renvoyer un rejet. Sinon, appliquer les créations et mises à jour dans un ordre stable, puis les deltas de thèmes ; NOOP n'exécute aucune mutation. L'ensemble est validé par un seul COMMIT. Un échec dont le rollback est confirmé ne laisse aucune mutation validée. `updated_at` est renseigné explicitement pour chaque UPDATE, y compris celui dont seuls les thèmes changent ; `created_at` est conservé. Une création fournit l'UUID source et laisse les timestamps techniques être initialisés par la base.

**APPROVED — Granularité des thèmes.** Pour UPDATE, calculer `removeIds = before \ after` et `addIds = after \ before`. Supprimer seulement les paires retirées, insérer seulement les paires ajoutées. Si les thèmes sont identiques, ne toucher aucune association. Une mise à jour scalaire n'efface donc pas les thèmes ; une mise à jour de thèmes seule compte comme UPDATE du parent pour `updated_at`. CREATE insère exactement l'ensemble déclaré. Cette discipline évite le DELETE/INSERT global de paires inchangées et facilite la preuve du NOOP. Les FK et PK composites restent l'ultime garde-fou.

**VALIDATED — D03-RESULT-01, retries.** Au maximum **trois tentatives transactionnelles complètes, tentative initiale comprise**. Seuls `40001` (`serialization_failure`) et `40P01` (`deadlock_detected`) déclenchent automatiquement une nouvelle transaction après rollback confirmé. Chaque tentative relit les états pertinents, résout et revalide les références, acquiert les protections nécessaires et recalcule le plan ; elle ne rejoue jamais seulement la commande échouée. Prévoir une attente courte et raisonnable entre tentatives. Après trois échecs de ce type, retourner `FAILED / RETRY_EXHAUSTED` si l'absence de COMMIT est certaine.

**APPROVED — Classification SQL contextuelle.** Après rollback confirmé, analyser `23505` (unicité) et `23503` (foreign key) selon la contrainte et la commande concernées : un propriétaire de slug apparu peut devenir un rejet métier prouvé par une nouvelle lecture ; une FK média ou thème peut signaler une référence disparue ; une contrainte inattendue ou une erreur non reproductible reste un échec technique. Ne pas transformer toute erreur `23505`/`23503` en `CONFLICT`, ni les retryer aveuglément. `23001` peut apparaître sur une suppression RESTRICT selon l'opération, comme dans les tests actuels. Les autres SQLSTATE et erreurs de connexion restent distincts des diagnostics éditoriaux. Aucun retry automatique n'a lieu si le COMMIT a une issue inconnue. [Isolation PostgreSQL](https://www.postgresql.org/docs/current/transaction-iso.html) ; [codes SQLSTATE](https://www.postgresql.org/docs/current/errcodes-appendix.html).

```ts
type ImportExecutionResult =
  | {
      status: "APPLIED";
      committed: true;
      attempts: number;
      plan: ImportPlan;
      created: number;
      updated: number;
      noop: number;
    }
  | { status: "REJECTED"; committed: false; plan: ImportPlan }
  | {
      status: "FAILED";
      committed: false;
      attempts: number;
      code: "RETRY_EXHAUSTED" | "DATABASE_ERROR";
      message: string;
    }
  | {
      status: "UNKNOWN_COMMIT_OUTCOME";
      committed: "unknown";
      attempts: number;
      message: string;
    };
```

**VALIDATED — D03-RESULT-01, états terminaux.** `APPLIED` exige un COMMIT confirmé, même si le plan committé ne contient que des NOOP ; ses compteurs `created`, `updated` et `noop` comptent exclusivement **ce plan réellement committé**, jamais le dry-run ou une tentative abandonnée. `REJECTED` signifie rejet métier et aucune mutation validée. `FAILED` signifie échec technique **avec absence de commit confirmée**. Une perte de réponse pendant COMMIT devient `UNKNOWN_COMMIT_OUTCOME` : ni succès, ni rollback ne sont déduits de la seule erreur réseau ; l'opérateur doit vérifier l'état de la base avant toute décision de relance. Il n'y a aucun retry automatique de cette tentative. Les diagnostics de parsing et conflits sont rapportés via le plan sur `REJECTED`. Une erreur technique conserve un code exploitable dans les journaux privés, sans exposer de secrets ni contenu sensible inutile.

**Limite de concurrence.** Les contrôles `SERIALIZABLE` donnent une garantie pour les transactions participant au protocole ; des écrivains externes à isolation plus faible ou contournant le service peuvent modifier les métadonnées média ou insérer le même UUID dans l'autre table sans contrainte intertype physique. Les contraintes UNIQUE et FK protègent les invariants qu'elles expriment, mais aucune contrainte actuelle ne protège l'unicité globale de l'UUID entre deux tables. Recommandation : circuit privé unique d'écriture sur ces tables et privilèges SQL limités aux rôles nécessaires ; vérifier les courses pertinentes sur PostgreSQL réel. Une garantie physique universelle demanderait un autre arbitrage de schéma.

## 12. Invariants d'atomicité et d'idempotence

1. **VALIDATED — Atomicité globale :** zéro commit partiel du lot. Une erreur de parsing, un conflit ou une erreur SQL empêche toutes les mutations du lot de devenir visibles.
2. **VALIDATED — Identité et clé :** aucun doublon de lignes ou d'associations lors d'une répétition ; l'UUID source est préservé ; aucun passage implicite entre les deux types ; `(locale, slug)` d'un UUID existant n'est jamais modifié, même si son statut change.
3. **VALIDATED — NOOP strict :** aucune mutation de ligne, d'association ou de timestamp lorsque le snapshot est égal **et** que les validations actuelles passent, y compris la préparation média d'un contenu publié. Pas de `UPDATE ... WHERE` destiné seulement à « confirmer » l'égalité.
4. **VALIDATED — UPDATE minimal :** colonnes métier modifiables conformes au snapshot, `created_at` conservé, `updated_at` explicite, et seulement les associations de thèmes retirées/ajoutées modifiées.
5. **VALIDATED — Absence neutre :** un fichier absent du lot n'entraîne ni DELETE ni archivage ; seule une source présente avec `status: archived` peut demander ce changement.
6. **VALIDATED — Concurrence et résultat :** le plan appliqué est celui recalculé sous la transaction d'écriture ; un plan de dry-run n'autorise jamais une écriture fondée sur un état périmé ; `APPLIED` et ses compteurs nécessitent un COMMIT confirmé.

Ces invariants doivent être démontrés sur PostgreSQL réel pour les parties qui dépendent des contraintes et transactions. Un test ne doit pas inférer « aucune mutation » de la seule égalité des valeurs finales : vérifier aussi timestamps, associations et, pour NOOP strict, les commandes de mutation réellement émises.

## 13. Matrice de tests et critères d'acceptation

| Niveau                         | Cas                                                                                                                                                                                                    | Preuve nécessaire                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitaire : parsing/lot         | Deux fichiers avec UUID identique, y compris types différents ; deux slugs finaux identiques ; erreurs de parsing dans plusieurs fichiers                                                              | Diagnostics séparés, déterministes et reliés aux chemins ; lot non applicable.                                                                                                               |
| Unitaire : snapshots           | Thèmes réordonnés, doublons, chemin renommé, timestamps techniques différents, instant équivalent avec deux fuseaux                                                                                    | NOOP exact ; UPDATE uniquement si valeur métier différente.                                                                                                                                  |
| PostgreSQL : précision         | `published_at` initial en base à `.123456`, source valide à `.123000`, puis second import après UPDATE                                                                                                 | Premier passage UPDATE, second NOOP ; lecture à six chiffres conservée.                                                                                                                      |
| PostgreSQL : clé éditoriale    | UUID existant draft/published/archived : locale seule, slug seul, les deux, `null → valeur`, `valeur → null` ; échange/cycle entre UUID existants                                                      | Toujours `IMMUTABLE_EDITORIAL_KEY` avant écriture, quel que soit le statut ; UUID intertype → `TYPE_CHANGE`.                                                                                 |
| PostgreSQL : nouveaux slugs    | CREATE avec clé libre ; deux CREATE de même `(type, locale, slug)` ; collision avec draft/archive en base ; plusieurs `slug = null` ; passage ultérieur d'un draft importé sans slug à `published`     | Succès uniquement pour les clés libres et les `NULL` permis ; `DUPLICATE_SLUG` ou `SLUG_COLLISION` sinon ; la publication ultérieure de l'UUID sans slug est refusée.                        |
| PostgreSQL : références/médias | Média absent ; draft avec métadonnées incomplètes ; publication avec `alt_text`, `source` ou `license` vide ; couverture facultative ; dimensions nulles ou positives ; média du NOOP devenu incomplet | Validation selon §8 et les `CHECK` existants ; pas de nouvelle exigence automatique de dimensions présentes ; CONFLICT avant mutation et aucun faux NOOP.                                    |
| PostgreSQL : dry-run           | Lot applicable et lot conflictuel sous `READ ONLY`                                                                                                                                                     | Aucun appel au writer ni aux fonctions ADR-B1, aucune commande SQL de modification, valeurs/associations/timestamps identiques avant/après.                                                  |
| PostgreSQL : import            | CREATE puis même lot répété ; UPDATE scalaire ; ajout/retrait de thèmes ; document absent ; archive explicite                                                                                          | Pas de doublon ; second passage NOOP strict ; `created_at` conservé ; `updated_at` modifié pour UPDATE ; seules les paires de thèmes utiles changent.                                        |
| PostgreSQL : atomicité         | Erreur dans le dernier fichier, collision/FK après plan, erreur à mi-écriture                                                                                                                          | Aucun commit partiel de ligne ou association.                                                                                                                                                |
| PostgreSQL : concurrence       | Même UUID, UUID intertype, même slug ; suppression ou changement `(locale, slug)` de Theme ; média draft supprimé ; métadonnées média publié modifiées ; NOOP publié face à ces changements            | Trois fonctions ADR-B1, modes `FOR KEY SHARE`/`FOR SHARE` et valeurs retournées vérifiés ; revalidation après verrou ; `40001`/`40P01` rejouent le plan entier ; limites externes observées. |
| PostgreSQL : sécurité B1       | Rôle import, rôle public et propriétaire des fonctions ; droits directs, hérités et `PUBLIC` ; objet homonyme dans `pg_temp` ; remplacement ; contention sur deux sessions                             | `EXECUTE` réservé à l'import, aucun `UPDATE` direct sur références, propriétaire limité, `search_path` sûr, verrous jusqu'à la fin de transaction, abus et erreurs contrôlés.                |
| Opérationnel : diffusion       | Version source stabilisée, dry-run, revue humaine, autorisation, import pouvant rendre visible dès COMMIT, contrôle après import                                                                       | `AUTORISÉ POUR DIFFUSION` précède l'import immédiatement public ; le contrôle post-import n'est pas une autorisation rétroactive.                                                            |
| PostgreSQL : résultats         | COMMIT confirmé, lot tout-NOOP, rejet métier, rollback technique confirmé, perte de réponse pendant COMMIT, trois `40001`/`40P01` successifs                                                           | Quatre états terminaux exacts ; compteurs seulement pour APPLIED ; trois tentatives maximum ; aucune relance automatique après issue inconnue.                                               |
| Vérification documentaire      | Comparer le document aux décisions D01–D06, au contrat éditorial et au SQL généré                                                                                                                      | Aucune décision historique inventée ; migrations inchangées pour cette tranche.                                                                                                              |

**Critères d'acceptation approuvés :** les cas d'erreur rendent le lot non applicable ; toute variation de `(locale, slug)` sur UUID existant est rejetée ; un contenu destiné à être publié possède son slug définitif dès son premier import ; dry-run vérifié sans commande SQL de modification ni verrou de ligne explicite ; import atomique et idempotent sur base temporaire dédiée ; NOOP prouvé sans mutation après revalidation média ; dates comparées sans perte ; médias publiés contrôlés selon §8 ; trois fonctions ADR-B1, privilèges minimaux, protections Theme/MediaAsset et revalidation après verrou démontrés ; maximum trois tentatives complètes pour `40001`/`40P01` ; quatre états terminaux et compteurs vérifiés ; autorisation humaine antérieure à tout import immédiatement public ; formatage, typage, tests pertinents et revue du SQL effectués et rapportés. Les tests existants ne remplissent pas encore ces critères.

### Traçabilité D03

| Exigence                           | Sections du contrat | Preuve attendue                                                                        |
| ---------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| Identité UUID et types distincts   | 2–5                 | Tests UUID répétés/intertype et upsert par PK.                                         |
| Parsing et diagnostics             | 3, 5–6              | Diagnostics distincts, lot non applicable.                                             |
| Snapshots, diff, NOOP              | 3–5, 12             | Comparaison pure et absence de mutation.                                               |
| Batch Validation et références     | 6, 9                | Projection finale et contraintes PostgreSQL.                                           |
| D03-SLUG-01 : clé immuable         | 3–7, 12             | Variations de locale/slug et collisions refusées.                                      |
| M1 : draft sans slug               | 7, 13               | Slug définitif avant premier import destiné au public ; transition ultérieure refusée. |
| D03-MEDIA-01 : deux vérifications  | 8, 11–13            | Métadonnées bloquantes ; revue humaine hors importeur.                                 |
| M2 : autorisation avant diffusion  | 8, 13               | Décision liée à la version source avant COMMIT immédiatement visible.                  |
| Dry-run                            | 10                  | Transaction READ ONLY, zéro écriture.                                                  |
| D03-TX-01 : transaction/références | 9–12                | Verrous justifiés, revalidation, atomicité.                                            |
| ADR-B1 : privilèges des verrous    | 3, 9–10, 13         | Trois fonctions et permissions testées sur PostgreSQL réel.                            |
| D03-RESULT-01 : résultats/retries  | 11–13               | Quatre états, compteurs committés, trois essais maximum.                               |
| Atomicité et idempotence, AC07     | 12–13               | Deux imports identiques et échec sans écriture partielle.                              |

## 14. Découpage recommandé pour Codex

| Ordre | Tâche                                                                                      | Fichiers probables, à confirmer au démarrage                       | Fin démontrable                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 0     | Prendre le contrat approuvé, ADR-B1 et les deux procédures opérationnelles comme référence | Ce document, `docs/adr/` et `docs/operations/`                     | Aucun conflit avec D01–D06 ; conditions de diffusion publique identifiées.                                           |
| 1     | Snapshots, instant microseconde, diff et diagnostics purs                                  | `src/editorial/`, `tests/`                                         | Tests unitaires d'égalité, dates, types et diagnostics.                                                              |
| 2     | Repositories de lecture transactionnels                                                    | `src/repositories/`, tests PostgreSQL                              | Lecture des deux types, slugs, thèmes et médias prouvée.                                                             |
| 3     | Batch Validation et projection finale                                                      | `src/editorial/` ou petit service `src/services/`, tests           | Clé existante immuable, cas draft sans slug et collisions CREATE prouvés.                                            |
| 4     | Dry-run privé zéro écriture                                                                | service et éventuel script privé sous `scripts/`, tests PostgreSQL | `REPEATABLE READ READ ONLY`, aucun writer et aucune fonction B1 démontrés.                                           |
| 5     | Migration SQL de sécurité ADR-B1 et tests des rôles et verrous                             | nouvelle migration SQL inspectable, tests PostgreSQL dédiés        | Fonctions spécialisées, privilèges, protections, revalidation et contention démontrés avant l'import transactionnel. |
| 6     | Writer et import transactionnel                                                            | service, repository, tests PostgreSQL                              | Appels B1, atomicité, NOOP strict, deltas de thèmes, trois retries au plus et quatre états démontrés.                |
| 7     | Synchronisation documentaire et vérification                                               | `README.md`, `docs/`, scripts de vérification si besoin            | Procédure reproductible, commandes réellement exécutées et limites indiquées.                                        |

Ne pas modifier `db/schema.ts` ni créer de migration de slug ou de redirection : les clés existantes sont immuables dans cette tranche. La migration de sécurité ADR-B1 est distincte et **n'est pas créée par ce document** ; elle doit précéder l'import transactionnel. Si une autre nécessité imprévue apparaît, retourner au cadrage architectural avant d'introduire une décision. L'import reste un outil privé, sans route publique. Pour les tests d'intégration, utiliser `TEST_DATABASE_URL` vers l'instance dédiée prévue par le projet ; les tests actuels créent puis suppriment une base temporaire. `npm run db:verify` ne couvre aujourd'hui que la migration initiale.

## 15. Risques, limites et arbitrages restant ouverts

| Statut                          | Sujet                                                            | Recommandation et limite explicite                                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **VALIDATED — limite acceptée** | Historique de publication absent avant D03                       | L'immuabilité de `(locale, slug)` s'applique à tout UUID existant dès ce circuit ; elle ne reconstruit pas les anciennes URL. Aucun renommage de draft n'est autorisé.                                       |
| **OPEN**                        | Auteur « lorsque pertinent » et contenu de `source`/`license`    | Définir une grille de relecture éditoriale privée. Vérifier automatiquement la présence non blanche, jamais la validité des droits.                                                                          |
| **OPEN**                        | Support privé des fiches complétées et preuves avant publication | Le [modèle vierge](operations/EDITORIAL-PUBLICATION-CHECKLIST.md) est public ; choisir le support privé réel sans nouveau champ ni table.                                                                    |
| **OPEN**                        | Diffusion après le COMMIT                                        | Les métadonnées ou fichiers distants peuvent changer ensuite ; l'import ne certifie pas un état permanent. La stratégie de retrait/publication et de cache appartient à la tranche applicative ultérieure.   |
| **OPEN**                        | Limite de taille du lot et délai entre retries                   | Trois tentatives au maximum sont validées ; choisir une limite de lot et un délai court, mesurés aux tests, sans troncature ni succès implicite.                                                             |
| **OPEN**                        | Image dans le corps des Réflexions                               | Le contrat actuel la refuse ; la spécification évoque un mécanisme ultérieur. Ne pas élargir le parseur dans D03.                                                                                            |
| **VALIDATED — limite connue**   | Unicité globale de l'UUID entre deux tables                      | Garantie par le circuit privé D03, sans contrainte physique intertable ; un écrivain externe peut contourner ce contrat. Restreindre les privilèges et tester les courses du circuit.                        |
| **OPEN**                        | Permissions effectives des écrivains SQL                         | La [politique cible](operations/SQL-WRITER-POLICY.md) définit les périmètres ; vérifier les rôles et privilèges réels avant déploiement. Les verrous n'empêchent pas une modification postérieure au COMMIT. |
| **VALIDATED — à démontrer**     | Fonctions privilégiées ADR-B1                                    | [Architecture approuvée](adr/ADR-B1-PRIVILEGED-REFERENCE-LOCKING.md), mais migration, permissions, sûreté des fonctions et contention non testées ; validation opérationnelle bloquée.                       |

**BLOCKING — avant toute diffusion publique :** la vérification humaine des droits, de la provenance, de l'attribution, de l'alt, de la disponibilité et de la traçabilité IA pertinente doit être réalisée hors importeur, même si les métadonnées minimales passent. Le document ne prétend pas qu'elle est automatiquement attestée. **Risque accepté pour D03 :** aucun historique d'URL n'est reconstruit ; la clé de tout UUID déjà présent est désormais immuable et aucun mécanisme de redirection n'est ajouté.

## 16. Conditions de passage à l'implémentation et verdict

**APPROVED — Conditions de réalisation et de diffusion :** (1) l'implémentation doit démontrer sur PostgreSQL réel les microsecondes, les fonctions ADR-B1, leurs permissions, les protections de lignes et tous les critères du §13 avant d'être déclarée terminée ; (2) les fiches éditoriales complétées et leurs preuves doivent rester dans un support privé choisi avant diffusion ; (3) les privilèges et circuits d'écriture doivent être vérifiés avant déploiement selon la [politique des écrivains SQL](operations/SQL-WRITER-POLICY.md) ; (4) la [checklist de publication](operations/EDITORIAL-PUBLICATION-CHECKLIST.md) doit être exécutée humainement **avant tout import immédiatement visible**. Le dry-run demeure informatif et l'absence d'historique d'URL reste une limite acceptée.

**Verdict architectural : APPROVED — Ready for implementation sous conditions B1.** Les quatre arbitrages D03 et l'architecture des fonctions privilégiées sont approuvés pour la première tranche. Aucune migration des six tables métier ni nouveau champ n'est prévu ; une migration SQL de sécurité ADR-B1 sera nécessaire. L'immuabilité de la clé supprime le besoin de redirection dans ce lot, mais impose le slug définitif avant le premier import de tout futur contenu public. Le moteur et les fonctions B1 ne sont **pas encore implémentés ni testés**. Les tests PostgreSQL, notamment privilèges, microsecondes, verrouillage/revalidation, dry-run, trois tentatives et NOOP strict, devront fournir la preuve pendant l'implémentation. Les conditions opérationnelles ci-dessus restent impératives avant toute diffusion publique.
