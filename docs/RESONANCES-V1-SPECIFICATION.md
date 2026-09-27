# Résonances V1 — Spécification de référence

**Version documentaire :** 1.2 — 27 septembre 2026  
**Responsable produit et éditorial :** Jordani  
**Statut :** consolidation des décisions validées ; compléments de conception explicitement identifiés.  
**Source :** Cadrage initial du projet ; décisions consolidées dans cette spécification et le registre L0.  
**Document associé :** [Transition vers l’implémentation](RESONANCES-V1-TRANSITION.md).

**Décisions L0 :** [Registre D01–D06 validé](RESONANCES-V1-L0-DECISIONS.md). La validation explicite de Jordani du 27 septembre 2026 remplace les hypothèses correspondantes de la version 1.0 ; D07 et suivantes restent ouvertes.

## Synthèse

Résonances est une bibliothèque visuelle et réflexive francophone autour de l’amour. Une image déclenche une émotion, puis une interprétation nuancée et une question. La V1 est un site éditorial public, alimenté par son auteur, avec une Galerie, des Réflexions longues et une navigation thématique. Elle ne comporte aucun compte lecteur ni contribution communautaire.

Le produit adopte un monolithe modulaire : Next.js, React, TypeScript, CSS Modules, PostgreSQL, Drizzle ORM + Drizzle Kit et stockage objet pour les médias. Le circuit éditorial repose sur Markdown structuré avec frontmatter dans Git, puis import privé vers PostgreSQL. Les fournisseurs restent à décider. La priorité est une première version achevée, accessible, rapide et suffisamment claire pour servir de terrain d’apprentissage.

### Comment lire les statuts

- **[V] Validé :** décision explicitement approuvée dans la conversation initiale ou dans le registre L0 du 27 septembre 2026.
- **[R] Recommandé :** précision apportée par cette spécification pour rendre le produit réalisable et testable ; ce n’est pas une validation historique.
- **[D] Différé :** décision ouverte ou fonctionnalité hors V1.

Les sections marquées [V] peuvent contenir des détails [R] signalés individuellement. Les règles physiques retenues par D04 sont validées ; leur DDL reste à préparer. Les autres compléments [R] et seuils de recette restent des propositions, pas des mesures déjà obtenues.

## Sommaire

1. Vision et identité
2. Charte éditoriale
3. Périmètre et parcours
4. Pages et règles fonctionnelles
5. Architecture fonctionnelle et technique
6. Modèle de données
7. Design system
8. Bibliothèque de composants
9. Responsive et accessibilité
10. Médias, SEO et exploitation
11. Roadmap
12. Décisions ouvertes et arbitrages
13. Critères de réussite
14. Références et traçabilité

## 1. Vision et identité [V]

### 1.1 Promesse

**Une image ne doit pas seulement être vue ; elle doit ouvrir un espace de réflexion.**

Le parcours fondateur est **Voir → Ressentir → Comprendre → Questionner → Échanger**. La V1 couvre les quatre premières étapes ; l’échange sur le site appartient aux phases suivantes.

Le noyau éditorial est l’amour romantique, avec un élargissement progressif vers les relations familiales, amicales, humaines et philosophiques. Chaque contenu doit conserver un lien explicite avec l’amour. Le projet accueille la tendresse, la fragilité, les contradictions et les difficultés ; il ne se limite pas aux sentiments heureux.

### 1.2 Public et objectifs

Le premier public est francophone, intéressé par les images expressives et une lecture personnelle des relations. Aucun segment démographique précis n’a été validé. Le site commence comme une démarche d’auteur ouverte au public.

Deux objectifs se renforcent : créer une expérience éditoriale identifiable et développer les compétences de Jordani en programmation, SQL, rédaction, structuration de contenu et conception produit. La progression technique doit rester explicable et reproductible.

### 1.3 Marque

- Nom de référence : **Résonances**.
- Baseline de travail, encore provisoire : **Voir, ressentir, questionner l’amour.**
- Personnalité : **poétique dans la forme, intellectuelle dans le fond, humaine dans le ton**.
- Direction visuelle : minimalisme éditorial, photographie cinématographique, chaleur et espace.
- Langue V1 : français. Préparation à l’internationalisation, sans traduction ni sélecteur de langue en V1.

## 2. Charte éditoriale [V]

### 2.1 Principes

1. Distinguer ce qui est visible de ce qui est interprété.
2. Présenter les lectures subjectives comme telles : « j’y vois », « peut évoquer », « me suggère ».
3. Préserver l’ambiguïté : une scène peut évoquer simultanément proximité et inquiétude, nostalgie et gratitude.
4. Questionner ce qui nourrit le lien, le rend complexe ou le déforme.
5. Ne pas transformer possessivité, manipulation ou domination en preuves d’amour sous prétexte d’une esthétique romantique.
6. Donner d’abord à ressentir, puis à réfléchir ; rester accessible et éviter le sentimentalisme automatique comme le ton excessivement académique.
7. Terminer sur une ouverture, sans imposer une définition universelle du « véritable amour ».

**Question de contrôle :** qu’est-ce que cette image nous montre, nous suggère, nous fait ressentir ou nous pousse à questionner à propos de l’amour ?

### 2.2 Publication Galerie

Structure stable : **Image → Titre → Accroche → Observation → Évocation → Réflexion → Question ouverte → Thèmes**.

| Élément | Fonction | Règle de rédaction |
|---|---|---|
| Image | Déclencheur visuel | Composition respectée, provenance documentée |
| Titre | Donner une porte d’entrée | Évocateur et compréhensible |
| Accroche | Inviter à lire | Une ou deux lignes dans les aperçus |
| Observation | Décrire le visible | Pas d’intention attribuée comme fait |
| Évocation | Exprimer un ressenti | Subjectivité explicite |
| Réflexion | Relier à une idée | Aller au-delà de la description littérale |
| Question ouverte | Prolonger la pensée | Pas de réponse unique suggérée artificiellement |
| Thèmes | Relier les contenus | Plusieurs thèmes possibles |

La longueur est souple. La page ressemble à un article continu, avec des marqueurs typographiques ; elle ne doit pas devenir une succession de fiches scolaires. [R] À la publication, chaque fonction éditoriale doit être présente, même brièvement ; les brouillons peuvent être incomplets.

### 2.3 Réflexion longue

Une idée constitue le point de départ. Le contenu comprend titre, introduction ou résumé, développement structuré, citations et médias éventuels, puis contenus associés. Une couverture est facultative. Les titres internes et liens entre idées priment sur une grille de sections imposée.

[R] Les citations et affirmations factuelles externes comportent leurs références. Le texte éditorial n’est pas présenté comme un diagnostic psychologique. L’auteur relit les textes avant publication, y compris ceux éventuellement préparés avec une assistance.

### 2.4 Thèmes

Vocabulaire initial : Complicité, Confiance, Présence, Absence, Distance, Attachement, Liberté, Vulnérabilité, Conflit, Pardon, Temps, Rupture, Soutien, Solitude, Reconstruction. Cette liste est extensible ; elle n’est pas un ensemble de catégories exclusives.

[R] Un petit vocabulaire contrôlé évite les doublons et synonymes dispersés. Les trois espaces éditoriaux — nourrir, complexifier, déformer le lien — guident l’écriture sans devenir une classification obligatoire en base.

## 3. Périmètre et parcours

### 3.1 Inclus [V]

- Accueil, Galerie, publication individuelle, Réflexions, article individuel, À propos.
- Navigation par thèmes, publication à la une choisie éditorialement.
- Flux visuel composé de publications, cartes-question et liens vers des Réflexions.
- Chargement progressif explicite, contenus associés, URLs lisibles.
- Modèles séparés Publication et Reflection, médias indépendants, relations éditoriales.
- Design responsive, accessibilité, états vides et erreurs.
- Recherche simple en V1 sur les deux types de contenus, validée par D01.

### 3.2 Recherche V1 [V — D01]

Inclure en V1 une recherche sur titre, accroche/résumé et thèmes, avec résultats Publication/Reflection. Elle est insensible à la casse, avec accents à tester et validation serveur. Pas de fuzzy search, moteur externe, recherche vectorielle ou sémantique en V1. PostgreSQL Full Text Search et ranking avancé sont différés à V1.1. Voir [D01](RESONANCES-V1-L0-DECISIONS.md#d01--recherche-v1).

### 3.3 Hors V1 [D]

Comptes lecteurs, profils, favoris persistants, collections personnelles, likes, compteurs sociaux, commentaires, abonnements, chat, notifications, contributions publiques, recommandations IA, recherche vectorielle, parcours personnalisés, multilingue public. Contact est facultatif et non requis au lancement. Aucun CMS ni interface d’administration en V1, conformément à D03.

### 3.4 Parcours de référence [V]

- **Découverte :** Accueil → publication à la une → lecture → contenu associé.
- **Exploration :** Galerie → thème → publication → autre contenu du même univers.
- **Approfondissement :** carte-question → Réflexion → publication visuelle associée.
- **Compréhension du projet :** navigation → À propos → retour à l’exploration.
- **Recherche [V — D01] :** saisir une requête → résultats typés → publication ou Réflexion.

## 4. Pages et règles fonctionnelles

### 4.1 Matrice des pages [V]

Les routes ci-dessous reprennent la structure Next.js la plus récente ; `/recherche` est une précision [R].

| Page / route | Contenu et composants | Critère fonctionnel principal |
|---|---|---|
| Accueil `/` | Navbar, manifeste court, FeaturedStory, PublicationCard, ReflectionCard, ThemeChip, Footer | Comprendre la promesse et entrer dans un contenu |
| Galerie `/galerie` | Introduction, une, filtres, SearchBar, GalleryGrid, QuestionCard, LoadMore | Explorer les publications par thème |
| Publication `/galerie/[slug]` | PublicationHero, sections éditoriales, OpenQuestion, thèmes, RelatedContent | Lire l’image et son interprétation intégrale |
| Réflexions `/reflexions` | Introduction, FeaturedReflection, filtres, ReflectionCard, LoadMore | Trouver les articles longs |
| Article `/reflexions/[slug]` | ArticleHeader, couverture facultative, corps riche, RelatedContent | Lire et poursuivre vers les deux types de contenus |
| À propos `/a-propos` | Origine, philosophie, démarche, visuels éventuels | Expliquer la voix d’auteur et le projet |
| Recherche `/recherche` | SearchBar, filtres, résultats Publication/Reflection, EmptyState | Retrouver un contenu par mots et thèmes |
| Introuvable / erreur | EmptyState ou ErrorState, liens de retour | Comprendre le problème et reprendre la navigation |

Navbar et Footer sont partagés. Pas de CTA communautaire inactif ou de bouton sans destination.

### 4.2 Galerie [V]

Ordre : introduction courte → publication à la une → exploration thématique → flux éditorial → « Charger davantage ».

La une ne dépend pas automatiquement de la date : l’auteur la choisit. La mosaïque est contrôlée et respecte la variété des images. Les titres et thèmes sont accessibles sans survol sur mobile ; [R] ils restent également lisibles ou accessibles au focus sur ordinateur.

La première série comporte 12 à 18 publications. [R] Retenir 12 comme valeur initiale, hors carte à la une et insertions éditoriales. Le bouton charge le lot suivant sans scroll infini automatique.

### 4.3 Contrat des listes, filtres et recherche [R]

Les règles de recherche D01 et de cartes-question D05 sont désormais [V] ; les autres précisions de ce contrat restent [R].

- Tri par `published_at` décroissant, puis identifiant stable pour départager les égalités.
- Un thème actif à la fois en V1 ; « Tous » réinitialise ce filtre.
- État encodé dans l’URL (`theme`, `q`, paramètre de pagination) pour partage, actualisation et navigation arrière.
- Nouveau filtre ou nouvelle requête : retour au premier lot.
- Recherche insensible à la casse ; la gestion des accents doit être testée. Fuzzy search exclue de V1.
- Titre, nom de thème, accroche/résumé sont le corpus minimal. Requête vide : invitation à rechercher, sans lancer un résultat global implicite.
- Maximum de 100 caractères pour une requête ; validation côté serveur et requêtes paramétrées.
- « Charger davantage » possède les états prêt, chargement, erreur réessayable et fin de liste. Une erreur conserve les éléments déjà affichés.
- Navigation paginée utilisable sans JavaScript ; amélioration côté client pour concaténer les lots. L’ordre DOM reste l’ordre de lecture.
- Aucun brouillon, contenu retiré ou date future dans les listes, recherches, recommandations et sitemaps.
- Les GalleryQuestion sont insérées de manière déterministe, ne comptent pas dans la pagination des publications et ne se répètent pas à chaque lot.
- Une GalleryQuestion pointe vers une Reflection publiée et dérive ses thèmes de cette cible. Les collections ne sont pas des destinations V1.

### 4.4 Contenus associés et mise en avant [R]

Afficher jusqu’à trois contenus associés publiés, sélectionnés manuellement et ordonnés. Compléter éventuellement par thèmes communs, sans doublon et sans le contenu courant. Masquer la section si aucun candidat n’existe.

Définir les emplacements `home`, `gallery`, `reflections`. Un emplacement ne doit pas avoir deux unes simultanées de même position. Sans une configurée, employer le dernier contenu publié du type attendu ; sans contenu, afficher un état vide. Les dates de programmation servent seulement si leur invalidation de cache est effectivement implémentée.

## 5. Architecture fonctionnelle et technique

### 5.1 Monolithe modulaire [V]

```text
Navigateur
    ↓
Pages et composants Next.js
    ↓
Services / cas d’usage éditoriaux
    ↓
Repositories
    ↓
PostgreSQL ── références ── Stockage objet des médias
```

Les modules sont Publications, Réflexions, Thèmes, Médias, Relations, Mise en avant et Recherche. L’interface consomme des modèles de lecture ; les règles de visibilité et d’intégrité vivent côté serveur. Les composants ne portent pas les requêtes SQL.

### 5.2 Stack

| Couche | Direction | Statut et justification |
|---|---|---|
| Application | Next.js avec App Router | [V] Pages publiques et backend dans le même projet |
| Interface | React + TypeScript | [V] Composants et contrats explicites |
| Styles | CSS Modules + custom properties | [V] Maîtrise de Grid, Flexbox et responsive ; Tailwind non retenu au départ |
| Données | PostgreSQL | [V] Relations, contraintes et transactions |
| Accès SQL | Drizzle ORM + Drizzle Kit | [V — D02] Code-first, migrations SQL versionnées et inspectables |
| Médias | Stockage objet + variantes web | [V] Fichiers hors base ; fournisseur [D] |
| Versionnement | Git + GitHub | [V] Historique et collaboration |
| Déploiement | Fournisseur à choisir | [D] Compatibilité application, base et images à vérifier |

[V — D02] Raisonner les requêtes relationnelles importantes en SQL avant leur traduction en Drizzle. Le choix de l’ORM est arrêté ; aucune comparaison Prisma/Drizzle ne bloque la conception physique. Voir le [registre L0](RESONANCES-V1-L0-DECISIONS.md).

Les versions exactes seront fixées ensemble au démarrage, dans une combinaison supportée, puis verrouillées. Ce document ne prétend pas désigner la dernière version de chaque outil.

### 5.3 Rendu et limites client/serveur [R]

Rendu serveur ou génération avec revalidation pour les contenus publics. Interactivité client limitée au menu, aux filtres améliorés et au chargement progressif. Le serveur interroge directement les services ; il n’appelle pas sa propre API HTTP pour lire ses données.

Les Route Handlers ne sont ajoutés que pour une interaction qui l’exige. Les Server Actions ne sont pas nécessaires à un site public essentiellement en lecture. Une édition future utilisera des mutations authentifiées et autorisées.

Le circuit de publication déclenche la mise à jour des pages et listes concernées. Un contenu retiré doit également disparaître des pages en cache. La politique précise dépendra des versions et de l’hébergeur.

### 5.4 Organisation cible [R]

```text
src/
  app/                 routes et layouts
  components/
    ui/                Button, ThemeChip, états
    layout/            Navbar, Footer
    gallery/           cartes et grille
    editorial/         corps d’articles et relations
  domain/              types et règles métier
  services/            cas d’usage
  repositories/        accès aux données
  lib/                 configuration, validation, utilitaires
  styles/              tokens.css, globals.css
  messages/fr/         textes d’interface
db/                    schéma Drizzle et migrations SQL versionnées
content/               Markdown structuré + frontmatter versionné dans Git
scripts/               import et maintenance
tests/                 intégration et parcours
docs/                  spécification, décisions, exploitation
```

Cette organisation affine la séparation validée, sans exiger une abstraction générique pour chaque fonction.

## 6. Modèle de données

### 6.1 Entités validées [V]

| Entité | Champs conceptuels |
|---|---|
| Publication | id, slug, title, hook, observation, evocation, reflection, open_question, media_asset_id, status, published_at, created_at, updated_at |
| Reflection | id, slug, title, excerpt, content, cover_media_id, status, published_at, created_at, updated_at |
| Theme | id, name, slug, description |
| PublicationTheme | publication_id, theme_id |
| ReflectionTheme | reflection_id, theme_id |
| MediaAsset | id, original_filename, original_url, web_url, thumbnail_url, alt_text, caption, author, source, license, width, height, mime_type, created_at |
| ContentRelation | id, source_publication_id ou source_reflection_id, target_publication_id ou target_reflection_id, relation_type, position ; exclusivité et foreign keys (D04) |
| FeaturedContent | id, publication_id ou reflection_id, slot, position, starts_at, ends_at ; cible exclusive avec foreign key (D04) |
| GalleryQuestion | id, question, reflection_id, after_publication_count, status, dates (D05 ; dates exactes à préciser au schéma) |

Publication et Reflection restent deux modèles métier distincts. Une publication possède une image principale ; un média peut être réutilisé. Une Réflexion possède zéro ou une couverture. Chaque type de contenu possède plusieurs thèmes, et réciproquement.

**Note conceptuelle — provenance de MediaAsset.** La provenance de chaque média doit pouvoir être documentée conformément à la politique de la section 10.1.1, en complément des informations existantes `author`, `source` et `license`. Des concepts comme `origin_type` (création personnelle, génération IA ou source externe), `generator` ou une référence vers un dossier de provenance peuvent être envisagés. Ces noms sont des pistes conceptuelles, pas des champs physiques arrêtés. Leur emplacement exact — en base, dans le frontmatter ou dans un manifeste — sera décidé pendant la conception du schéma physique et du workflow média. Cette note n’ajoute aucune migration et ne tranche pas D07, qui reste ouverte concernant le stockage et le pipeline média.

### 6.2 Compléments recommandés [R]

- Identifiants UUID ; dates avec fuseau, enregistrées en UTC et affichées en français.
- `status` : `draft`, `published`, `archived`. Un contenu visible est publié avec `published_at <= maintenant`.
- `locale` initialisé à `fr`, slugs uniques par langue et type ; textes d’interface isolés. Les tables de traduction seront conçues plus tard.
- Métadonnées facultatives `seo_title`, `seo_description` avec fallback sur titre et résumé.
- Clés composées uniques pour les associations de thèmes ; dimensions d’images strictement positives.
- Index sur slug, visibilité/date et colonnes de jointure. Évaluer les index de recherche avec des données représentatives.
- Suppression d’un média référencé interdite ; archivage des contenus préféré à leur suppression. Suppression d’une association possible sans supprimer les entités liées.
- Slug publié stable ; s’il change, conserver une redirection permanente depuis l’ancienne URL.

### 6.3 Intégrité des relations entre types [V — D04]

Le couple générique `type + id` du modèle conceptuel ne fournit pas, à lui seul, une foreign key vers deux tables. Il ne faut pas le traduire tel quel en supposant l’intégrité acquise.

Décision physique V1 : `ContentRelation` utilise deux références possibles côté source (`source_publication_id`, `source_reflection_id`) et deux côté cible, chacune avec foreign key. Une contrainte impose exactement une source et une cible. Interdire les auto-relations et doublons ; ajouter `position` pour l’ordre éditorial. Les relations sont dirigées ; leur éventuelle réciproque est créée explicitement.

`FeaturedContent` reçoit exactement une cible publication ou réflexion exclusive et un `slot`, avec ordre via `position`. Il représente une mise en avant, pas une relation entre deux contenus : aucune source de contenu artificielle n’est ajoutée. Les contraintes d’intégrité, d’exclusivité et d’unicité seront formalisées en SQL ; les règles d’intervalle temporel restent à détailler. Aucune table générique `Content` en V1. Voir [D04](RESONANCES-V1-L0-DECISIONS.md#d04--relations-physiques).

### 6.4 Médias secondaires [R] et cartes-question [V — D05]

Le modèle initial ne décrivait pas la persistance de tout le flux. Pour éviter les liens codés dans les pages :

- `GalleryQuestion` remplace l’ancienne proposition `EditorialInsertion`. Champs principaux : `id`, `question`, `reflection_id`, `after_publication_count`, `status`, dates. La cible doit être une Reflection publiée ; les thèmes en sont dérivés, sans thèmes propres à la question. L’insertion est déterministe, hors pagination des publications et sans répétition à chaque lot. Cette entité alimente le composant `QuestionCard`.
- Stocker les variantes média dans une structure validée (`width`, `height`, format, clé objet, taille). Une table `MediaVariant` est préférable si le prestataire ne fournit pas ce catalogue.
- Les images intégrées aux Réflexions utilisent des identifiants MediaAsset ; un manifeste d’associations validé à l’import empêche les références cassées. Les futures publications multi-images pourront recevoir une table d’association ordonnée.
- Conserver un point focal pour les recadrages, et une description alternative par usage lorsqu’un même média apparaît dans des contextes différents.

GalleryQuestion est validée par [D05](RESONANCES-V1-L0-DECISIONS.md#d05--flux-éditorial-et-galleryquestion). Les compléments relatifs aux médias restent recommandés ; ils ne sont pas validés par L0.

### 6.5 Cycle éditorial [V — D03 ; détails de publication R]

**Préparer → importer en brouillon → prévisualiser localement → relire → publier → actualiser les pages → vérifier.**

Circuit validé : Markdown structuré + frontmatter, versionné dans Git, puis import privé vers PostgreSQL avec validation, dry-run, transaction et idempotence. Markdown sans HTML arbitraire ni code exécutable ; le moteur de rendu autorise les éléments éditoriaux nécessaires. PostgreSQL sert les lectures publiques ; les fichiers servent de sources d’édition. Aucun CMS ni interface d’administration en V1.

L’import est transactionnel et idempotent, identifié par UUID ; il propose une validation sans écriture, conserve les identifiants et refuse les références invalides. La publication exige titre, slug, structure éditoriale, au moins un thème et média principal pour une Publication, contenu pour une Reflection, ainsi que les métadonnées média nécessaires.

Ce circuit est arrêté par [D03](RESONANCES-V1-L0-DECISIONS.md#d03--circuit-éditorial). Le contrat exact du frontmatter et les modalités de prévisualisation restent à préparer au plan. Les exigences de contenu et le choix UUID ci-dessus restent des compléments [R].

## 7. Design system [V]

### 7.1 Couleurs

| Token | Valeur | Usage |
|---|---|---|
| background-primary | #FAF8F5 | Fond général |
| background-secondary | #F2ECE5 | Blocs éditoriaux |
| surface | #FFFFFF | Surfaces |
| text-primary | #252525 | Texte et titres |
| text-secondary | #68635F | Métadonnées |
| accent | #9A674F | Actions et détails actifs |
| accent-soft | #D8BBAA | Décor et états subtils |
| night | #26384A | Contraste sombre |
| border | #E3DDD7 | Séparateurs |
| overlay | rgba(15,15,15,.35) | Point de départ pour superpositions photo |

Les thèmes n’ont pas de couleur émotionnelle individuelle. [R] La palette n’est pas une certification de contraste : chaque couple texte/fond et chaque état doit être vérifié. L’overlay à 35 % ne garantit pas la lisibilité sur toutes les photographies ; renforcer localement le fond ou déplacer le texte sous l’image.

### 7.2 Typographie

[V — D06] Playfair Display pour les titres et l’expression éditoriale ; Inter pour le corps, la navigation et l’interface. Limiter les graisses, employer des tailles fluides, prévoir des fallbacks et vérifier la couverture du français. Cormorant Garamond n’est pas retenue en V1. Voir [D06](RESONANCES-V1-L0-DECISIONS.md#d06--typographie).

| Élément | Desktop | Mobile |
|---|---:|---:|
| Hero h1 | 64–72 px | 42–48 px |
| Page h1 | 48 px | 36 px |
| h2 | 36 px | 30 px |
| h3 | 26 px | 23 px |
| Texte | 18 px | 17 px |
| Interface | 15–16 px | 15–16 px |
| Métadonnées | 13–14 px | 13–14 px |

Largeur de lecture : 60–75 caractères. [R] Tailles en unités relatives, interpolation fluide et interligne de corps autour de 1,6 ; les longs titres peuvent revenir à la ligne sans hauteur fixe.

### 7.3 Espace, géométrie et mouvement

- Échelle : 4, 8, 12, 16, 24, 32, 48, 64, 80, 96, 128 px.
- Cartes et espacements de grille : 16–24 px ; sections desktop : 80–128 px.
- Conteneur : maximum 1280–1440 px ; marges mobiles : 20–24 px.
- Rayons : images 8–12 px, cartes 10–14 px, champs 8–10 px ; boutons classiques 10–12 px ou pill ; tags pill.
- Ombres discrètes ; privilégier fonds, bordures légères et espace.
- Mouvement : fade, légère translation, zoom image 1 → 1,02 ; 200–450 ms, désactivable selon la préférence de mouvement réduit.

### 7.4 Photographie

Galerie : recadrage éditorial contrôlé. Publication : ratio original préservé autant que possible. Hero desktop environ 16:7 à 16:8 ; mobile environ 4:5. Chaque recadrage doit préserver le sujet. [R] Une grille CSS à placements maîtrisés remplace un masonry complexe si nécessaire, sans réordonner artificiellement la lecture.

## 8. Bibliothèque de composants [V]

| Groupe / composants | Données et responsabilité | États ou variantes |
|---|---|---|
| Layout, Navbar, Footer | Navigation, logo, page active | Desktop, menu mobile ouvert/fermé |
| Button | Action ou lien selon la sémantique | Primary, Secondary, Text ; focus, disabled, loading |
| ThemeChip | Nom, slug, sélection | Default, hover, active, focus |
| Image | Média, dimensions, alt, cadrage | Hero, carte, article, indisponible |
| SearchBar | Requête et soumission | Vide, saisi, chargement, erreur |
| FeaturedStory | Image, titre, accroche, thèmes, CTA | Accueil/Galerie ; citation facultative |
| PublicationCard | Image, titre, thèmes, lien | Compact, standard, featured, horizontal |
| ReflectionCard | Titre, résumé, date, couverture facultative | Texte dominant |
| QuestionCard | Question et destination | Avec ou sans résultat admissible : masquer si invalide |
| GalleryGrid | Flux éditorial typé | 1, 2 ou 3 colonnes |
| SectionHeader, ArticleHeader | Titres et métadonnées | Sections et pages |
| OpenQuestion | Question finale | Bloc éditorial non interactif en V1 |
| RelatedContent | Liste de contenus associés | Publications et Réflexions |
| LoadMore | État et prochain lot | Prêt, loading, erreur, terminé |
| EmptyState, ErrorState | Message et reprise possible | Vide, aucun résultat, 404, erreur |

[R] `FeaturedReflection` compose les primitives existantes. Le flux est une union typée de publication, réflexion et question. Aucun composant ne doit accepter des combinaisons de champs incohérentes. Un lien vers une publication ne contient pas de liens de thèmes imbriqués : zones interactives séparées.

## 9. Responsive et accessibilité

### 9.1 Responsive [V]

Mobile-first. Repères de largeur : 640, 768, 1024, 1280 et 1536 px, adaptés aux besoins du contenu. Mobile : une colonne, deux seulement si lisibles ; tablette : deux ; desktop : trois principalement, parfois deux. Le hero mobile empile image, thèmes, titre, accroche et lien.

[R] Vérifier à 320, 390, 768, 1024 et 1440 px, avec titres longs et zoom. Les filtres reviennent à la ligne ou restent entièrement accessibles. Aucune information essentielle ne dépend de hover. Le footer reste atteignable grâce au chargement volontaire.

### 9.2 Accessibilité [V, précisions R]

Objectif recommandé : WCAG 2.2 niveau AA. Navigation clavier, focus visible, structure de titres, alternatives textuelles descriptives, ARIA seulement si nécessaire et respect de `prefers-reduced-motion` sont validés.

La cible produit de 44 × 44 px pour les contrôles tactiles vient du design validé ; elle est plus exigeante que le minimum général de 24 × 24 px du critère AA 2.5.8, soumis à exceptions. Contraste : 4,5:1 pour le texte courant, 3:1 pour le grand texte et les éléments d’interface concernés. [Référence normative WCAG 2.2](https://www.w3.org/TR/WCAG22/).

[R] Ajouter lien d’évitement, landmarks, langue `fr`, noms accessibles, menu mobile utilisable avec Échap et retour du focus au déclencheur. Annoncer les résultats chargés sans déplacer le focus arbitrairement. Les états ne reposent pas uniquement sur la couleur. Tester reflow et agrandissement, navigation clavier et au moins un lecteur d’écran.

L’alt décrit l’image, non l’interprétation : « Deux personnes assises côte à côte face à un coucher de soleil ». Une image décorative possède un alt vide. Les crédits restent disponibles à côté du contenu ou dans ses informations.

## 10. Médias, SEO et exploitation

### 10.1 Médias [V]

Conserver les originaux JPEG/PNG séparément. Diffuser les photographies en WebP, avec miniature, taille moyenne et grande taille ; SVG pour les éléments vectoriels du site ; PNG lorsque nécessaire. AVIF est différé. Les dimensions indicatives sont 800–1200 px pour cartes et 1600–2000 px pour grandes images, à ajuster selon affichage.

[R] Ne pas agrandir artificiellement un petit original. Fournir `sizes` et variantes adaptées, réserver la place par dimensions et ne pas lazy-loader l’image principale visible au chargement. Vérifier le résultat des recadrages sur téléphone. Les originaux ne sont pas envoyés automatiquement au navigateur.

Source, auteur et licence sont documentés pour chaque média. Les justificatifs de provenance sont conservés ; le simple fait qu’une image soit téléchargeable ne constitue pas une validation éditoriale de son usage. Les conditions précises des sources choisies restent à examiner avant publication.

#### 10.1.1 Politique de provenance des images [V]

Par défaut, les images utilisées dans Résonances doivent être :

- créées directement par l’auteur ; ou
- générées spécifiquement pour le projet avec un outil d’IA dont les conditions d’utilisation permettent l’usage prévu.

Les images externes ne sont utilisées que lorsque leur licence, leur provenance et les éventuelles obligations d’attribution ont été vérifiées et documentées. Le simple fait qu’une image soit disponible ou téléchargeable sur Internet ne constitue jamais une autorisation suffisante d’utilisation.

Pour chaque image générée par IA, conserver en interne au minimum :

- l’outil utilisé ;
- la date de génération ;
- une référence au prompt ou au brief visuel ;
- l’indication d’éventuelles retouches ;
- les informations utiles concernant les droits d’usage selon l’outil concerné.

Cette traçabilité complète les informations d’auteur, de source et de licence ; elle ne les remplace pas. Elle ne signifie pas que toutes les données internes doivent être affichées publiquement sur le site. Les crédits et obligations d’attribution applicables restent respectés.

Cette politique ne dépend d’aucun fournisseur IA particulier. Le lieu de stockage des métadonnées de provenance reste à déterminer lors de la conception du schéma physique et du workflow média, comme indiqué dans la note conceptuelle MediaAsset en section 6.1. D01–D06 restent inchangées et D07 reste ouverte.

### 10.2 SEO [R]

Chaque contenu publié possède titre, description, URL canonique et aperçu social. Les pages sont accessibles par liens HTML. Sitemap limité aux URLs publiques pertinentes ; vraie réponse 404 pour une URL inconnue. Les pages de recherche et combinaisons de filtres ne sont pas indexées par défaut. Brouillons absents des routes publiques ; `noindex` ne remplace pas un contrôle d’accès.

L’API Metadata de Next.js fournit les mécanismes de métadonnées et d’aperçus sociaux nécessaires. [Documentation officielle](https://nextjs.org/docs/app/getting-started/metadata-and-og-images).

Le SEO de base et les images adaptées appartiennent au lancement ; leur amélioration peut continuer en V1.1. La visibilité dans les moteurs n’est pas garantie par la seule configuration technique.

### 10.3 Exploitation et sécurité [R]

- Environnements local, préproduction et production séparés ; secrets uniquement côté serveur.
- Aucun accès public à l’import ou à la base ; validation des entrées et rendu du texte sans HTML arbitraire.
- Migrations versionnées, sauvegarde avant changement sensible et procédure de restauration essayée.
- Sauvegardes de la base et des médias ; protéger les originaux contre l’écrasement.
- Journaliser les erreurs serveur et les imports sans secrets ni contenu sensible inutile.
- Contrôler les dépendances, les accès au stockage et les URLs distantes autorisées.
- Prévoir un retour à la version applicative précédente ; vérifier sa compatibilité avec les migrations.
- Définir avant déploiement le budget mensuel maximal et les alertes de consommation média.

Le budget, le trafic attendu, le nom de domaine et les contraintes d’hébergement ne sont pas connus. Les choix de fournisseur et les engagements de disponibilité restent ouverts. Les pages d’information et obligations applicables seront déterminées selon l’éditeur et le dispositif réellement déployé ; aucune juridiction n’est supposée ici.

## 11. Roadmap consolidée

Les phases expriment un ordre de capacité, sans date ni promesse de calendrier.

| Phase | Résultat | Condition d’entrée |
|---|---|---|
| V1 | Noyau éditorial, Galerie, Réflexions, thèmes, médias, relations, recherche simple validée | D01–D06 validées ; contenus de départ à préparer |
| V1.1 | PostgreSQL Full Text Search et ranking avancé, amélioration SEO et performance, édition plus confortable si utile | Retours de la V1 et mesures réelles |
| V2 | Comptes et favoris ; collections à préciser | Besoin lecteur établi et architecture d’authentification définie |
| V3 | Profils et résonances communautaires | Modération minimale, signalement et règles de participation prêts |
| V4 | Contributions plus larges et modération enrichie | Capacité éditoriale et opérationnelle suffisante |
| V5 | Recherche sémantique, recommandations, assistance au classement | Corpus suffisant et protocole d’évaluation pertinent |
| V6 | Parcours éditoriaux puis éventuellement personnalisés | Valeur éditoriale démontrée |

**Correction recommandée :** la roadmap historique place surtout la modération en V4. Les premières contributions arrivent en V3 ; leur modération minimale doit donc être opérationnelle dès V3. V4 peut l’enrichir.

L’internationalisation reste transversale et sans phase fixée. PostgreSQL offre une recherche plein texte pouvant servir à V1.1 ; cette capacité ne rend pas nécessaire un moteur externe dès V1. [Documentation PostgreSQL](https://www.postgresql.org/docs/current/textsearch-controls.html).

## 12. Décisions ouvertes et arbitrages

| ID | Sujet | État / proposition | Échéance |
|---|---|---|---|
| D01 | Recherche V1 | [V] Recherche simple ; Full Text Search et ranking avancé en V1.1 | Validée le 27/09/2026 |
| D02 | ORM | [V] Drizzle ORM + Drizzle Kit, code-first, migrations SQL versionnées | Validée le 27/09/2026 |
| D03 | Édition du contenu | [V] Markdown + frontmatter dans Git, import privé ; aucun CMS/admin V1 | Validée le 27/09/2026 |
| D04 | Relations physiques | [V] Foreign keys typées et exclusivité ; pas de table Content | Validée le 27/09/2026 |
| D05 | Flux éditorial | [V] GalleryQuestion spécialisée, thèmes dérivés de la Reflection | Validée le 27/09/2026 |
| D06 | Polices | [V] Playfair Display + Inter | Validée le 27/09/2026 |
| D07 | Stockage / images | [D] Prestataire, traitement et coût | Avant pipeline média |
| D08 | Hébergement et domaine | [D] Fournisseurs, région, budget, exploitation | Avant préproduction |
| D09 | Baseline | [D] Formulation de travail conservée | Avant identité publique finale |
| D10 | Corpus de lancement | [R] 12 publications, 3 Réflexions et plusieurs thèmes | Avant recette éditoriale |
| D11 | CMS, contact, analytics | [D] Non requis ; justification avant ajout | Selon besoin réel |

### Résolution des écarts historiques

Le [registre L0](RESONANCES-V1-L0-DECISIONS.md) fait référence pour D01–D06. D07–D11 restent ouvertes avec leurs statuts antérieurs. Pour D11, l’éventualité d’un CMS concerne une évolution ultérieure : D03 exclut sa présence en V1.

- `/galerie/[slug]` remplace l’ancien exemple `/resonances/...` : il correspond à l’arborescence la plus récente.
- Une table de mise en avant remplace l’idée initiale `featured = true`.
- Les thèmes multiples remplacent les catégories rigides.
- La mosaïque variée prévaut sur l’ancien exemple de miniatures toutes au même ratio.
- Les collections restent futures malgré leur mention comme destination possible de QuestionCard.
- Préparer des extensions ne signifie pas créer les tables communautaires maintenant, ni garantir qu’aucune migration ne sera jamais nécessaire.

## 13. Critères de réussite et recette [R]

### 13.1 Exigences vérifiables

| ID | Critère | Preuve attendue |
|---|---|---|
| AC01 | Les pages de la matrice existent et leurs liens aboutissent | Parcours navigateur automatisé et revue manuelle |
| AC02 | Les publications suivent la charte et distinguent observation/interprétation | Relecture de chaque contenu de lancement |
| AC03 | Brouillons, archives et dates futures sont invisibles publiquement | Tests service, recherche, détails et cache après retrait |
| AC04 | Filtres et chargements donnent un ordre stable sans doublon | Jeu avec plus de 24 publications, dates identiques et thèmes croisés |
| AC05 | Recherche simple trouve les cas convenus et gère zéro résultat | Cas titre, thème, casse, accents et requête vide |
| AC06 | Une et contenus associés ne pointent jamais vers une cible non publiée | Tests d’intégration et retrait d’un contenu |
| AC07 | Import répétable, erreurs sans écriture partielle | Deux imports identiques et un import invalide |
| AC08 | Intégrité SQL garantie pour relations, médias et thèmes | Tests de contraintes sur PostgreSQL réel |
| AC09 | Aucun débordement ou contrôle inaccessible aux largeurs cibles | Revue visuelle et clavier avec textes longs |
| AC10 | Exigences d’accessibilité respectées sur les parcours principaux | Audit automatique complété par clavier et lecteur d’écran |
| AC11 | Images adaptées, dimensions réservées, ratio intégral disponible | Inspection réseau et revue mobile/desktop |
| AC12 | Métadonnées, sitemap, canonicals et 404 corrects | Inspection HTML et réponses HTTP |
| AC13 | Publication et retrait actualisent les pages concernées | Recette de bout en bout en préproduction |
| AC14 | Sauvegarde restaurable et procédure de déploiement reproductible | Compte rendu d’un exercice de restauration |

### 13.2 Objectifs de performance proposés

Sur Accueil, Galerie et une publication représentative, viser en laboratoire mobile : LCP ≤ 2,5 s et CLS ≤ 0,1, sur trois mesures à cache froid dont la médiane est retenue. Documenter appareil simulé, réseau, version et environnement. Après trafic suffisant, viser INP ≤ 200 ms au 75e percentile en conditions réelles ; une mesure de laboratoire ne prouve pas ce résultat terrain.

Ces valeurs sont des cibles de projet, pas des performances acquises. Le corpus de test comprend des images grandes, verticales et horizontales, des textes longs, des contenus sans couverture et des médias indisponibles.

### 13.3 Réussite produit et apprentissage

- [R] Corpus initial proposé : 12 publications relues, 3 Réflexions, 2 cartes-question et au moins 5 thèmes utiles. Ajouter des données synthétiques distinctes pour tester la pagination.
- [R] Faire essayer les parcours à 3–5 lecteurs francophones ; noter les hésitations et vérifier qu’ils comprennent la différence Galerie/Réflexions et trouvent un contenu associé sans aide.
- [R] Jordani peut expliquer le trajet page → service → repository → SQL et publier un contenu en suivant le guide.
- Aucun objectif de trafic ou d’engagement chiffré n’a été validé. La réussite initiale repose sur la qualité du contenu et l’achèvement des parcours, pas sur des compteurs sociaux.

### 13.4 Définition de fin V1

Les critères AC applicables sont satisfaits, les arbitrages bloquants sont consignés, le corpus est relu, aucun défaut bloquant n’est ouvert, la préproduction est vérifiée et le guide de publication/restauration est utilisable. La mise en production constitue un jalon distinct ; ce document ne déploie aucun service.

## 14. Références et traçabilité

### Décisions issues de la conversation

| Décision | Repère dans l’historique |
|---|---|
| Progression personnelle → publique → communauté | Validation « stratégie la plus solide et idéale » |
| Français puis internationalisation | Validation de l’option D sur les langues |
| Amour complexe et non exclusivement positif | Précision de Jordani « tout n’est pas rose » puis validation de la charte |
| Identité hybride et direction visuelle | Validations successives de l’option D |
| Format éditorial hybride | « ce format hybride… l’option C » |
| Galerie éditoriale, architecture et données | « je valide cela » après le modèle extensible |
| Mockup Galerie | « J’aime bien cette V1 » |
| Design system | « cette formalisation du design me convient » |
| Matrice et stack recommandée | « je valide cette direction » |

Les approbations de mockups sont attestées par l’historique textuel. Les mockups complets ne sont pas disponibles dans les résultats consultés ; aucun contrôle visuel pixel par pixel n’est revendiqué. L’image jointe à l’origine ne suffit pas à reconstituer ces maquettes.

### Documentation technique consultée le 15 septembre 2026

- [Next.js — Metadata and OG images](https://nextjs.org/docs/app/getting-started/metadata-and-og-images).
- [PostgreSQL — Controlling Text Search](https://www.postgresql.org/docs/current/textsearch-controls.html).
- [W3C — WCAG 2.2](https://www.w3.org/TR/WCAG22/).

Le présent document est la base de conception, actualisée par le [registre L0 validé le 27 septembre 2026](RESONANCES-V1-L0-DECISIONS.md). Les autres choix [R] restent des recommandations ; toute évolution de périmètre devra mettre à jour les critères associés.
