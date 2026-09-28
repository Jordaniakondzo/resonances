# AGENTS.md — Résonances

## 1. Project purpose

Résonances is an editorial and visual web project centered on representations
of love through expressive images, interpretation, reflection, and open
questions.

The current target is **Résonances V1**, a public French-language editorial
website.

The V1 is intentionally **not a social network**.

Core editorial flow:

> Voir → Ressentir → Comprendre → Questionner

Community interaction ("Échanger") belongs to later phases.

The project is also a learning project. Technical choices and implementations
must remain understandable, explainable, and reproducible by the project owner.

---

## 2. Source of truth

Before making architectural, product, data-model, design-system, or scope
decisions, read the relevant documentation under `docs/`.

The maintained project documentation is authoritative for validated product
intent, architecture, scope, and decisions.

The Git repository is authoritative for the current implementation state.

Neither silently overrides the other. If documentation and implementation
diverge:

1. identify the inconsistency;
2. explain it before implementation;
3. determine whether the code or the documented decision is stale;
4. propose the smallest coherent correction;
5. update the relevant documentation if a validated decision changes.

Important documents may include:

- Résonances V1 specification
- L0 decision register
- transition / implementation planning documents
- architecture notes
- ADRs or technical decisions

Do not silently contradict an existing validated decision.

If a new requirement conflicts with the documentation:

1. identify the conflict;
2. explain it before implementation;
3. propose the smallest coherent change;
4. update the relevant documentation if the change is approved.

Do not duplicate the complete specification inside this file.

---

## 3. Directory rules

### `sources/`

Treat every file under `sources/` as **read-only reference material**.

Do not:

- edit;
- rename;
- move;
- delete;
- reformat;
- overwrite

files under `sources/`.

These files may be synchronized or replaced by the ChatGPT project.

### `docs/`

`docs/` contains the maintained project documentation.

Files here may be updated when a validated decision, architecture, plan,
workflow, or implementation detail changes.

Documentation changes must remain consistent with the current project scope.

### Application source

Application source code will live outside `sources/` and should follow the
architecture defined in the project documentation.

Do not introduce a new top-level structure without a concrete reason.

---

## 4. Current V1 scope

Résonances V1 includes:

- Home;
- Gallery;
- individual Gallery publications;
- Reflections;
- individual Reflection articles;
- About;
- thematic navigation;
- featured editorial content;
- related content;
- simple search;
- responsive design;
- accessibility;
- SEO foundations;
- optimized media delivery.

V1 explicitly excludes:

- reader accounts;
- profiles;
- likes;
- comments;
- followers;
- chat;
- notifications;
- public contributions;
- community feeds;
- personalized recommendations;
- semantic/vector search;
- AI recommendation systems;
- public multilingual UI;
- mandatory CMS.

Do not implement post-V1 features unless the user explicitly changes scope.

---

## 5. Validated technical direction

Current validated direction:

- Next.js with App Router
- React
- TypeScript
- CSS Modules
- PostgreSQL
- Drizzle ORM
- Drizzle Kit
- object storage for media
- Git + GitHub
- modular monolith architecture

Do not replace these technologies merely because another tool or framework is
more familiar.

Any proposed replacement must first explain:

- the concrete problem;
- expected benefit;
- migration cost;
- impact on learning goals;
- impact on the existing specification.

---

## 6. Architecture principles

Use the following logical flow where appropriate:

```text
Page / UI
    ↓
Service / use case
    ↓
Repository
    ↓
Drizzle
    ↓
PostgreSQL
```

Rules:

- React components must not contain ad-hoc SQL queries.
- Database visibility rules belong on the server.
- Business rules must not depend on presentation components.
- Avoid unnecessary generic abstractions.
- Prefer small modules with clear responsibilities.
- Do not introduce microservices for V1.
- Do not create an internal HTTP API when server-side code can call the
  service layer directly.
- Route Handlers should only exist when an HTTP boundary is actually needed.

---

## 7. SQL and Drizzle rule

Résonances is also a SQL learning project.

For significant relational queries:

1. reason about the SQL first;
2. understand joins, constraints, indexes, and expected result shape;
3. implement the equivalent with Drizzle;
4. inspect generated SQL or migrations when useful.

Drizzle must not become a substitute for understanding PostgreSQL.

Prefer database-enforced integrity whenever practical:

- primary keys;
- foreign keys;
- unique constraints;
- check constraints;
- appropriate indexes;
- transactions.

---

## 8. Validated L0 decisions

### D01 — Search

Simple search is included in V1.

Search covers:

- publication title;
- publication hook;
- reflection title;
- reflection excerpt;
- themes.

V1 does not include:

- fuzzy matching;
- semantic search;
- embeddings;
- vector search;
- external search engines;
- advanced ranking.

PostgreSQL full-text search enhancements belong to V1.1 unless explicitly
brought forward.

### D02 — ORM

Use **Drizzle ORM + Drizzle Kit** with PostgreSQL.

Use code-first schema definition with versioned, inspectable SQL migrations.

### D03 — Editorial workflow

Editorial source files use structured Markdown/frontmatter stored in Git.

Flow:

```text
Markdown source
    ↓
validation
    ↓
dry-run
    ↓
private transactional import
    ↓
PostgreSQL
    ↓
public application
```

Requirements:

- validation before import;
- dry-run support;
- transactional writes;
- idempotent imports;
- no arbitrary executable HTML;
- no public administration interface in V1.

PostgreSQL is the public runtime data source.

### D04 — Typed content relations

Do not use unconstrained `type + id` polymorphic references.

Use typed foreign keys for relationships involving Publication and Reflection.

Database rules must enforce:

- exactly one source;
- exactly one target;
- valid foreign keys;
- no self-relation;
- no logical duplicates;
- explicit ordering where needed.

Relations are directed.

Do not add a generic `Content` table in V1.

### D05 — Gallery questions

Use the specialized V1 entity `GalleryQuestion`.

Do not introduce a generic `EditorialInsertion` abstraction yet.

A GalleryQuestion:

- targets a published Reflection;
- has deterministic placement;
- does not count toward publication pagination;
- must not repeat automatically in every loaded batch;
- derives themes from its target Reflection.

### D06 — Typography

Use:

- **Playfair Display** for editorial headings and expressive typography;
- **Inter** for body text, navigation, metadata, and interface.

Use only the font weights actually needed.

---

## 9. Editorial model

Gallery publications follow the editorial structure:

```text
Image
→ Title
→ Hook
→ Observation
→ Evocation
→ Reflection
→ Open question
→ Themes
```

Important distinction:

- **Observation** describes what is visible.
- **Evocation / interpretation** must remain explicitly interpretive.

Do not present subjective interpretation as an objective fact.

The project explores positive, difficult, ambiguous, and potentially harmful
dimensions of love.

Do not automatically romanticize:

- possessiveness;
- manipulation;
- domination;
- unhealthy dependency;
- disrespect.

---

## 10. Data-model principles

Publication and Reflection remain separate domain models.

Expected core concepts include:

- Publication
- Reflection
- Theme
- PublicationTheme
- ReflectionTheme
- MediaAsset
- ContentRelation
- FeaturedContent
- GalleryQuestion

Media files must not be stored directly in PostgreSQL.

PostgreSQL stores metadata and references to media assets.

Do not create future community tables merely "for later".

Future migrations are acceptable.

---

## 11. UI and design-system principles

Visual direction:

> editorial minimalism + cinematic imagery + warmth + generous space

Avoid:

- generic social-network aesthetics;
- excessive romantic decoration;
- heavy shadows;
- unnecessary animation;
- emotion-specific color coding for themes.

Use the validated design system and tokens from project documentation.

Core component philosophy:

```text
design tokens
    ↓
primitives
    ↓
components
    ↓
patterns
    ↓
pages
```

Prefer composable components over page-specific duplication.

---

## 12. Responsive and accessibility requirements

Design mobile-first.

Essential information must never depend exclusively on hover.

Accessibility target: WCAG 2.2 AA where applicable.

At minimum:

- semantic HTML;
- keyboard navigation;
- visible focus;
- correct heading hierarchy;
- meaningful `alt` text;
- empty alt for decorative images;
- sufficient contrast;
- usable touch targets;
- `prefers-reduced-motion`;
- appropriate page language;
- useful error and empty states.

Image alt text describes the visual content, not its philosophical
interpretation.

---

## 13. Media rules

Preserve original source assets separately.

Preferred public delivery:

- WebP for photographic content;
- SVG for vector interface assets;
- PNG only when justified;
- responsive image variants;
- no automatic delivery of full-size originals.

Record media provenance:

- author;
- source;
- license;
- dimensions;
- alt text;
- relevant metadata.

Do not publish an image merely because it can be downloaded from the web.

---

## 14. Implementation workflow

Do not begin large implementation work by coding every page independently.

Prefer vertical slices.

The first important vertical slice should prove:

```text
editorial source
    ↓
validation/import
    ↓
PostgreSQL
    ↓
repository
    ↓
service
    ↓
Gallery card
    ↓
publication page
    ↓
related content
    ↓
content withdrawal
```

A feature is not complete only because it renders visually.

It must respect:

- visibility rules;
- data integrity;
- accessibility;
- error states;
- tests;
- documentation when required.

---

## 15. Testing strategy

Use the smallest useful test level.

Prefer:

- unit tests for meaningful domain logic;
- PostgreSQL integration tests for constraints and repositories;
- integration tests for import workflows;
- browser tests for critical user journeys;
- manual visual review for editorial rhythm and image crops;
- accessibility review beyond automated tooling.

Important scenarios include:

- drafts never appear publicly;
- archived content disappears;
- future-dated content remains private;
- pagination contains no duplicates;
- related content never exposes unpublished entries;
- imports rollback completely on invalid input;
- foreign-key and check constraints are tested against real PostgreSQL.

Do not mock PostgreSQL when the purpose of the test is to verify PostgreSQL
behavior.

---

## 16. Performance and SEO

Public editorial pages should favor server rendering or generation strategies
appropriate to Next.js.

Do not convert pages to client components without a real need.

Keep client-side JavaScript limited to actual interactions.

Images must:

- reserve layout dimensions;
- use appropriate responsive sizes;
- avoid unnecessary original-size downloads;
- avoid lazy-loading the main above-the-fold image.

Public content should have appropriate:

- title;
- description;
- canonical URL;
- social metadata;
- sitemap inclusion.

Drafts and non-public content must never rely on `noindex` as an access-control
mechanism.

---

## 17. Change discipline

Before making a significant architectural change:

1. inspect the current documentation and implementation;
2. state the assumption being changed;
3. explain why the current approach is insufficient;
4. propose the smallest coherent alternative;
5. identify affected files and decisions;
6. obtain approval when the change alters validated project direction.

Do not refactor unrelated code during a focused task.

Do not introduce dependencies without explaining what concrete problem they
solve.

Prefer YAGNI over speculative extensibility.

---

## 18. Learning requirement

### Code comment language

All comments in project code and scripts must be written in English, including
SQL comments and documentation comments. Translate existing non-English comments
when updating them. This project-specific rule overrides earlier preferences
for Russian code comments. User-facing content and project documentation may
remain in French.


The project owner must be able to understand and explain the implementation.

When implementing non-trivial code:

- favor clear names;
- keep responsibilities explicit;
- explain unusual decisions in comments or documentation when useful;
- avoid clever abstractions that hide fundamental concepts;
- preserve opportunities to understand SQL, HTTP, React, Next.js, TypeScript,
  CSS, testing, and architecture.

A solution that works but cannot be reasonably explained is not the desired
outcome for this project.

---

## 19. Definition of done

Before claiming a task is complete:

- run the relevant formatter/linter;
- run type checking;
- run relevant tests;
- verify expected behavior;
- verify no validated scope rule was violated;
- inspect migrations when database changes are involved;
- update documentation when a documented decision or workflow changed.

Report what was actually verified.

Do not claim success based only on code inspection.

---

## 20. Working style for coding agents

Coding agents may act in one of three explicit modes:

1. **Implementer**
2. **Reviewer**
3. **Architecture consultant**

Do not silently switch roles during a task.

### 20.1 Before acting

Before implementation or review:

1. read `AGENTS.md`;
2. inspect the relevant documentation under `docs/`;
3. inspect the current implementation;
4. inspect the current Git branch and working tree;
5. identify pre-existing changes that were not created by you;
6. identify the smallest coherent task boundary;
7. preserve validated decisions.

Never discard, overwrite, or rewrite unrelated existing work.

If documentation and implementation appear inconsistent, report the
inconsistency rather than silently choosing one.

When uncertain whether something belongs to V1, default to **not adding it**
and consult the project specification.

### 20.2 Implementer mode

When acting as the implementer:

- work only within the agreed task boundary;
- do not expand scope merely because adjacent improvements are convenient;
- implement incrementally;
- keep responsibilities explicit;
- add or update tests that prove the intended behavior;
- run the relevant verification commands;
- keep documentation synchronized when a documented behavior or decision changes;
- clearly report deviations from the requested design.

For substantial changes, explain the intended approach before making large
structural modifications.

Do not introduce a new architectural decision implicitly.

If an adjacent issue is discovered:

- fix it only if it is required for correctness and remains within scope;
- report it instead of expanding the task when it is merely convenient;
- escalate it when it requires a new architectural or product decision.

### 20.3 Reviewer mode

When acting as a reviewer, default to **read-only review**.

Do not modify the reviewed branch unless explicitly asked to move from reviewer
mode to implementer mode.

Review the change against:

- validated requirements and decisions;
- actual implementation behavior;
- database integrity where applicable;
- tests and what they genuinely prove;
- scope discipline;
- maintainability and unnecessary abstraction;
- security, accessibility, and performance when relevant.

Classify findings as:

- **BLOCKING** — correctness, integrity, security, specification, or migration
  issue that must be resolved before merge;
- **IMPORTANT** — material issue that should normally be addressed;
- **SUGGESTION** — optional improvement;
- **QUESTION** — ambiguity or trade-off requiring project arbitration.

Do not request changes solely because you prefer another style, abstraction,
library, framework, or technology.

A passing test suite is evidence, not proof of every claimed property. Inspect
whether important tests actually verify the behavior their names and reports
claim.

### 20.4 Architecture consultant mode

For unresolved architectural decisions, an agent may be asked to analyze and
propose alternatives without implementing them.

In this mode:

- inspect current constraints and validated decisions;
- identify assumptions;
- compare concrete trade-offs;
- identify migration and learning costs;
- recommend the smallest coherent option;
- do not modify implementation unless explicitly requested.

Independent proposals from multiple agents may be compared before a decision is
approved.

### 20.5 Handoff report

After substantial implementation work, provide a concise handoff containing:

- implementation summary;
- files changed;
- important technical decisions;
- tests and verification commands actually executed;
- known limitations;
- unresolved questions;
- documentation or migration changes;
- recommended next step.

Report only verification that was actually performed.

---

## 21. Git and multi-agent collaboration

Résonances may be developed with multiple coding agents and human contributors.

The purpose of multi-agent collaboration is independent implementation and
review, not duplicated uncontrolled work.

### 21.1 Sources of truth

Validated project intent, architecture, scope, and decisions are defined by the
maintained documentation and decision records.

The Git repository represents the current implementation state.

Neither silently overrides the other.

If implementation and validated documentation diverge, identify the divergence
and resolve it through project arbitration before treating the discrepancy as a
new decision.

### 21.2 Branch discipline

For substantial work:

- do not use `main` as a shared scratch branch;
- use a dedicated task branch;
- keep a branch focused on one primary objective;
- avoid unrelated refactors;
- do not rewrite shared history unless explicitly authorized.

Before changing files, inspect the current branch and working tree.

Do not discard or overwrite pre-existing changes created by another contributor.

### 21.3 Concurrent work

Two coding agents should not independently edit overlapping parts of the same
task unless parallel work has been explicitly planned.

Parallel implementation is appropriate only when task boundaries are genuinely
independent.

When overlap is unavoidable, coordinate through explicit branches, task
ownership, and review rather than competing edits.

### 21.4 Implementer and reviewer rotation

Work, Claude Code, or other coding agents may alternate roles between tasks.

A typical workflow is:

```text
Project framing and acceptance criteria
    ↓
Implementer
    ↓
task branch
    ↓
tests and verification
    ↓
independent reviewer
    ↓
project arbitration
    ↓
corrections if required
    ↓
final verification
    ↓
merge
```

The same agent should not be treated as the sole authority for both its
implementation and its validation.

For significant changes, prefer independent review when practical.

### 21.5 Disagreements and arbitration

Agent recommendations are not project decisions by themselves.

Never justify a change only because another agent recommended it.

When agents disagree:

1. identify the exact technical disagreement;
2. compare both positions against validated documentation;
3. inspect concrete code, SQL, tests, or runtime evidence;
4. distinguish correctness issues from preferences;
5. escalate unresolved architectural trade-offs for project arbitration.

Do not silently resolve a genuine product or architectural disagreement by
modifying the code.

### 21.6 Merge discipline

Before merge:

- blocking review findings must be resolved or explicitly accepted;
- relevant tests and checks must pass;
- migration changes must be inspected when applicable;
- documentation must match any newly approved behavior or decision;
- unrelated working-tree changes must not be included accidentally.

A merge is the integration of an approved change, not the moment at which the
architecture is decided.
