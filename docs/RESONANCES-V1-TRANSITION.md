# Résonances V1 — Transition vers le plan d’implémentation

**Date :** 27 septembre 2026 — mise à jour après validation L0  
**Référence :** [Spécification V1](RESONANCES-V1-SPECIFICATION.md)  
**Décisions :** [Registre L0 D01–D06](RESONANCES-V1-L0-DECISIONS.md)  
**Statut :** cadrage L0 suffisamment stabilisé pour préparer le schéma physique PostgreSQL/Drizzle et le plan d’implémentation détaillé ; aucune implémentation ni infrastructure créée par cette mise à jour.

## 1. But de la prochaine étape

Transformer les exigences en tâches petites et vérifiables, chacune avec résultat attendu, fichiers concernés, dépendances et validation. Le plan détaillé devra être adapté au dépôt réel et aux versions retenues. Il ne suffit pas de distribuer les pages : le circuit de publication et la visibilité des données doivent fonctionner de bout en bout.

## 2. Base de travail

Conserver les décisions validées : monolithe Next.js/TypeScript, CSS Modules, PostgreSQL, médias séparés, Publication et Reflection distinctes, aucune communauté.

Les décisions D01–D06 sont désormais validées : recherche simple V1 ; Drizzle ORM + Drizzle Kit en code-first avec migrations SQL versionnées ; Markdown structuré + frontmatter dans Git et import privé validé, transactionnel, idempotent avec dry-run ; foreign keys typées ; GalleryQuestion spécialisée ; Playfair Display + Inter. Le [registre L0](RESONANCES-V1-L0-DECISIONS.md) précise contexte, conséquences et limites. PostgreSQL Full Text Search et ranking avancé sont différés à V1.1. Aucun CMS ni interface d’administration en V1.

## 3. Traduction des décisions validées et choix encore ouverts

| Avant | Décision | Livrable concret |
|---|---|---|
| Backlog final | D01 validée : recherche simple incluse | Contrat serveur et cas AC05, casse et accents à tester |
| Schéma de base | D02 validée : Drizzle ORM + Drizzle Kit | Schéma code-first et migrations SQL inspectables ; raisonnement SQL avant Drizzle |
| Import | D03 validée : Markdown + frontmatter, import privé | Contrat de frontmatter, exemples, validation, dry-run, transaction et idempotence |
| Migrations | D04 validée : foreign keys typées ; D05 : GalleryQuestion | Schéma physique avec exclusivité, ordre, intégrité et exemples valides/invalides |
| Design system | D06 validée : Playfair Display + Inter | Graisses limitées, tailles fluides, fallbacks et vérification du français |
| Images | Fournisseur et génération des variantes | Test sur une image portrait et une paysage, estimation de coût |
| Préproduction | Hébergement, région, budget et domaine | Configuration reproductible et coût estimé |

Les lignes D01–D06 demandent une traduction en livrables, pas un nouvel arbitrage. D07 et suivantes restent ouvertes aux statuts de la spécification : médias, hébergement/domaine, baseline, corpus et sujets D11. Un CMS éventuel au titre de D11 concerne l’après-V1. Ces choix n’empêchent pas de préparer le schéma PostgreSQL/Drizzle et le plan ; ils seront résolus à leur échéance. Les versions exactes et les détails de réalisation restent à documenter.

## 4. Lots proposés et dépendances

| Lot | Résultat livrable | Dépend de | Validation |
|---|---|---|---|
| L0 — Cadrage technique stabilisé | Registre D01–D06 validé ; exemples et versions à préciser dans le plan | Spécification et validation de Jordani | D01–D06 arrêtées le 27/09/2026 |
| L1 — Socle | Projet reproductible, styles globaux, types, vérifications automatiques | L0 | Installation propre, compilation et page de base |
| L2 — Données et publication | Schéma Drizzle, migrations SQL, import privé, services de visibilité, repositories | L1 + D02–D04 validées | AC03, AC07, AC08 |
| L3 — Design system | Tokens, navigation, boutons, images et cartes | L1 | États clavier, mobile et textes longs |
| L4 — Première tranche complète | Import d’une publication → Galerie → détail → contenu associé | L2 + L3 | AC01, AC02, AC03, AC06 |
| L5 — Exploration | Thèmes, pagination, GalleryQuestion et recherche simple | L4 + D01/D05 validées | AC04, AC05 et tests sans JavaScript |
| L6 — Ensemble éditorial | Réflexions, Accueil, À propos, erreurs et navigation croisée | L4 | Matrice de pages complète |
| L7 — Qualité de diffusion | Médias définitifs, SEO, cache et retrait de contenu | L5 + L6 + fournisseurs | AC09–AC13 |
| L8 — Recette et exploitation | Corpus, préproduction, sauvegarde, guide et essais lecteurs | L7 | AC01–AC14, défauts bloquants résolus |

**Chemin principal :** L0 → L1 → L2/L3 → L4 → L5/L6 → L7 → L8. L2 et L3 sont indépendants après stabilisation des contrats ; cela indique des dépendances, sans imposer un travail par agents ou une équipe.

## 5. Première tranche à détailler

Objectif : démontrer qu’un contenu réel peut être créé, publié, découvert puis retiré correctement.

1. Définir un média autorisé et un exemple complet selon la charte.
2. Créer Publication, Theme, MediaAsset et leurs contraintes essentielles.
3. Importer un brouillon et vérifier son absence du site public.
4. Publier et afficher la carte ainsi que la page de détail.
5. Vérifier image complète, alt, thèmes, sections et question finale.
6. Ajouter une relation vers une Réflexion publiée.
7. Retirer le contenu et vérifier sa disparition des routes, listes et caches.

Cette tranche réduit tôt les risques de modèle, de publication, de rendu et de cache. Elle doit précéder les optimisations secondaires.

## 6. Contrats à préciser dans le plan

- `listPublications` : thème, pagination, limite ; éléments publics et information de suite.
- `getPublicationBySlug` : contenu public complet ou absence ; aucune fuite de brouillon.
- `listReflections` et `getReflectionBySlug` : mêmes garanties adaptées au type.
- `searchContent` : requête validée, résultats typés et ordre déterministe.
- Composition du flux Galerie : GalleryQuestion liée à une Reflection publiée, thèmes dérivés, compteur de publications indépendant des questions, insertion déterministe sans répétition entre lots.
- `getFeaturedContent` : emplacement, date de référence, fallback.
- `getRelatedContent` : cible, limite, suppression des doublons et des contenus non publics.
- `importContent` : validation, transaction, idempotence et résultat lisible.

Les noms sont indicatifs. Le plan doit préciser les types d’entrée/sortie et le comportement en erreur, sans générer une interface abstraite inutile.

## 7. Gabarit de tâche

Pour chaque tâche :

- **Exigence :** identifiant AC ou section de référence.
- **Résultat observable :** ce qui devient possible pour le lecteur ou l’auteur.
- **Prérequis :** décisions, données ou autres tâches nécessaires.
- **Changements :** fichiers réels et responsabilités, une fois le dépôt créé.
- **Validation :** cas nominal, cas limite important et preuve attendue.
- **Fin :** condition explicite permettant de terminer la tâche.

Exemple : « Filtrer la Galerie par thème » est terminé lorsque l’URL partageable restitue le filtre, que changer de thème réinitialise la pagination, que les brouillons sont exclus et que zéro résultat produit un état utile au clavier.

## 8. Stratégie de validation

- Tests unitaires uniquement pour les règles métier significatives.
- Tests d’intégration sur PostgreSQL pour contraintes, imports et visibilité.
- Cas D03 : dry-run sans écriture, import répété sans duplication, échec sans écriture partielle et rejet d’HTML arbitraire.
- Cas D04/D05 : références invalides, exclusivité, auto-relations, doublons, frontières de pagination et retrait d’une Reflection cible.
- Parcours navigateur pour découverte, filtres, recherche, détails et erreurs.
- Revue manuelle pour cadrages, rythme éditorial, compréhension des textes et accessibilité.
- Mesures de performance sur le corpus réaliste, avec conditions consignées.
- Exercice de restauration et publication/retrait en préproduction.

Ne pas confondre données de démonstration et contenus prêts à publier. Les fixtures de pagination doivent dépasser deux lots et inclure des dates identiques.

## 9. Risques à traiter dans l’ordre

| Risque | Mesure de réduction |
|---|---|
| Édition trop pénible | Tester le cycle complet avec Jordani dès L2/L4 |
| Contenu non public exposé | Centraliser la règle de visibilité et tester tous les accès |
| Liens cassés entre types | Foreign keys et contraintes, tests d’intégrité |
| Photos lentes ou recadrées maladroitement | Pipeline sur quelques médias réels avant généralisation |
| Surdimensionnement | Maintenir communauté, IA, CMS et administration hors V1 |
| Roadmap interprétée comme engagement de délai | Estimer seulement après les choix et la première tranche |

## 10. Livrables attendus du futur plan détaillé

1. Références au registre L0 validé et aux décisions D07 et suivantes encore ouvertes.
2. Schéma physique PostgreSQL/Drizzle et stratégie de migrations SQL versionnées.
3. Tâches ordonnées par lots avec fichiers et critères de fin.
4. Jeux de données et scénarios de test.
5. Procédure locale puis de préproduction.
6. Estimations par plage, fondées sur la disponibilité de Jordani et les inconnues résolues.
7. Checklist de recette reliée aux AC01–AC14.

**Le cadrage L0 est suffisamment stabilisé pour préparer maintenant le schéma physique PostgreSQL/Drizzle et le plan d’implémentation détaillé.** Le prochain travail traduit D01–D06 en tables, contraintes, contrats de contenu et tâches vérifiables, puis prépare une tranche verticale complète. Il ne nécessite pas de rouvrir ces décisions. D07 et suivantes restent ouvertes ; les versions exactes, exemples éditoriaux et modalités techniques seront précisés dans le plan.
