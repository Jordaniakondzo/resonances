-- T3 synthetic dataset: reference bootstrap (Theme and MediaAsset only).
--
-- D03 never creates themes or media assets: they must exist before the
-- editorial import. This file plays the role of the separate, controlled
-- Theme/MediaAsset circuit described in docs/operations/SQL-WRITER-POLICY.md,
-- for an ISOLATED development or test database only.
--
-- It is NOT a schema migration (it lives outside db/migrations and changes no
-- structure) and it is NOT an editorial writer: it never touches publications,
-- reflections, publication_themes or reflection_themes. Editorial content of
-- the dataset goes exclusively through the D03 import
-- (tests/fixtures/t3-dataset/content).
--
-- Every value is synthetic. The URLs use the reserved .test domain and point to
-- no real file. The `source` and `license` values only satisfy the automatic
-- D03 readiness check (non-blank text); they are NOT a legal clearance, a real
-- licence or an authorisation to publish.
--
-- Fixed identifiers: re-running this file on the same database fails on the
-- primary keys and, being one transaction, writes nothing. Use a fresh database.

BEGIN;

INSERT INTO themes (id, locale, name, slug, description) VALUES
  ('73a00000-0000-4000-8000-000000000001', 'fr', 'Confiance', 'confiance',
   'Thème synthétique du jeu de données T3.'),
  ('73a00000-0000-4000-8000-000000000002', 'fr', 'Présence', 'presence',
   'Thème synthétique du jeu de données T3.'),
  ('73a00000-0000-4000-8000-000000000003', 'fr', 'Distance', 'distance',
   'Thème synthétique du jeu de données T3.');

-- Media A: complete metadata, passes the automatic D03 readiness check for a
-- `published` target, and has a web variant so the public views expose it.
INSERT INTO media_assets (
  id, original_filename, original_url, web_url, thumbnail_url,
  alt_text, caption, author, source, license, width, height, mime_type
) VALUES (
  '73b00000-0000-4000-8000-000000000001',
  't3-deux-tasses-original.jpg',
  'https://media.example.test/t3/originals/deux-tasses.jpg',
  'https://media.example.test/t3/web/deux-tasses-1600.webp',
  'https://media.example.test/t3/web/deux-tasses-480.webp',
  'Deux tasses posées côte à côte sur le rebord en bois d’une fenêtre, dans une lumière de fin de journée.',
  'Image synthétique de développement (jeu de données T3).',
  'Jeu de données T3 (synthétique)',
  'Donnée synthétique T3 : aucun fichier image réel n’existe à cette adresse.',
  'Donnée de développement synthétique : aucune licence ni autorisation de diffusion vérifiée.',
  1600, 1067, 'image/jpeg'
);

-- Media B: exists but has incomplete metadata (no alt text, source, licence,
-- web variant or dimensions). D03 accepts it for draft and archived content
-- only; a `published` target referencing it would be MEDIA_NOT_READY.
INSERT INTO media_assets (id, original_filename, original_url, mime_type) VALUES (
  '73b00000-0000-4000-8000-000000000002',
  't3-quai-valise-original.jpg',
  'https://media.example.test/t3/originals/quai-valise.jpg',
  'image/jpeg'
);

COMMIT;
