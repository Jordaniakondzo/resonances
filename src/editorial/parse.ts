import { parseDocument } from "yaml";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";
import {
  ContentValidationError,
  type ParsedContent,
  type ParsedBase,
} from "./types.js";

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sections = ["Observation", "Évocation", "Réflexion", "Question ouverte"];

function hasEditorialContent(node: Root | RootContent): boolean {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value.trim().length > 0;
    case "root":
    case "paragraph":
    case "blockquote":
    case "list":
    case "listItem":
    case "emphasis":
    case "strong":
    case "link":
    case "linkReference":
      return node.children.some(hasEditorialContent);
    default:
      // Headings and other structural nodes do not contribute editorial content.
      return false;
  }
}

export function parseContent(input: string, file: string): ParsedContent {
  const fail = (field: string, message: string): never => {
    throw new ContentValidationError(file, field, message);
  };
  if (input.length > 1_000_000)
    fail("file", "Document trop volumineux (maximum 1 000 000 caractères).");
  const source = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (source.includes("\0")) fail("file", "Caractère NUL interdit.");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
  if (!match)
    fail("frontmatter", "Délimiteurs YAML --- requis en tête du document.");
  let raw: unknown;
  try {
    const doc = parseDocument(match![1]!, { schema: "core", uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length)
      fail("YAML", "YAML invalide, clé dupliquée ou tag non autorisé.");
    raw = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ContentValidationError) throw error;
    fail("YAML", "Alias ou structure YAML non autorisée.");
  }
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail(field, "Objet attendu.");
    return value as Record<string, unknown>;
  };
  const data = object(raw, "frontmatter");
  const kind = data.type;
  if (kind !== "publication" && kind !== "reflection")
    fail("type", "publication ou reflection requis.");
  const normalizedPath = file.replaceAll("\\", "/");
  if (
    !normalizedPath.endsWith(".md") ||
    normalizedPath.split("/").includes("..") ||
    !normalizedPath.match(new RegExp(`(?:^|/)content/${kind}s/[^/]+\\.md$`))
  )
    fail(
      "type",
      "Le type doit correspondre au répertoire content et à un fichier .md direct.",
    );
  const keys = [
    "type",
    "id",
    "locale",
    "status",
    "slug",
    "title",
    "published_at",
    "themes",
    ...(kind === "publication"
      ? ["hook", "media"]
      : ["excerpt", "cover_media"]),
  ];
  for (const key of Object.keys(data))
    if (!keys.includes(key)) fail(key, "Clé inconnue.");
  const text = (
    value: unknown,
    field: string,
    required = false,
  ): string | null => {
    if (value === undefined || value === null) {
      if (required) fail(field, "Valeur requise.");
      return null;
    }
    if (typeof value !== "string") return fail(field, "Chaîne attendue.");
    const result = value.trim();
    if (!result)
      return fail(field, "Valeur vide ; utiliser null pour un champ absent.");
    return result;
  };
  const uuid = (value: unknown, field: string): string => {
    const result = text(value, field, true)!;
    if (!uuidPattern.test(result))
      fail(field, "UUID canonique version 1 à 8 requis.");
    return result.toLowerCase();
  };
  const id = uuid(data.id, "id");
  const localeInput = text(data.locale, "locale", true)!;
  let locale: string;
  try {
    locale = Intl.getCanonicalLocales(localeInput)[0]!;
  } catch {
    return fail("locale", "Tag de langue invalide.");
  }
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale))
    fail("locale", "Tag de langue non pris en charge.");
  const status = data.status;
  if (status !== "draft" && status !== "published" && status !== "archived")
    return fail("status", "Statut invalide.");
  const published = status === "published";
  const slug = text(data.slug, "slug", published);
  if (slug && !slugPattern.test(slug))
    fail("slug", "Minuscules ASCII, chiffres et tirets requis.");
  const title = text(data.title, "title", published);
  const timestamp = text(data.published_at, "published_at", published);
  let publishedAt: Date | null = null;
  if (timestamp) {
    const parts =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(
        timestamp,
      );
    if (!parts)
      fail(
        "published_at",
        "Date ISO avec heure, secondes et fuseau explicites requise.",
      );
    const [, y, m, d, h, min, sec, , oh, om] = parts!;
    const year = Number(y),
      month = Number(m),
      day = Number(d);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
      year < 1 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > days[month - 1]! ||
      Number(h) > 23 ||
      Number(min) > 59 ||
      Number(sec) > 59 ||
      Number(oh ?? 0) > 23 ||
      Number(om ?? 0) > 59
    )
      fail("published_at", "Date ou fuseau impossible.");
    publishedAt = new Date(timestamp);
    if (!Number.isFinite(publishedAt.getTime()))
      fail("published_at", "Date invalide.");
  }
  const themeInput = data.themes ?? [];
  if (!Array.isArray(themeInput)) fail("themes", "Liste attendue.");
  const themeSlugs = [
    ...new Set(
      (themeInput as unknown[]).map((value) => {
        const slug = text(value, "themes", true)!;
        if (!slugPattern.test(slug)) fail("themes", "Slug de thème invalide.");
        return slug;
      }),
    ),
  ].sort();
  if (published && !themeSlugs.length)
    fail("themes", "Au moins un thème requis.");
  const mediaId = (
    value: unknown,
    field: string,
    required: boolean,
  ): string | null => {
    if (value === undefined || value === null) {
      if (required) fail(field, "Média principal requis.");
      return null;
    }
    const ref = object(value, field);
    for (const key of Object.keys(ref))
      if (key !== "id") fail(`${field}.${key}`, "Clé inconnue.");
    return uuid(ref.id, `${field}.id`);
  };
  const body = source.slice(match![0].length).trim();
  const tree = fromMarkdown(body);
  const validateNode = (node: Root | RootContent): void => {
    if (node.type === "html") fail("Markdown", "HTML brut interdit.");
    if (node.type === "image" || node.type === "imageReference")
      fail(
        "Markdown",
        "Les images du corps sont différées ; utiliser une référence média.",
      );
    if (node.type === "link" || node.type === "definition") {
      const url = node.url;
      if (
        /[\u0000-\u0020\u007f\\]/.test(url) ||
        !(
          /^https?:\/\//i.test(url) ||
          /^mailto:/i.test(url) ||
          /^\/(?!\/)/.test(url) ||
          /^#/.test(url)
        )
      )
        fail("Markdown", "URL non autorisée.");
    }
    if ("children" in node)
      for (const child of node.children) validateNode(child as RootContent);
  };
  validateNode(tree);
  for (const field of ["title", "hook", "excerpt"]) {
    if (typeof data[field] === "string")
      validateNode(fromMarkdown(data[field]));
  }
  const common: ParsedBase = {
    id,
    locale,
    status,
    slug,
    title,
    publishedAt,
    themeSlugs,
  };
  if (kind === "reflection") {
    const excerpt = text(data.excerpt, "excerpt", published);
    if (published && !hasEditorialContent(tree))
      fail("content", "Corps Markdown requis.");
    return {
      ...common,
      type: "reflection",
      excerpt,
      coverMediaId: mediaId(data.cover_media, "cover_media", false),
      content: body || null,
    };
  }
  const hook = text(data.hook, "hook", published);
  const mediaAssetId = mediaId(data.media, "media", published);
  const values: (string | null)[] = [null, null, null, null];
  let previous = -1;
  const headings = tree.children.filter(
    (node) => node.type === "heading" && node.depth <= 2,
  );
  if (body && (!headings.length || headings[0]!.position!.start.offset !== 0))
    fail("section", "Le corps commence par une section éditoriale.");
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    if (heading.type !== "heading") continue;
    const label =
      heading.children.length === 1 && heading.children[0]!.type === "text"
        ? heading.children[0]!.value.normalize("NFC")
        : "";
    const index = sections.indexOf(label);
    if (heading.depth !== 2 || index < 0)
      fail(
        "section",
        "Section inconnue ; utiliser les quatre titres H2 du contrat.",
      );
    if (index <= previous)
      fail(label, "Section dupliquée ou dans le mauvais ordre.");
    previous = index;
    const end = headings[i + 1]?.position?.start.offset ?? body.length;
    const start = heading.position!.end.offset!;
    values[index] = body.slice(start, end).trim() || null;
    // A section is stored independently, so reference definitions must stay local.
    const nodes = tree.children.filter(
      (n) =>
        n.position!.start.offset! >= start && n.position!.start.offset! < end,
    );
    if (published && !nodes.some(hasEditorialContent))
      fail(label, "Section sans contenu éditorial.");
    const definitions = new Set(
      nodes.filter((n) => n.type === "definition").map((n) => n.identifier),
    );
    const checkReference = (node: RootContent): void => {
      if (node.type === "linkReference" && !definitions.has(node.identifier))
        fail("section", "Définition de lien requise dans la même section.");
      if ("children" in node)
        for (const child of node.children) checkReference(child as RootContent);
    };
    for (const node of nodes) checkReference(node);
  }
  for (let i = 0; i < sections.length; i++)
    if (published && !values[i]) fail(sections[i]!, "Section requise.");
  return {
    ...common,
    type: "publication",
    hook,
    mediaAssetId,
    observation: values[0]!,
    evocation: values[1]!,
    reflection: values[2]!,
    openQuestion: values[3]!,
  };
}
