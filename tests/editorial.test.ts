import assert from "node:assert/strict";
import { test } from "node:test";
import { parseContent } from "../src/editorial/parse.js";

const id = "8e8e0be8-49a4-4dbc-9a39-35d475f06a82";
const media = "683b7c85-bf50-4cb6-909f-ce96ef39d79d";
const path = "content/publications/example.md";
function document(type = "publication", extra = "", body = "") {
  return `---\ntype: ${type}\nid: ${id}\nlocale: fr\nstatus: draft\n${extra}\n---\n${body}`;
}
const body =
  "## Observation\n\nUne table.\n\n## Évocation\n\nUne **distance** possible.\n\n## Réflexion\n\n### Nuance\n\nUn lien.\n\n## Question ouverte\n\nQue reste-t-il ?";
const published = document(
  "publication",
  `slug: un-lien\ntitle: Un lien\nhook: Une présence\nthemes: [presence, confiance, presence]\nmedia:\n  id: ${media}\npublished_at: 2099-01-01T12:00:00+03:00`,
  body,
).replace("status: draft", "status: published");
for (const type of ["publication", "reflection"]) {
  test(`${type}: minimal draft accepts missing editorial fields`, () => {
    const result = parseContent(document(type), `content/${type}s/example.md`);
    assert.equal(result.id, id);
    assert.equal(result.status, "draft");
    assert.equal(result.title, null);
    assert.equal(result.publishedAt, null);
    assert.deepEqual(result.themeSlugs, []);
  });
}
test("published publication maps sections and normalizes future date and theme set", () => {
  const result = parseContent(published, path);
  assert.equal(result.type, "publication");
  if (result.type !== "publication") throw new Error("Wrong type");
  assert.equal(result.observation, "Une table.");
  assert.equal(result.evocation, "Une **distance** possible.");
  assert.equal(result.reflection, "### Nuance\n\nUn lien.");
  assert.equal(result.openQuestion, "Que reste-t-il ?");
  assert.equal(result.mediaAssetId, media);
  assert.equal(result.publishedAt?.toISOString(), "2099-01-01T09:00:00.000Z");
  assert.deepEqual(result.themeSlugs, ["confiance", "presence"]);
});
test("identity survives file rename, title and slug changes", () => {
  assert.equal(
    parseContent(
      published
        .replace("un-lien", "autre-lien")
        .replace("title: Un lien", "title: Autre"),
      "content/publications/renamed.md",
    ).id,
    id,
  );
});
test("reflection allows free headings and no cover", () => {
  const input = document(
    "reflection",
    "title: Une idée\nslug: une-idee\nexcerpt: Un résumé\nthemes: [presence]\npublished_at: 2026-09-28T12:00:00Z",
    "# Une idée\n\n## Une nuance\n\nTexte.",
  ).replace("status: draft", "status: published");
  const result = parseContent(input, "content/reflections/example.md");
  if (result.type !== "reflection") throw new Error("Wrong type");
  assert.equal(result.content, "# Une idée\n\n## Une nuance\n\nTexte.");
  assert.equal(result.coverMediaId, null);
});
const badCases: [string, string, RegExp][] = [
  ["invalid UUID", document().replace(id, "bad"), /id/],
  ["unknown key", document("publication", "themse: []"), /themse/],
  [
    "unknown nested key",
    document("publication", `media: {id: ${media}, url: x}`),
    /url/,
  ],
  ["duplicate YAML key", document("publication", "status: published"), /YAML/],
  ["custom YAML tag", document("publication", "title: !custom Hello"), /YAML/],
  ["YAML alias", document("publication", "title: &x Hello\nhook: *x"), /YAML/],
  ["invalid draft slug", document("publication", "slug: Wrong Slug"), /slug/],
  [
    "invalid locale",
    document().replace("locale: fr", "locale: fr_FR"),
    /locale/,
  ],
  [
    "unknown status",
    document().replace("status: draft", "status: pending"),
    /status/,
  ],
  [
    "missing date",
    published.replace("published_at: 2099-01-01T12:00:00+03:00", ""),
    /published_at/,
  ],
  [
    "invalid calendar date",
    published.replace("2099-01-01T12:00:00+03:00", "2026-02-30T12:00:00Z"),
    /published_at/,
  ],
  [
    "ambiguous date",
    published.replace("2099-01-01T12:00:00+03:00", "2099-01-01"),
    /published_at/,
  ],
  [
    "no themes",
    published.replace("themes: [presence, confiance, presence]", "themes: []"),
    /themes/,
  ],
  ["no media", published.replace(`media:\n  id: ${media}`, ""), /media/],
  ["empty title", published.replace("title: Un lien", 'title: ""'), /title/],
  [
    "missing section",
    published.replace("## Question ouverte\n\nQue reste-t-il ?", ""),
    /Question ouverte/,
  ],
  ["duplicate section", published + "\n## Observation\nTexte", /Observation/],
  ["unknown section", published + "\n## Autre\nTexte", /section/],
  [
    "preamble",
    published.replace("## Observation", "Préambule\n\n## Observation"),
    /section/,
  ],
  [
    "HTML",
    document("publication", "", "## Observation\n<script>alert(1)</script>"),
    /HTML/,
  ],
  [
    "inline HTML",
    document("publication", "", "## Observation\nTexte <b>gras</b>"),
    /HTML/,
  ],
  [
    "unsafe link",
    document(
      "publication",
      "",
      "## Observation\n[lien](javascript:alert%281%29)",
    ),
    /URL/,
  ],
  [
    "encoded unsafe link",
    document(
      "publication",
      "",
      "## Observation\n[lien](jav&#x61;script:alert%281%29)",
    ),
    /URL/,
  ],
  [
    "unsafe reference",
    document(
      "publication",
      "",
      "## Observation\n[lien][x]\n\n[x]: data:text/html,bad",
    ),
    /URL/,
  ],
  [
    "inline image",
    document(
      "publication",
      "",
      "## Observation\n![image](https://example.org/image.jpg)",
    ),
    /image/,
  ],
];
for (const [label, input, error] of badCases)
  test(`rejects ${label}`, () =>
    assert.throws(() => parseContent(input, path), error));
test("rejects type inconsistent with directory", () =>
  assert.throws(() => parseContent(document("reflection"), path), /type/));
test("published reflection requires content and excerpt", () => {
  const input = document(
    "reflection",
    "title: T\nslug: t\nexcerpt: E\nthemes: [presence]\npublished_at: 2026-01-01T00:00:00Z",
  ).replace("status: draft", "status: published");
  assert.throws(
    () => parseContent(input, "content/reflections/a.md"),
    /content/,
  );
  assert.throws(
    () =>
      parseContent(
        input.replace("excerpt: E", "") + "\nTexte",
        "content/reflections/a.md",
      ),
    /excerpt/,
  );
});
test("code examples are inert and do not create sections or HTML nodes", () => {
  const result = parseContent(
    document(
      "publication",
      "",
      "## Observation\n\n```html\n<script>x</script>\n## Évocation\n```\n\n[Source](https://example.org)",
    ),
    path,
  );
  if (result.type !== "publication") throw new Error("Wrong type");
  assert.match(result.observation!, /<script>/);
  assert.equal(result.evocation, null);
});
test("archived content can remain incomplete", () =>
  assert.equal(
    parseContent(document().replace("status: draft", "status: archived"), path)
      .status,
    "archived",
  ));
test("BOM and Windows line endings normalize consistently", () =>
  assert.deepEqual(
    parseContent("\uFEFF" + published.replaceAll("\n", "\r\n"), path),
    parseContent(published, path),
  ));
test("section containing only a separator is not publishable", () =>
  assert.throws(
    () => parseContent(published.replace("Une table.", "---"), path),
    /Observation/,
  ));
test("reference definitions cannot silently disappear when sections are stored separately", () => {
  assert.throws(
    () =>
      parseContent(
        published
          .replace("Une table.", "[source][x]")
          .replace("Un lien.", "Un lien.\n\n[x]: https://example.org"),
        path,
      ),
    /section/,
  );
  const input = published.replace(
    "Une table.",
    "[source][x]\n\n[x]: https://example.org",
  );
  const result = parseContent(input, path);
  if (result.type === "publication")
    assert.match(result.observation!, /\[x\]: https/);
});
for (const bad of [
  "2026-13-01T00:00:00Z",
  "2026-01-00T00:00:00Z",
  "2026-01-01T24:00:00Z",
  "2026-01-01T00:00:00+24:00",
]) {
  test(`rejects impossible timestamp ${bad}`, () =>
    assert.throws(
      () =>
        parseContent(published.replace("2099-01-01T12:00:00+03:00", bad), path),
      /published_at/,
    ));
}
test("requires frontmatter and rejects wrong scalar types", () => {
  assert.throws(() => parseContent("# Texte", path), /frontmatter/);
  assert.throws(
    () => parseContent(document("publication", "title: 42"), path),
    /title/,
  );
  assert.throws(
    () => parseContent(document("publication", "themes: presence"), path),
    /themes/,
  );
  assert.throws(
    () => parseContent(document("publication", "media: {}"), path),
    /media.id/,
  );
});
test("normalizes UUID case and locale without choosing a public language policy", () => {
  const result = parseContent(
    document()
      .replace(id, id.toUpperCase())
      .replace("locale: fr", "locale: FR-ca"),
    path,
  );
  assert.equal(result.id, id);
  assert.equal(result.locale, "fr-CA");
});

test("repository examples are valid synthetic drafts", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of [
    "content/publications/exemple.md",
    "content/reflections/exemple.md",
  ]) {
    assert.equal(
      parseContent(await readFile(file, "utf8"), file).status,
      "draft",
    );
  }
});

const reflectionPath = "content/reflections/example.md";
function publishedReflection(content: string) {
  return document(
    "reflection",
    "title: T\nslug: t\nexcerpt: E\nthemes: [presence]\npublished_at: 2026-01-01T00:00:00Z",
    content,
  ).replace("status: draft", "status: published");
}

for (const [section, content] of [
  ["Observation", "Une table."],
  ["Évocation", "Une **distance** possible."],
  ["Réflexion", "### Nuance\n\nUn lien."],
  ["Question ouverte", "Que reste-t-il ?"],
]) {
  test(`published publication rejects heading-only ${section}`, () => {
    assert.throws(
      () => parseContent(published.replace(content!, "### À développer"), path),
      (error: unknown) =>
        error instanceof Error && error.message.includes(section!),
    );
  });
}

for (const [label, content] of [
  ["headings", "# Titre\n\n## Nuance\n\n### À développer"],
  ["structure and definitions", "# Titre\n\n---\n\n[x]: https://example.org"],
  ["heading inside quote", "> ### À développer"],
  ["heading inside list", "- ### À développer"],
  ["empty code", "```text\n   \n```"],
  ["empty link label", "[](https://example.org)"],
]) {
  test(`published reflection rejects only ${label}`, () => {
    assert.throws(
      () => parseContent(publishedReflection(content!), reflectionPath),
      /content/,
    );
  });
}

for (const [label, content] of [
  ["heading and prose", "### Nuance\n\nUne présence."],
  ["quotation", "> Une présence."],
  ["list", "- Une présence."],
  ["emphasis", "**Une présence.**"],
  ["inline code", "`présence`"],
  ["code block", "```html\n<script>example</script>\n## Évocation\n```"],
  ["local reference link", "[source][x]\n\n[x]: https://example.org"],
]) {
  test(`substantive ${label} remains publishable and preserved for both types`, () => {
    const publication = parseContent(
      published.replace("Une table.", content!),
      path,
    );
    assert.equal(publication.type, "publication");
    if (publication.type !== "publication") throw new Error("Wrong type");
    assert.equal(publication.observation, content);
    assert.equal(publication.evocation, "Une **distance** possible.");
    const reflection = parseContent(
      publishedReflection(content!),
      reflectionPath,
    );
    assert.equal(reflection.type, "reflection");
    if (reflection.type !== "reflection") throw new Error("Wrong type");
    assert.equal(reflection.content, content);
  });
}

test("heading-only drafts and archives remain editable for both types", () => {
  for (const status of ["draft", "archived"]) {
    for (const type of ["publication", "reflection"]) {
      const input = document(
        type,
        "",
        "## Observation\n\n### À développer",
      ).replace("status: draft", `status: ${status}`);
      assert.equal(
        parseContent(input, `content/${type}s/example.md`).status,
        status,
      );
    }
  }
});
