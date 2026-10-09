# Résonances V1 — D03 Pre-implementation Architecture Audit

**Date de l'audit :** 8 octobre 2026 (Europe/Moscow)

**Rôle :** Architecture Consultant, lecture seule

**Dépôt audité :** `C:\Users\User\Documents\projets\resonances`

**Branche :** `main`

**Commit HEAD :** `5d4f9aed752711d04e82cb0368c7acd8fb32701a`
**État de l'arbre de travail au début et à la livraison :** propre

> Ce rapport est un livrable de revue. Les choix marqués **PROPOSED** ne sont pas des décisions validées. Aucun fichier du dépôt, aucune branche, migration, base de données, commit ou pull request n'a été modifié ou créé pour cet audit. Aucun test n'a été exécuté pendant l'audit ; les résultats de tests cités par les documents du projet sont historiques.

## 1. Périmètre, méthode et sources

Le prochain lot D03 couvre Batch Validation, ImportPlan, comparaison des EditorialSnapshot, dry-run sans écriture, import transactionnel PostgreSQL et idempotence. L'audit ne propose ni D07/D08, ni CMS, ni interface d'administration, ni pages publiques.

Sources locales inspectées : `AGENTS.md`, `README.md`, `docs/RESONANCES-V1-SPECIFICATION.md`, `docs/RESONANCES-V1-L0-DECISIONS.md`, `docs/RESONANCES-V1-DATA-CORE.md`, `docs/RESONANCES-V1-EDITORIAL-CONTRACT.md`, `docs/RESONANCES-V1-TRANSITION.md`, `db/schema.ts`, `db/visibility.ts`, `db/migrations/0000_editorial_core.sql`, `src/editorial/{types,parse,resolve}.ts`, `src/repositories/editorial-references.ts`, `tests/{editorial,schema}.test.ts`, `package.json`, `drizzle.config.ts`, `.env.example` et les scripts de migration/vérification. Les chemins ont été vérifiés dans le dépôt. Le dépôt local est la preuve de l'implémentation examinée ; la page GitHub n'a pas servi à établir le SHA ou l'état de travail.

Références techniques consultées : [PostgreSQL — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html), [SET CONSTRAINTS](https://www.postgresql.org/docs/current/sql-set-constraints.html), [SQLSTATE](https://www.postgresql.org/docs/current/errcodes-appendix.html). Les recommandations transactionnelles ci-dessous restent à éprouver sur l'instance de test du projet.

## 2. Audit de compatibilité

### 2.1 Identité et modèle

- **CONFIRMED** — D03 impose Markdown/frontmatter versionné dans Git, validation, dry-run, transaction, idempotence et PostgreSQL comme source des lectures publiques. Les décisions D01–D06 restent validées.
- **CONFIRMED** — `ParsedContent` est une union discriminée `publication | reflection`. `parseContent` normalise l'UUID en minuscules, les chaînes, la locale, les thèmes par slug et les dates en `Date`. Le chemin sert à vérifier le type et à situer les erreurs ; il ne produit aucune identité. Les champs techniques `created_at` et `updated_at` ne figurent pas dans le contrat éditorial.
- **CONFIRMED** — `resolveReferences` renvoie `{ content, themeIds }`, avec les UUID de thèmes dédupliqués et triés. `ReferenceReader` permet `findTheme(locale, slug)` et `mediaExists(id)` ; l'adaptateur Drizzle existant n'effectue que des SELECT.
- **CONFIRMED** — `publications` et `reflections` ont chacune une PK UUID. Le schéma n'interdit pas le même UUID dans les deux tables. Une vérification de changement de type doit donc consulter les deux tables, sans supposer que l'unicité locale des PK suffit.
- **PROPOSED** — L'identité d'upsert est `(type, id)` pour choisir la table, avec `id` stable. Le slug n'est jamais une clé d'upsert. Si l'UUID est trouvé dans l'autre table, retourner `TYPE_CHANGE` plutôt que créer silencieusement une seconde ligne.

### 2.2 Valeurs, contraintes et état documentaire

- **CONFIRMED** — Le schéma utilise `TIMESTAMPTZ`. `updated_at` possède `DEFAULT now()` sans trigger ; une véritable mise à jour doit le renseigner explicitement. `UNIQUE(locale, slug)` est séparé par type et concerne également drafts et archives. Plusieurs slugs `NULL` sont possibles. Les PK des tables de jonction empêchent les doublons d'association.
- **CONFIRMED** — La migration SQL initiale contient les contraintes présentes dans `db/schema.ts`. Les contraintes d'unicité de slug ne sont pas `DEFERRABLE`. `SET CONSTRAINTS` ne peut donc pas les différer dans l'état actuel.
- **CONFIRMED** — Le schéma exige une date pour `status = published`, mais n'impose pas titre, sections/corps, média ni thème. Ces règles doivent être appliquées par le circuit d'import. Le prédicat de visibilité public tient compte du statut et de `published_at <= now()`.
- **CONFIRMED** — Les tests existants couvrent parsing, validation, références, intégrité SQL, visibilité et répétition de la migration. Ils ne démontrent ni un dry-run complet, ni un import, ni le NOOP, ni l'idempotence de l'import.
- **CONFIRMED — écart documentaire daté** — `docs/RESONANCES-V1-DATA-CORE.md` relate qu'il n'y avait pas encore de dépôt Git et que la validation éditoriale restait à réaliser. Le dépôt actuel et `README.md` montrent ces deux évolutions. Ce compte rendu historique ne doit pas être pris pour l'état présent ; le clarifier sans réécrire son historique.
- **OPEN — écart de portée** — La spécification évoque des images intégrées aux Réflexions via `MediaAsset`, tandis que le contrat Markdown actuel les refuse provisoirement. D03 doit appliquer le contrat déjà implémenté et consigner cette divergence pour la suite.

### 2.3 Risques techniques prioritaires

1. **BLOCKING — changement de slug publié.** La spécification demande une redirection permanente depuis l'ancienne URL. Le Data Core ne possède pas de registre de redirections. Accepter un changement de slug publié dans ce lot sans redirection violerait la spécification. Recommandation provisoire : `CONFLICT` pour ce cas.
2. **BLOCKING pour publier — préparation du média.** L'existence d'une ligne `media_assets` ne prouve ni droits, ni licence, ni alt pertinent, ni fichier/variante accessible. Le contrat éditorial et le Data Core indiquent cette limite ; la spécification demande les métadonnées nécessaires avant publication. Un minimum vérifiable doit être arrêté avant que D03 autorise `status: published`.
3. **PROPOSED — précision temporelle.** Le parseur accepte au plus des millisecondes alors que PostgreSQL conserve des microsecondes. Une conversion de `published_at` PostgreSQL en `Date` JavaScript peut effacer les trois derniers chiffres et créer un faux NOOP. Comparer l'instant complet en UTC à six décimales, ou par une comparaison SQL exacte avec l'instant source, sans conversion perdante. `created_at` et `updated_at` sont exclus de l'égalité éditoriale.
4. **PROPOSED — frontière de concurrence.** `SERIALIZABLE` exige un retry de la transaction entière après `40001`. L'unicité des slugs et les FK restent les garde-fous physiques. L'unicité d'UUID entre deux tables n'est pas garantie pour des écrivains externes contournant le service.

## 3. Contrats TypeScript proposés

**PROPOSED —** Conserver les types `ParsedContent`, `ReferenceReader` et `ContentValidationError`. Ajouter des snapshots persistés distincts, sans table générique `Content`. Une source est transformée en snapshot après résolution des références. Un snapshot de base provient d'une lecture cohérente des colonnes métier et des associations de thèmes. Les `themeIds` sont triés ; le chemin, les dates techniques et l'ordre original des thèmes n'en font pas partie.

```ts
type ContentType = "publication" | "reflection";
type ContentStatus = "draft" | "published" | "archived";

// UTC instant with six fractional digits; never reconstructed from a lossy DB Date.
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
type ChangedField = Exclude<keyof PublicationSnapshot | keyof ReflectionSnapshot,
  "id" | "type">;

interface FieldDiff {
  field: ChangedField;
  before: unknown;
  after: unknown;
}

type DiagnosticCode =
  | "INVALID_DOCUMENT" | "DUPLICATE_ID" | "DUPLICATE_SLUG"
  | "TYPE_CHANGE" | "MISSING_REFERENCE" | "PUBLISHED_SLUG_CHANGE"
  | "MEDIA_NOT_READY" | "DATABASE_CONFLICT";

interface Diagnostic {
  code: DiagnosticCode;
  file: string;
  field?: string;
  relatedFile?: string;
  message: string;
}

type ImportOperation =
  | { kind: "CREATE"; file: string; after: EditorialSnapshot }
  | { kind: "UPDATE"; file: string; before: EditorialSnapshot;
      after: EditorialSnapshot; diff: readonly FieldDiff[] }
  | { kind: "NOOP"; file: string; snapshot: EditorialSnapshot }
  | { kind: "CONFLICT"; file: string; id?: string;
      diagnostics: readonly Diagnostic[] };

interface ImportPlan {
  operations: readonly ImportOperation[];
  diagnostics: readonly Diagnostic[];
  applicable: boolean;
}
```

`CONFLICT` rend le plan entier non applicable. `FieldDiff` sert à expliquer le plan ; l'écriture utilise le snapshot typé complet et ne prend pas un dictionnaire de valeurs arbitraires. Un résultat de parsing invalide peut produire un diagnostic même si aucun snapshot ne peut être créé. Les messages restent adaptés à l'auteur ; le `code`, le champ et les fichiers permettent des tests stables.

Interfaces de repository proposées, à adapter à l'API Drizzle effectivement disponible :

```ts
interface EditorialReader extends ReferenceReader {
  findPublicationsByIds(ids: readonly string[]): Promise<PublicationSnapshot[]>;
  findReflectionsByIds(ids: readonly string[]): Promise<ReflectionSnapshot[]>;
  findSlugOwners(
    type: ContentType,
    keys: readonly { locale: string; slug: string }[],
  ): Promise<readonly { locale: string; slug: string; id: string }[]>;
}

interface EditorialWriter {
  insert(snapshot: EditorialSnapshot): Promise<void>;
  update(snapshot: EditorialSnapshot): Promise<void>;
  replaceThemes(snapshot: EditorialSnapshot): Promise<void>;
}
```

Le lecteur et le writer de l'import doivent être liés à **la même transaction**. Le service orchestre le lot ; les repositories contiennent les requêtes Drizzle. Les erreurs SQL non classées restent des erreurs techniques et conservent leur SQLSTATE. Aucune couche HTTP interne n'est nécessaire.

## 4. Batch Validation et projection

**PROPOSED —** Séparer le calcul pur du plan des lectures nécessaires pour le nourrir :

1. Lire uniquement les fichiers explicitement sélectionnés ; parser chaque fichier avec `parseContent`, conserver son chemin réel et agréger les diagnostics. Un parseur qui échoue sur le premier champ d'un document ne force pas l'arrêt immédiat de l'analyse des autres fichiers.
2. Détecter les UUID répétés dans le lot, y compris entre Publication et Reflection. Détecter les slugs finaux répétés par `(type, locale, slug)`, avec `NULL` ignoré.
3. Résoudre les thèmes par `(locale, slug)` et les médias par UUID. Les références fournies sur un draft ou une archive restent vérifiées. Ne créer aucun Theme ni MediaAsset implicitement.
4. Lire les deux tables pour les UUID du lot, les ensembles de thèmes existants et tous les propriétaires des slugs finaux concernés. Inclure drafts et archives.
5. Calculer l'état final projeté en remplaçant virtuellement les lignes du lot. Une collision n'existe que si deux lignes distinctes occuperaient le même `(type, locale, slug)` à la fin. Un slug libéré par une autre mise à jour du même lot peut être réutilisé, sous réserve d'une stratégie d'écriture compatible avec l'unicité immédiate.
6. Comparer les colonnes métier normalisées, l'instant complet de `published_at` et les ensembles de thèmes. Le résultat identique est `NOOP`, sans UPDATE, DELETE ou INSERT sur la ligne ou ses associations.

**CONFIRMED** — Aucune règle documentée n'autorise la suppression d'une ligne simplement parce que son fichier est absent du lot. L'archivage est une opération éditoriale explicite via le statut.

## 5. SQL, transactions et limites

### 5.1 Lectures essentielles

**PROPOSED —** Raisonner les requêtes SQL avant leur traduction Drizzle. Les sélections d'identité et de slug sont distinctes pour chaque table :

```sql
SELECT id, locale, slug, title, status, published_at, hook,
       observation, evocation, reflection, open_question, media_asset_id
FROM publications
WHERE id = ANY($1::uuid[]);

SELECT id, locale, slug, title, status, published_at,
       excerpt, content, cover_media_id
FROM reflections
WHERE id = ANY($1::uuid[]);

SELECT id, locale, slug
FROM publications
WHERE (locale, slug) IN (VALUES ($1, $2), ...);

SELECT publication_id, theme_id
FROM publication_themes
WHERE publication_id = ANY($1::uuid[]);
```

Même forme pour les propriétaires de slug et thèmes des Réflexions. Pour comparer `published_at`, une représentation UTC avec six décimales peut être obtenue explicitement en SQL, puis normalisée selon un contrat unique ; éviter toute conversion intermédiaire perdant les microsecondes. Les requêtes de slug doivent être paramétrées. En pratique, une construction Drizzle `inArray` ou une requête SQL paramétrée propre peut être choisie après examen du SQL généré.

### 5.2 Dry-run

**PROPOSED —** Exécuter toutes les lectures du plan sous `REPEATABLE READ READ ONLY`. Ce niveau donne une image stable pendant les lectures ; `READ ONLY` interdit les écritures transactionnelles. Le dry-run ne simule pas l'import par écriture puis rollback : cette méthode peut avoir des effets hors rollback et ne prouve pas l'absence de mutation. Le plan n'est valable qu'au regard du snapshot lu ; une modification concurrente après le dry-run peut changer le résultat de l'import réel.

### 5.3 Import réel

**PROPOSED —** Dans une transaction `SERIALIZABLE READ WRITE` : reconstruire le plan à partir des données courantes, revalider références, types, état final et règles de publication, puis refuser le lot entier si un `CONFLICT` subsiste. Appliquer uniquement CREATE/UPDATE, remplacer les associations déclaratives des lignes modifiées, définir `updated_at` explicitement sur UPDATE et laisser NOOP totalement intact. La transaction fait rollback complet sur toute erreur.

Un ordre stable des identités et des écritures réduit le risque de deadlock ; il ne le supprime pas. Sur SQLSTATE `40001`, rejouer **toute** la transaction avec un nombre d'essais borné et une attente courte. `40P01` peut justifier la même politique. `23505` signale une collision d'unicité et `23503` une FK invalide : reclasser ou replanifier selon la situation, sans retry aveugle. La suppression d'une référence protégée peut produire `23001`, déjà observé dans les tests du projet. Les assertions sur SQLSTATE doivent être fondées sur l'opération exacte. Le succès de l'import se déclare seulement après commit ; en cas de résultat de commit indéterminé, ne pas affirmer un échec certain.

**Limite :** `SERIALIZABLE` ne fournit pas à lui seul une contrainte physique d'unicité d'UUID entre deux tables pour des écrivains qui n'utilisent pas ce protocole. Les vérifications de l'autre table et les essais concurrents doivent être explicites. Le rôle SQL destiné à l'import devrait être le seul à modifier ces contenus dans le circuit éditorial V1 ; si une garantie universelle est exigée, un changement de schéma ou un protocole de verrouillage partagé devra être étudié séparément.

### 5.4 Échanges de slugs

**CONFIRMED** — L'unicité `(locale, slug)` actuelle est immédiate. Un `UPDATE` direct de A vers le slug de B échoue même si B doit ensuite prendre celui de A. `SET CONSTRAINTS DEFERRED` ne change rien aux contraintes non différables.

**PROPOSED — option sans migration :** pour les lignes réellement modifiées d'un même type, mettre temporairement à `NULL` les anciens slugs qui doivent être libérés, puis écrire les slugs finaux dans la même transaction. Le schéma autorise temporairement `NULL`, y compris pour `published`; les autres transactions ne voient pas cet état avant commit. Le plan doit avoir confirmé l'absence de collision finale. Ce procédé ajoute des écritures transitoires et doit être testé sur échange, cycle, création, rollback, concurrence et respect des NOOP. Ne pas l'employer pour contourner la règle des redirections de slug publié.

**PROPOSED — autre option :** rendre l'unicité différable via une migration Drizzle/SQL inspectable, puis différer son contrôle. Cela augmente le coût de migration et ne résout pas les redirections. Une troisième option, plus étroite, consiste à classer tout échange de slug `CONFLICT` jusqu'à un besoin démontré.

## 6. Problèmes bloquants et questions ouvertes

| Statut | Sujet | Options, risques et recommandation |
| --- | --- | --- |
| **BLOCKING** | Changement de slug déjà publié | La spécification exige une redirection permanente, absente du schéma. **Recommandation pour ce lot : `CONFLICT`** ; la conception d'un registre de redirections est une décision séparée à approuver. |
| **BLOCKING pour `published`** | Média réellement publiable | L'existence de l'UUID ne suffit pas. Arrêter les métadonnées, preuves de droits et disponibilité technique minimales avant de permettre la publication ; conserver l'import de drafts avec références existantes. |
| **OPEN** | Portée du dry-run | Aperçu informatif ou plan exact à approuver ? **Recommandation : aperçu informatif**, puis replanification transactionnelle à l'import. Le second choix exige un jeton d'état attendu et un refus sur divergence. |
| **OPEN** | Échanges de slugs non publiés | Phase temporaire `NULL`, migration vers contraintes différables, ou conflit explicite. **Recommandation : commencer par conflit explicite si l'échange n'est pas un cas d'usage immédiat** ; sinon prouver la solution `NULL` sur PostgreSQL avant adoption. |
| **OPEN** | Unicité d'UUID intertype pour tous les écrivains | Contrôle applicatif dans l'import, ou contrainte/protocole partagé. **Recommandation V1 : circuit d'écriture privé unique**, avec test de concurrence et limite documentée. Une garantie physique universelle demanderait une décision de schéma. |
| **OPEN** | Images dans le corps des Réflexions | Le contrat actuel les refuse tandis que la spécification décrit un mécanisme futur. Maintenir le refus pour D03 et clarifier le document de référence avant une évolution du contenu. |

Ces questions ne constituent pas l'ouverture de D07/D08. Les deux sujets **BLOCKING** exigent une réponse avant que l'import autorise sans risque tout cas de publication.

## 7. Matrice de tests et critères d'acceptation

| Niveau | Scénarios indispensables | Preuve attendue |
| --- | --- | --- |
| Unitaire : lot | UUID répété entre fichiers/types ; slugs répétés par type et locale ; diagnostics avec les deux chemins ; document invalide parmi plusieurs valides | Plan non applicable et diagnostics déterministes ; aucune mutation possible |
| Unitaire : comparaison | Thèmes réordonnés/dédupliqués ; même instant sous deux fuseaux ; chemin renommé ; timestamps techniques différents ; changement d'un seul champ | NOOP exact ou UPDATE avec diff exact ; aucun faux UPDATE dû aux métadonnées |
| PostgreSQL : projection | Collision contre draft/archive, slug libéré dans le même lot, UUID existant dans l'autre table, références absentes, date PostgreSQL avec microsecondes | CONFLICT ou opération attendue, sans faux NOOP temporel |
| PostgreSQL : dry-run | Lot CREATE/UPDATE/NOOP et lot conflictuel sous `READ ONLY` | Valeurs, associations, nombre de lignes et timestamps identiques avant/après ; aucune invocation du writer |
| PostgreSQL : import répété | CREATE, puis import du même lot deux fois | Identifiants, lignes, thèmes, `created_at` et `updated_at` inchangés au deuxième passage ; preuve d'absence de commandes de mutation sur NOOP |
| PostgreSQL : UPDATE | Modification réelle d'un champ, remplacement exact des thèmes, archivage explicite | Seules les valeurs déclarées changent ; `updated_at` avance ; absence de suppression pour fichiers omis |
| PostgreSQL : atomicité | Dernier fichier invalide ; FK supprimée ; unicité concurrente ; erreur en cours d'écriture | Rollback du lot complet, aucun contenu ni association partiellement importé |
| PostgreSQL : slugs | Échange/cycle si pris en charge ; conflit avec ligne inchangée ; rollback après phase `NULL` | Contrainte respectée à chaque étape et état final conforme ; NOOP non touchés |
| Concurrence | Deux imports du même UUID, UUID intertype, même slug, suppression de Theme/MediaAsset ; injection contrôlée de `40001`/`40P01` | Un résultat cohérent, retry borné de la transaction complète, diagnostics compréhensibles |
| Migration si nécessaire | Génération Drizzle, SQL inspecté, installation sur base temporaire, tests de contraintes | Schéma et migration synchronisés ; procédure `db:verify` adaptée au-delà de l'unique migration initiale |

**Critères d'acceptation du lot D03 :** tous les conflits sont identifiés avant la première mutation du lot ; un dry-run produit un plan sans écriture ; l'import revalide dans sa transaction ; un échec ne laisse aucune écriture partielle ; un second import identique ne modifie ni lignes, ni associations, ni timestamps ; les tests PostgreSQL démontrent les contraintes réelles et la concurrence ciblée ; les règles de publication et les limites restantes sont documentées. Les commandes de formatage, typage, tests pertinents et inspection des migrations sont exécutées et leurs résultats réels rapportés avant toute déclaration de fin.

## 8. Plan d'implémentation proposé pour Codex

| Ordre | Tâche et dépendance | Fichiers susceptibles d'être concernés | Condition de fin |
| --- | --- | --- | --- |
| 0 | Arbitrer les deux sujets bloquants ; aucune implémentation publiée avant cela | `docs/RESONANCES-V1-EDITORIAL-CONTRACT.md`, éventuellement spécification | Règles de slug publié et média publiable explicites et cohérentes |
| 1 | Définir snapshots, diagnostics, normalisation des instants et comparaison pure | `src/editorial/types.ts` ou petit module voisin ; `tests/editorial.test.ts` ou tests dédiés | Tests unitaires du NOOP, des diffs et des microsecondes |
| 2 | Ajouter lectures de snapshots, propriétaires de slug et ensembles de thèmes ; réutiliser le lecteur de références | `src/repositories/editorial-references.ts` et module repository ciblé | Lectures typées vérifiées sur PostgreSQL temporaire |
| 3 | Construire Batch Validation et ImportPlan par projection de l'état final | `src/editorial/` ou `src/services/`, tests dédiés | Conflits de lot et collisions finales prouvés ; fichiers absents sans effet |
| 4 | Encapsuler le dry-run sous `REPEATABLE READ READ ONLY` | service d'import privé, tests d'intégration | Plan lisible ; absence de mutation démontrée sur PostgreSQL |
| 5 | Ajouter l'import `SERIALIZABLE`, writer Drizzle, ordre déterministe, NOOP et retries bornés | service, `src/repositories/`, script privé sous `scripts/` si nécessaire | Atomicité, idempotence, erreurs SQL et concurrence prouvées |
| 6 | Synchroniser guide et vérification des migrations, si une migration existe | `README.md`, `docs/`, `scripts/verify-schema.ts`, `db/migrations/` uniquement si justifié | Documentation conforme ; formatage, typage et tests pertinents exécutés |

Garder les responsabilités Page/UI → Service → Repository → Drizzle → PostgreSQL ; n'ajouter ni API HTTP interne ni abstraction générique de contenu. Si une migration est finalement nécessaire, examiner le SQL généré et les effets sur les données existantes avant de l'appliquer. Les scripts actuels déclarent `npm run typecheck`, `npm run format:check`, `npm run test:editorial`, `npm test`, `npm run db:check` et `npm run db:verify`. `npm test` requiert `TEST_DATABASE_URL` vers une instance dédiée et crée une base temporaire ; il ne doit jamais être dirigé vers une base de production.

## 9. Verdict

**READY WITH CONDITIONS.** Les contrats de parsing/résolution, le schéma Drizzle et les décisions D01–D06 offrent une base suffisante pour découper D03 en tâches vérifiables. L'implémentation complète ne doit pas autoriser un changement de slug publié sans redirection, ni publier un média sur la seule preuve de son UUID. Une première tranche peut traiter ces cas comme conflits explicites, après validation de cette règle, puis implémenter le plan, le dry-run et l'import. La précision temporelle, l'échange de slugs et la concurrence demandent des tests PostgreSQL réels. Aucun résultat de ces tests futurs n'est présumé dans ce rapport.
