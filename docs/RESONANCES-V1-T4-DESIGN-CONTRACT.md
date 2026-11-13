# Résonances V1 — T4 : Contrat de conception et plan d'exécution

**Identifiant :** T4-DESIGN-01
**Version :** 1.0
**Date :** 14 novembre 2026
**Statut :** APPROVED — Cadrage validé ; vérification technique préalable à l'implémentation
**Responsable des décisions :** propriétaire du projet Résonances

## 1. Objet et autorité

Ce document définit le périmètre, les décisions architecturales, les contraintes, les risques, les critères d'acceptation et le plan d'exécution de T4.

Il constitue le contrat d'entrée de la tranche T4 et doit être lu par tout agent intervenant sur cette tranche avant de proposer ou d'effectuer des modifications.

Il complète sans les remplacer :

- `AGENTS.md`
- `docs/RESONANCES-V1-SPECIFICATION.md`
- `docs/RESONANCES-V1-L0-DECISIONS.md`
- `docs/RESONANCES-V1-EDITORIAL-CONTRACT.md`
- `docs/RESONANCES-V1-TRANSITION.md`
- Les contrats d'import D03, la politique des écrivains SQL et les documents pertinents de T2 et T3.

Les décisions L0 D01–D06 restent en vigueur. Les décisions encore ouvertes dans la spécification ne sont pas implicitement tranchées ici.

En cas de divergence entre ce contrat, la documentation validée et le code existant, l'agent doit signaler l'écart avant toute implémentation. Il ne peut pas le résoudre silencieusement.

## 2. Baseline de référence

État déclaré au lancement de T4 :

- Dépôt : `https://github.com/Jordaniakondzo/resonances`
- Branche de référence : `main`
- Commit de référence : `c36ec96be97958341341393deb26f756a1593047`
- T1 : bootstrap Web terminé.
- T2 : lecture publique des Publications terminée.
- T2 : lecture publique des Reflections non réalisée et hors périmètre T4.
- T3 : dataset éditorial synthétique terminé.
- Dernier bilan PostgreSQL communiqué : 430 tests réussis, 0 échec, 1 test ignoré.
- Gestion des connexions PostgreSQL stabilisée et SCRAM ciblé activé localement.
- Un worktree et une branche locale `main`.
- Un stash automatique GitHub Desktop demeure présent et ne doit pas être modifié.

Ces éléments constituent une baseline déclarée. Leur vérification technique relève de l'inspection préalable. Aucun résultat de test historique ne doit être présenté comme une preuve nouvelle de T4.

Les données T3 sont des fixtures de développement et non du contenu éditorial approuvé.

## 3. Objectif T4

Construire une première expérience de consultation publique des Publications en reliant le socle Web T1 aux services de lecture publique T2.

T4 doit démontrer le parcours suivant :

**PostgreSQL → Repository public T2 → Service public T2 → Page Galerie → Carte Publication → Page de détail.**

Cette tranche doit vérifier que la présentation respecte les garanties de visibilité, d'intégrité, de sécurité et d'accessibilité déjà définies.

T4 n'est pas la réalisation de l'ensemble du site V1.

## 4. Périmètre fonctionnel

### 4.1 Inclus

- Route `/galerie`.
- Route `/galerie/[slug]`.
- Liste ordonnée des Publications publiques.
- Composants de carte et de présentation nécessaires à ces routes.
- Affichage du titre, du média, de l'accroche et des thèmes selon les données publiques disponibles.
- Affichage intégral des quatre sections éditoriales d'une Publication.
- Navigation entre Galerie et détail.
- États vides, erreurs et 404.
- Adaptation responsive et accessibilité.
- Vérification du comportement de visibilité et de retrait.
- Tests automatisés et revue indépendante.

La Galerie T4 peut rester volontairement minimale.

### 4.2 Exclus ou différés

- Lecture publique et pages des Reflections.
- GalleryQuestion.
- Recherche simple et recherche avancée.
- Pagination interactive et chargement progressif.
- Filtres thématiques interactifs.
- Mise en avant éditoriale persistée.
- Relations éditoriales intertypes et contenus associés.
- CMS ou interface d'administration.
- Comptes, commentaires et autres fonctionnalités communautaires.
- Sélection définitive du fournisseur de stockage média.
- Modification du circuit d'import D03.
- Migration SQL ou modification de permissions non justifiée par une décision supplémentaire.

Ces exclusions concernent T4, sans modifier les engagements de la V1.

## 5. Décisions validées

### T4-D01 — Périmètre minimal

**Statut : VALIDATED**

T4 se limite à la Galerie minimale et à la page individuelle de Publication.

Les fonctionnalités d'exploration avancée feront l'objet de tranches distinctes.

### T4-D02 — CommonMark restreint

**Statut : VALIDATED**

Le rendu éditorial utilise un sous-ensemble contrôlé de CommonMark.

Contraintes :

- Aucun HTML arbitraire provenant du contenu.
- Aucun MDX.
- Aucune exécution de code éditorial.
- Aucun comportement qui transforme du texte échappé en HTML actif.
- Traitement sécurisé des liens et de leurs destinations.
- Respect des quatre sections éditoriales.
- Compatibilité avec les exigences du contrat Markdown existant.

La bibliothèque et les modalités techniques exactes restent à déterminer après inspection.

### T4-D03 — Fixtures médias contrôlées

**Statut : VALIDATED**

Les tests de présentation utilisent des médias synthétiques ou des fixtures contrôlées.

Ils ne constituent pas une autorisation de diffusion éditoriale.

Les références médias doivent permettre de tester dimensions, alternatives textuelles, disponibilité et erreurs de chargement.

Aucun fournisseur de stockage définitif n'est choisi dans T4.

### T4-D04 — Rendu serveur conservateur

**Statut : VALIDATED**

La lecture des données et l'application des règles de visibilité restent côté serveur.

Le rendu initial privilégie la fraîcheur des contenus publics et la réduction des risques de cache incohérent.

Aucun cache éditorial applicatif persistant ne doit être introduit sans contrat d'invalidation approuvé.

Le comportement réel du framework, des réponses HTTP et des caches éventuels doit être vérifié. La décision ne constitue pas une garantie universelle d'absence de cache.

### T4-D05 — Revue CRITICAL

**Statut : VALIDATED**

L'ensemble de T4 est soumis à une revue indépendante de niveau CRITICAL.

Claude Code intervient comme implémenteur après mandat explicite.

Codex intervient comme réviseur indépendant.

La revue vérifie les exigences, le diff, les frontières de sécurité, les tests et les preuves effectives.

Tous les constats BLOCKING doivent être résolus avant intégration.

## 6. Architecture cible

Architecture logique :

```text
Next.js App Router
        |
        v
Services publics T2
        |
        v
Repositories publics T2
        |
        v
Interface SQL publique autorisée
        |
        v
PostgreSQL
```

Principes :

1. Réutiliser les services T2 au lieu de dupliquer les requêtes.
2. Conserver les règles de visibilité côté serveur.
3. Ne pas exposer l'importeur D03 aux composants publics.
4. Ne pas introduire d'API HTTP interne sans nécessité démontrée.
5. Maintenir la séparation serveur/client existante.
6. Conserver Drizzle et PostgreSQL.
7. Ne pas ajouter de dépendance sans justification.
8. Réserver les modifications des contrats T2 à une décision explicite lorsqu'elles changent leurs garanties.

Les signatures, fichiers et interfaces exacts doivent être déterminés par inspection du commit de référence.

## 7. Contrats de comportement

### 7.1 Galerie

La Galerie affiche uniquement des Publications visibles selon le contrat public T2.

L'ordre doit être déterministe.

Les cartes ne doivent pas révéler de contenu non public.

Les liens doivent mener à des destinations existantes et autorisées.

Le comportement en absence de résultat doit être explicite.

### 7.2 Détail

La route identifie la Publication par son slug et par la locale française ciblée en V1.

Un slug inconnu, un brouillon, une archive ou un contenu à date future ne doit pas produire de page publique contenant ses informations éditoriales.

Le détail présente les sections et métadonnées prévues par le contrat éditorial.

### 7.3 Médias

Les médias affichés doivent disposer de références exploitables et d'alternatives textuelles appropriées.

Une référence en base ne constitue ni une preuve de disponibilité du fichier ni une autorisation juridique.

Les indisponibilités doivent être gérées sans faire échouer inutilement toute l'interface.

### 7.4 Visibilité et retrait

Les critères de visibilité T2 doivent être conservés.

La stratégie de rendu doit permettre de constater le retrait effectif d'un contenu lors des tests prévus.

Les règles de cache ne doivent pas contourner les contrôles de visibilité.

## 8. Réserves techniques ouvertes

**R1 — Intégration des services T2**

Vérifier les interfaces existantes, les contraintes d'import et les tests de frontière Web.

**R2 — Renderer Markdown**

Déterminer les éléments admis, leur mapping HTML, la validation des liens, l'échappement et les tests adverses.

**R3 — Médias de test**

Vérifier la disponibilité réelle des médias et des métadonnées des fixtures T3 pour les tests de rendu.

**R4 — Cache et retrait**

Définir la configuration précise du rendu serveur et les preuves de fraîcheur et de retrait.

**R5 — Compatibilité avec le commit de référence**

Vérifier les services, types, fichiers, tests et comportements présents dans l'implémentation actuelle.

Aucune réserve ne doit être transformée automatiquement en modification du périmètre.

Toute incompatibilité nécessitant une nouvelle décision est soumise au responsable du projet.

## 9. Critères d'acceptation

| ID | Critère |
|---|---|
| T4-AC01 | La Galerie affiche uniquement les Publications publiques dans un ordre déterministe. |
| T4-AC02 | Les cartes ouvrent les routes de détail correspondantes. |
| T4-AC03 | Le détail restitue les éléments éditoriaux complets prévus par son contrat. |
| T4-AC04 | Brouillons, archives, dates futures, slugs inconnus et locales non ciblées ne sont pas exposés. |
| T4-AC05 | Le rendu Markdown reste inerte face aux entrées non autorisées. |
| T4-AC06 | La frontière serveur/client et les privilèges publics sont préservés. |
| T4-AC07 | Les états vides, erreurs et 404 sont utilisables et accessibles. |
| T4-AC08 | L'interface est vérifiée à 320, 390, 768, 1024 et 1440 px. |
| T4-AC09 | Le retrait de contenu est vérifié selon la stratégie de cache approuvée. |
| T4-AC10 | Les vérifications techniques pertinentes réussissent et leurs preuves sont documentées. |

Ces critères définissent la recette propre à T4 et ne remplacent pas les critères AC01–AC14 de la spécification globale.

## 10. Plan d'exécution

### T4-P0 — Cadrage

**Statut : VALIDATED**

Formalisation des cinq décisions T4 et des limites de périmètre.

### T4-P1 — Inspection technique

**Statut : PENDING**

Inspection en lecture seule du dépôt de référence, des services T2, des frontières Web, des fixtures T3 et des tests.

Livrable : rapport de compatibilité avec faits observés, écarts, recommandations et preuves.

### T4-P2 — Conception détaillée

**Statut : PENDING**

Résolution de R1–R5, choix des modalités techniques et définition des interfaces nécessaires.

Livrable : conception détaillée approuvée avant implémentation.

### T4-P3 — Implémentation

**Statut : NOT AUTHORIZED**

Implémentation incrémentale par Claude Code, dans les limites d'un mandat distinct.

### T4-P4 — Vérification

**Statut : NOT STARTED**

Tests pertinents sur les données, les pages, le rendu, l'accessibilité, les erreurs et les frontières techniques.

### T4-P5 — Revue indépendante

**Statut : NOT STARTED**

Revue CRITICAL par Codex. Classement des constats conformément à `AGENTS.md`.

### T4-P6 — Arbitrage et clôture

**Statut : NOT STARTED**

Résolution des constats bloquants, vérification finale, documentation du résultat et autorisations Git distinctes.

## 11. Règles de travail des agents

Avant tout travail sur T4, l'agent doit lire ce contrat, `AGENTS.md` et les documents techniques pertinents.

Les modes Architecture consultant, Implementer et Reviewer ne doivent pas être confondus.

Claude Code n'est pas autorisé à modifier le code simplement parce que ce document existe.

Toute opération Git modifiant l'état du dépôt, toute implémentation et toute modification architecturale requièrent une autorisation conforme aux règles du projet.

Le dossier `sources/` reste strictement en lecture seule.

Les commentaires dans le code et les scripts sont rédigés en anglais. La documentation peut rester en français.

L'agent doit préserver les modifications préexistantes, documenter les écarts et rapporter uniquement les contrôles réellement exécutés.

## 12. Condition de passage à l'implémentation

L'implémentation T4 ne peut être engagée que lorsque :

1. Le contrat de cadrage est disponible dans la documentation de référence du projet.
2. Le rapport d'inspection T4-P1 est examiné.
3. Les réserves bloquantes R1–R5 sont résolues ou explicitement arbitrées.
4. Les contrats de présentation et les tests attendus sont suffisamment précis.
5. Un mandat d'implémentation distinct est approuvé.

**Conclusion contractuelle :** T4 est cadré et validé au niveau du périmètre. Sa faisabilité technique détaillée doit encore être confrontée au code réel. Aucune implémentation n'est autorisée par le seul présent contrat.
