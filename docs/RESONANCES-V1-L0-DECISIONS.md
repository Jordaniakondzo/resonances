# Résonances V1 — Registre des décisions techniques L0

**Version :** 1.0 — 27 septembre 2026  
**Statut :** D01–D06 validées par Jordani.  
**Références :** [Spécification V1](RESONANCES-V1-SPECIFICATION.md) · [Transition vers l’implémentation](RESONANCES-V1-TRANSITION.md).

## Portée et autorité

Ce registre consigne les validations explicitement transmises par Jordani le 27 septembre 2026. Il remplace les hypothèses et arbitrages ouverts D01–D06 des documents du 15 septembre. Les alternatives ci-dessous retracent les options de conception ; elles ne constituent pas un benchmark réalisé.

D07 et les décisions suivantes restent ouvertes, avec leurs statuts antérieurs. Le cadrage L0 est suffisamment stabilisé pour préparer le schéma physique PostgreSQL/Drizzle et le plan d’implémentation détaillé. Cette validation n’implique ni schéma déjà implémenté, ni versions de dépendances arrêtées, ni infrastructure déployée.

| ID | Décision validée |
|---|---|
| D01 | Recherche simple en V1 ; Full Text Search et ranking avancé en V1.1 |
| D02 | Drizzle ORM + Drizzle Kit, PostgreSQL, code-first et migrations SQL versionnées |
| D03 | Markdown structuré + frontmatter dans Git ; import privé vers PostgreSQL |
| D04 | Foreign keys typées ; intégrité, exclusivité et relations dirigées |
| D05 | GalleryQuestion spécialisée, liée à une Reflection publiée |
| D06 | Playfair Display + Inter |

## D01 — Recherche V1

**Statut :** validée — 27 septembre 2026.

**Contexte.** La matrice des pages prévoyait la recherche dès V1, tandis que la roadmap évoquait une recherche en V1.x. Il fallait distinguer la fonction minimale de ses évolutions.

**Décision.** Inclure une recherche simple sur titre, accroche/résumé et thèmes. Les résultats comprennent Publication et Reflection. La recherche est insensible à la casse ; le comportement sur les accents est à tester et à documenter. Les entrées sont validées côté serveur. Aucune fuzzy search, aucun moteur externe, aucune recherche vectorielle ou sémantique en V1.

**Alternatives considérées.** Reporter toute recherche à V1.1 ; introduire immédiatement PostgreSQL Full Text Search ; employer un moteur externe ou une recherche sémantique.

**Justification.** Permettre de retrouver les deux types de contenus avec un périmètre limité, cohérent avec une première version éditoriale.

**Conséquences architecturales et pédagogiques.** Le service de recherche interroge les données publiques et retourne des résultats typés. Il partage les règles de visibilité des autres lectures. Les requêtes importantes sont raisonnées en SQL selon D02. Les tests couvrent corpus, casse, accents, validation et absence de résultats ; ils ne supposent pas une équivalence des accents avant vérification.

**Éléments différés.** PostgreSQL Full Text Search et ranking avancé : V1.1. Moteur externe, fuzzy search, recherche vectorielle et sémantique : hors V1, sans engagement d’ajout. La requête SQL exacte et les index seront précisés dans le schéma et le plan.

**Sections impactées.** Spécification §§3.1–3.4, 4.3, 11, 12 et AC05 ; transition §§2–4, 6 et 8.

## D02 — ORM et migrations

**Statut :** validée — 27 septembre 2026.

**Contexte.** PostgreSQL était retenu, mais le choix Prisma/Drizzle restait ouvert. Le projet doit développer une compréhension effective du modèle relationnel et du SQL.

**Décision.** Utiliser **Drizzle ORM + Drizzle Kit avec PostgreSQL**, en approche **code-first**. Les migrations SQL sont versionnées et inspectables. Règle pédagogique : raisonner les requêtes relationnelles importantes en SQL avant leur traduction en Drizzle.

**Alternatives considérées.** Prisma, précédemment utilisé comme hypothèse de démarrage ; Drizzle, plus proche de la démarche SQL souhaitée.

**Justification.** Garder une continuité entre conception relationnelle, SQL et code TypeScript, tout en disposant d’un outillage de schéma et de migrations.

**Conséquences architecturales et pédagogiques.** Les repositories utilisent Drizzle. Le schéma code-first et les migrations SQL font partie du dépôt. Les migrations sont relues, notamment pour les contraintes D04, puis vérifiées sur PostgreSQL. L’ORM ne remplace pas le raisonnement sur jointures, cardinalités, transactions et index. Aucun second ORM n’est introduit.

**Éléments différés.** Versions exactes, organisation détaillée du schéma, commandes et procédure d’application des migrations : à préciser au plan. La comparaison des ORM n’est plus un préalable.

**Sections impactées.** Spécification §§5.2, 5.4, 6, 12 et AC08 ; transition §§2–4, 6, 8 et 10.

## D03 — Circuit éditorial

**Statut :** validée — 27 septembre 2026.

**Contexte.** La V1 doit être alimentée par son auteur sans dépendre d’une interface d’administration ou d’un CMS.

**Décision.** Rédiger en **Markdown structuré + frontmatter**, versionné dans Git, puis effectuer un import privé vers PostgreSQL. L’import comprend validation, **dry-run**, transaction et idempotence. Aucun HTML arbitraire n’est accepté. PostgreSQL sert les lectures publiques. Aucun CMS ni interface d’administration en V1.

**Alternatives considérées.** CMS ; interface d’administration sur mesure ; fichiers de contenu utilisés directement pour les lectures publiques.

**Justification.** Fournir un circuit explicite et reproductible, avec historique éditorial, tout en conservant la base relationnelle comme source des lectures publiques.

**Conséquences architecturales et pédagogiques.** Séparer sources d’édition et données publiées. Le dry-run ne modifie pas la base ; un import invalide ne laisse pas d’écriture partielle ; un import répété ne duplique pas les contenus. Le frontmatter possède un contrat validé. L’import reste privé et le rendu n’exécute pas de HTML arbitraire. Ce circuit exerce la validation, les transactions, Git et la séparation lecture/écriture.

**Éléments différés.** Syntaxe exacte du frontmatter, bibliothèque de parsing/rendu, exemples complets et prévisualisation : à détailler au plan. CMS et administration sont exclus de V1 ; toute réintroduction ultérieure relève d’une nouvelle décision. D11 reste ouverte pour les évolutions et ses autres sujets.

**Sections impactées.** Spécification §§3.3, 5.4, 6.5, 10.3, 12 et AC07 ; transition §§2–5, 6, 8–10.

## D04 — Relations physiques

**Statut :** validée — 27 septembre 2026.

**Contexte.** Les couples génériques `type + id` ne suffisent pas à garantir par foreign key l’existence d’un contenu réparti entre Publication et Reflection.

**Décision.** Utiliser des foreign keys typées pour `ContentRelation` et `FeaturedContent`, avec contraintes d’intégrité et d’exclusivité. Pour `ContentRelation`, exactement une source et une cible parmi les références typées ; relations dirigées, ordre via `position`, auto-relations et doublons interdits. Pour `FeaturedContent`, exactement une cible typée Publication ou Reflection, ordonnée par `position` dans son emplacement. Aucune table générique `Content` en V1.

**Précision de portée.** La notion de source/cible décrit le lien entre contenus de `ContentRelation`. `FeaturedContent` représente une mise en avant dans un emplacement ; il ne reçoit pas une source de contenu artificielle. Les interdictions d’auto-relation concernent donc `ContentRelation`, et les règles d’unicité propres aux mises en avant seront formalisées dans le schéma.

**Alternatives considérées.** Références polymorphes `type + id` sans foreign keys typées ; table commune `Content` ; contrôles d’intégrité uniquement applicatifs.

**Justification.** Rendre les invariants contrôlables par PostgreSQL tout en conservant les deux modèles métier distincts.

**Conséquences architecturales et pédagogiques.** Prévoir des références Publication/Reflection exclusives pour chaque extrémité du lien. Une relation inverse n’est pas implicite. Les migrations SQL exposent les contraintes et les tests tentent des insertions invalides. Les foreign keys assurent l’existence ; la visibilité publique de la cible reste aussi une règle des services, car son statut peut changer.

**Éléments différés.** DDL exact, index d’unicité, politique de suppression et contraintes de programmation des unes : conception physique. La définition précise des doublons doit être explicitée dans le schéma sans affaiblir leur interdiction. Table générique `Content` exclue de V1.

**Sections impactées.** Spécification §§4.4, 6.1, 6.3, 12 et AC06/AC08 ; transition §§3–6 et 8.

## D05 — Flux éditorial et GalleryQuestion

**Statut :** validée — 27 septembre 2026.

**Contexte.** La persistance des cartes-question était proposée sous l’abstraction générique `EditorialInsertion`. La V1 n’a besoin que d’un type spécialisé de question dans la Galerie.

**Décision.** Remplacer cette abstraction par **`GalleryQuestion`**. Champs principaux : `id`, `question`, `reflection_id`, `after_publication_count`, `status` et dates. La cible est une Reflection publiée. La question ne compte pas dans la pagination des publications ; elle est insérée de manière déterministe et ne se répète pas à chaque lot. Ses thèmes sont dérivés de la Reflection cible.

**Alternatives considérées.** `EditorialInsertion` générique avec types et thèmes propres ; cartes-question codées directement dans les pages.

**Justification.** Modéliser le besoin réel de V1, avec une destination claire, et éviter une abstraction extensible sans cas d’usage immédiat.

**Conséquences architecturales et pédagogiques.** `QuestionCard` reste le composant de présentation ; `GalleryQuestion` est l’entité persistée. Le service compose le flux selon le nombre de publications, indépendamment des cartes insérées. Il vérifie la publication de la cible à la lecture. Aucun ensemble de thèmes distinct n’est stocké pour la question. Tester les frontières de lots, les filtres et le retrait d’une Reflection.

**Éléments différés.** Noms et sémantique précis des dates, départage de positions identiques et calcul du compteur dans une liste filtrée : à formaliser au plan, en préservant déterminisme et absence de répétition. Un système générique d’insertions reste hors V1.

**Sections impactées.** Spécification §§4.2–4.3, 6.1, 6.4, 8, 12 et AC04/AC06 ; transition §§3–4, 6 et 8.

## D06 — Typographie

**Statut :** validée — 27 septembre 2026.

**Contexte.** La direction serif éditoriale + sans-serif était validée ; le choix entre Playfair Display et Cormorant Garamond restait ouvert.

**Décision.** **Playfair Display** pour les titres et l’expression éditoriale ; **Inter** pour le corps, la navigation et l’interface. Limiter les graisses, utiliser des tailles fluides, prévoir des fallbacks et vérifier la couverture du français. Cormorant Garamond n’est pas retenue en V1.

**Alternatives considérées.** Cormorant Garamond pour la famille éditoriale.

**Justification.** Stabiliser l’identité visuelle et la lisibilité, sans multiplier les familles ni les fichiers chargés.

**Conséquences architecturales et pédagogiques.** Centraliser les familles, tailles et graisses dans les tokens ; appliquer les rôles typographiques de façon cohérente. Vérifier accents, ligatures françaises pertinentes, textes longs, fallback et comportement responsive. Relier les choix CSS à la hiérarchie de lecture et au coût de chargement.

**Éléments différés.** Graisses exactes, stratégie de chargement et valeurs finales des fallbacks : réalisation du design system. Aucun nouvel arbitrage sur la famille éditoriale n’est requis.

**Sections impactées.** Spécification §§7.2, 8, 9, 12 et AC09/AC11 ; transition §§2–4 et 8.

## Suite du cadrage

Le prochain travail consiste à traduire ces décisions en schéma PostgreSQL/Drizzle, contrats de contenu et tâches d’implémentation. Les détails restant à concevoir ci-dessus sont des modalités de réalisation, pas une réouverture de D01–D06. D07–D11 conservent leur statut ouvert dans la spécification.
