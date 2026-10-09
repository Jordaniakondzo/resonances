# Résonances V1 — Checklist éditoriale avant diffusion publique

**Statut : modèle vierge pour usage privé après copie**

**Référence :** [contrat D03 approuvé](../RESONANCES-V1-D03-IMPORT-DESIGN.md), [contrat éditorial](../RESONANCES-V1-EDITORIAL-CONTRACT.md), [spécification V1](../RESONANCES-V1-SPECIFICATION.md)

Cette checklist formalise une **décision humaine extérieure à l'importeur D03**. Le modèle vide peut rester dans ce dépôt public. Les fiches complétées, preuves de droits, justificatifs, éléments confidentiels et identifiants de personnes ne doivent **pas** être ajoutés au dépôt public. Choisir leur support privé avant toute véritable diffusion publique. La complétion de la fiche n'est pas certifiée automatiquement ; un résultat d'import `APPLIED` ne prouve pas que les droits ou la disponibilité ont été vérifiés.

Utiliser une copie privée par contenu et, si nécessaire, une annexe privée par média. Réexaminer la fiche lorsque la version source, le média, la licence ou l'usage prévu change. Cocher seulement ce qui a été effectivement vérifié ; consigner toute réserve avant de prendre la décision finale.

## 1. Identification du contenu

| Champ                   | À renseigner dans la copie privée                                            |
| ----------------------- | ---------------------------------------------------------------------------- |
| Type                    | Publication / Reflection                                                     |
| UUID                    | Identifiant du contenu                                                       |
| Titre                   | Titre de la version examinée                                                 |
| Locale et slug          | Couple de la source destinée à l'import                                      |
| Version source examinée | Référence Git ou autre référence privée précise du document et de ses médias |
| Date de vérification    | Date et fuseau                                                               |
| Responsable éditorial   | Identité conservée uniquement dans le support privé                          |

## 2. Validation éditoriale

- [ ] La version examinée respecte le [contrat éditorial V1](../RESONANCES-V1-EDITORIAL-CONTRACT.md), y compris les champs et sections exigés pour `published`.
- [ ] Le texte a été relu ; l'observation et l'interprétation sont distinguées lorsque le contenu est une Publication.
- [ ] Les citations, références externes et thèmes ont été vérifiés.
- [ ] Le fichier et les références médias destinés à la diffusion correspondent à **la version examinée** ; toute modification ultérieure demande une nouvelle vérification.
- [ ] Le statut, la locale et le slug correspondent à la décision éditoriale ; un UUID déjà importé conserve son couple `(locale, slug)`.
- [ ] Si ce contenu doit être publié plus tard, son slug définitif est fixé **avant le premier import PostgreSQL**. Un brouillon importé avec `slug = null` ne pourra pas devenir `published` sous le même UUID dans cette tranche D03.

## 3. Provenance et droits — répéter pour chaque média affiché

| Champ                            | À renseigner dans la copie privée                                                |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Référence du média               | UUID MediaAsset et usage prévu dans le contenu                                   |
| Origine                          | Création personnelle, génération IA ou source externe, avec référence vérifiable |
| Auteur                           | Auteur identifié lorsque pertinent ; expliquer un cas sans auteur applicable     |
| Licence ou déclaration de droits | Texte exact et lieu privé des justificatifs                                      |
| Attribution                      | Forme et emplacement requis, ou justification de l'absence d'obligation          |
| Traçabilité IA                   | Lieu privé des informations conservées lorsque pertinentes                       |

- [ ] L'origine du média et son auteur, lorsque pertinent, ont été identifiés.
- [ ] Les droits de diffusion ont été vérifiés pour **l'usage prévu** sur Résonances ; un téléchargement possible n'est pas une autorisation.
- [ ] Les conditions de licence et les obligations d'attribution ont été comprises et respectées.
- [ ] Les informations de traçabilité IA pertinentes sont conservées dans un support privé.

## 4. Accessibilité et disponibilité — répéter pour chaque média affiché

- [ ] La description alternative a été relue dans son contexte : elle décrit le visuel plutôt qu'une interprétation philosophique.
- [ ] Le fichier original est effectivement disponible dans l'emplacement autorisé.
- [ ] La variante publique nécessaire est effectivement disponible et lisible ; ses dimensions et son format conviennent à l'usage prévu.
- [ ] Les dimensions connues et les autres caractéristiques du média sont cohérentes avec le rendu attendu. Lorsque le pipeline de diffusion exige des dimensions pour ce rendu, leur disponibilité est vérifiée humainement avant diffusion.

La présence d'une ligne `MediaAsset` et de métadonnées non vides ne certifie ni les droits ni l'existence du fichier. `width` et `height` sont actuellement nullables ; cette vérification humaine n'ajoute pas une contrainte automatique D03 exigeant leur présence. Ces vérifications sont humaines et opérationnelles.

## 5. Contrôle technique D03

- [ ] La version source exacte destinée à l'import a été identifiée et stabilisée ; le dry-run de **cette version** a produit un ImportPlan applicable.
- [ ] Aucun conflit bloquant n'a été ignoré ; `MEDIA_NOT_READY` et `MISSING_REFERENCE` sont absents.
- [ ] Le plan et ses éventuels UPDATE/NOOP ont été relus ; le dry-run n'est ni une réservation ni une autorisation permanente d'écriture.

## 6. Décision humaine avant tout import immédiatement visible

Un `status = published` avec `published_at` déjà atteint peut rendre le contenu public dès le COMMIT. Cela vaut aussi pour l'**UPDATE d'un contenu déjà publié** : sa nouvelle version peut devenir immédiatement visible et exige une autorisation humaine préalable, liée à cette version exacte. Séquence obligatoire dans ces cas : identifier et stabiliser la version source ; exécuter le dry-run ; compléter la revue humaine ; obtenir la décision ci-dessous ; seulement ensuite exécuter l'import transactionnel ; enfin vérifier le résultat et la correspondance de version. Le contrôle après import ne peut pas autoriser rétroactivement une diffusion déjà commencée. Un import en draft reste préparatoire. Un contenu `published` avec une date future peut devenir visible automatiquement **sans nouvel import** : obtenir la décision humaine avant cet import programmé, ou le conserver en draft jusqu'à décision.

Sélectionner un seul état **avant l'import susceptible de rendre le contenu immédiatement visible** dans la copie privée :

- [ ] **EN ATTENTE** — vérifications ou preuves encore nécessaires.
- [ ] **AUTORISÉ POUR DIFFUSION** — contrôles éditoriaux et droits vérifiés pour cette version et cet usage.
- [ ] **REFUSÉ** — diffusion non autorisée ; motifs consignés.

| Champ                                        | À renseigner dans la copie privée |
| -------------------------------------------- | --------------------------------- |
| Date et fuseau de la décision                |                                   |
| Responsable de la décision                   |                                   |
| Réserves                                     |                                   |
| Actions nécessaires, échéance et responsable |                                   |
| Référence privée de la fiche et des preuves  |                                   |

**Condition de diffusion :** seule la décision humaine **AUTORISÉ POUR DIFFUSION**, relative à la version source exacte, permet d'exécuter un import susceptible de la rendre publique immédiatement ou automatiquement à une date future. L'importeur D03 ne lit pas cette fiche, ne la certifie pas et n'ajoute aucun champ `approved` en base. Les responsabilités techniques et permissions sont précisées dans la [politique des écrivains SQL](SQL-WRITER-POLICY.md).

## 7. Contrôle après import

- [ ] Le résultat terminal, **le plan recalculé** et la correspondance avec la version autorisée ont été contrôlés. `APPLIED` signifie seulement que son COMMIT est confirmé ; `UNKNOWN_COMMIT_OUTCOME` exige une vérification de l'état de la base avant toute relance.
- [ ] Tout écart pertinent entre le dry-run et le plan final a été examiné. Ce contrôle de conformité ne constitue jamais une autorisation rétroactive.
