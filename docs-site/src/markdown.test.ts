// Рендер Markdown: включения, ссылки, якоря, картинки, блоки.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRenderer, DocsError, pageUrl, resolvePath, type SourceReader } from "./markdown.ts";

function reader(files: Record<string, string>): SourceReader {
  return { read: (f) => files[f] ?? null };
}

describe("pageUrl и resolvePath", () => {
  it("адреса страниц: index — папка, остальное — папка с именем", () => {
    assert.equal(pageUrl("index.md"), "/");
    assert.equal(pageUrl("user/index.md"), "/user/");
    assert.equal(pageUrl("user/navigation.md"), "/user/navigation/");
    assert.equal(pageUrl("architect/import/yaml.md"), "/architect/import/yaml/");
  });

  it("относительный путь — от папки файла, с «/» — от корня, выход за корень — ошибка", () => {
    assert.equal(resolvePath("user/navigation.md", "../_shared/tree.md"), "_shared/tree.md");
    assert.equal(resolvePath("user/navigation.md", "node-page.md"), "user/node-page.md");
    assert.equal(resolvePath("_shared/tree.md", "/images/a.png"), "images/a.png");
    assert.throws(() => resolvePath("user/a.md", "../../x.md"), DocsError);
  });
});

describe("включения", () => {
  it("фрагмент вставляется, его ссылки и картинки считаются от его расположения", () => {
    const r = createRenderer(reader({
      "_shared/tree.md": "## Дерево {#tree}\n\nСм. [импорт](../architect/import.md#yaml) и ![](../images/a.png)\n",
    }));
    const out = r.render("user/nav.md", "Вступление.\n\n<!--@include: ../_shared/tree.md-->\n\n## Поиск\n", "Навигация");
    assert.match(out.html, /<h2 id="tree">Дерево/);
    assert.match(out.html, /href="\/architect\/import\/#yaml"/);
    assert.match(out.html, /src="\/images\/a\.png"/);
    assert.deepEqual(out.includes, ["_shared/tree.md"]);
    assert.deepEqual(out.headings.map((h) => h.id), ["tree", "поиск"]);
    assert.deepEqual(out.links.map((l) => [l.from, l.target, l.hash]), [["_shared/tree.md", "architect/import.md", "yaml"]]);
    assert.deepEqual(out.assets.map((a) => a.target), ["images/a.png"]);
  });

  it("вложенные включения работают, цикл и отсутствующий файл — ошибка", () => {
    const nested = createRenderer(reader({
      "_shared/a.md": "A\n\n<!--@include: ./b.md-->\n",
      "_shared/b.md": "B\n",
    }));
    const out = nested.render("p.md", "<!--@include: _shared/a.md-->\n", "P");
    assert.match(out.html, /<p>A<\/p>\s*<p>B<\/p>/);
    assert.deepEqual(out.includes, ["_shared/a.md", "_shared/b.md"]);

    const loop = createRenderer(reader({
      "_shared/a.md": "<!--@include: ./b.md-->\n",
      "_shared/b.md": "<!--@include: ./a.md-->\n",
    }));
    assert.throws(() => loop.render("p.md", "<!--@include: _shared/a.md-->\n", "P"), /циклическое/);
    assert.throws(() => nested.render("p.md", "<!--@include: _shared/none.md-->\n", "P"), /не найден/);
  });

  it("одинаковые заголовки из фрагмента и страницы получают разные якоря", () => {
    const r = createRenderer(reader({ "_shared/f.md": "## Поиск\n\nво фрагменте\n" }));
    const out = r.render("p.md", "## Поиск\n\nна странице\n\n<!--@include: _shared/f.md-->\n", "P");
    assert.deepEqual(out.headings.map((h) => h.id), ["поиск", "поиск-2"]);
  });
});

describe("ссылки и якоря", () => {
  const r = createRenderer(reader({}));

  it("ссылка на .md становится адресом, внешняя — в новой вкладке, #якорь — на свою страницу", () => {
    const out = r.render("user/a.md", "[б](b.md) [в](../admin/c.md#x) [g](https://example.org) [я](#тут)\n\n## Тут\n", "A");
    assert.match(out.html, /href="\/user\/b\/"/);
    assert.match(out.html, /href="\/admin\/c\/#x"/);
    assert.match(out.html, /href="https:\/\/example\.org" target="_blank" rel="noopener"/);
    assert.deepEqual(out.links.map((l) => [l.target, l.hash]), [["user/b.md", ""], ["admin/c.md", "x"], ["user/a.md", "тут"]]);
  });

  it("явный {#id} и повтор явного якоря — ошибка", () => {
    const out = r.render("p.md", "## Один {#one}\n\n## Два\n", "P");
    assert.match(out.html, /<h2 id="one">Один<a class="h-anchor" href="#one"/);
    assert.deepEqual(out.headings, [{ level: 2, id: "one", text: "Один" }, { level: 2, id: "два", text: "Два" }]);
    assert.throws(() => r.render("p.md", "## A {#x}\n\n## B {#x}\n", "P"), /повторный якорь/);
  });
});

describe("разметка", () => {
  const r = createRenderer(reader({}));

  it("картинка абзацем — figure с подписью из title", () => {
    const out = r.render("p.md", '![Схема](img.png "Подпись")\n', "P");
    assert.match(out.html, /<figure class="fig"><img src="\/img\.png" alt="Схема" loading="lazy"><figcaption>Подпись<\/figcaption><\/figure>/);
  });

  it("блоки ::: и details, незакрытый блок — ошибка", () => {
    const out = r.render("p.md", "::: tip Заголовок\nтекст\n:::\n\n::: warning\nосторожно\n:::\n\n::: details\nскрыто\n:::\n", "P");
    assert.match(out.html, /<div class="callout callout-tip"><p class="callout-title">Заголовок<\/p>\s*<p>текст<\/p>\s*<\/div>/);
    assert.match(out.html, /callout-warning"><p class="callout-title">Внимание<\/p>/);
    assert.match(out.html, /<details class="details"><summary>Подробнее<\/summary>\s*<p>скрыто<\/p>\s*<\/details>/);
    assert.throws(() => r.render("p.md", "::: note\nбез конца\n", "P"), /не закрыт/);
  });

  it("таблица в обёртке, код с подсветкой и языком, кавычки — ёлочки", () => {
    const out = r.render("p.md", '| a | b |\n| - | - |\n| 1 | 2 |\n\n```bash\necho "hi"\n```\n\nСлово "в кавычках".\n', "P");
    assert.match(out.html, /<div class="table-wrap"><table>/);
    assert.match(out.html, /<pre class="hljs" data-lang="bash"><code>.*hljs-/s);
    assert.match(out.html, /«в кавычках»/);
  });

  it("поисковые куски режутся по h2/h3 и несут якорь", () => {
    const out = r.render("p.md", "вводный текст\n\n## Раздел\n\nтело раздела\n\n### Подраздел\n\nещё\n", "Страница");
    assert.deepEqual(out.sections, [
      { heading: "Страница", id: "", text: "вводный текст" },
      { heading: "Раздел", id: "раздел", text: "тело раздела" },
      { heading: "Подраздел", id: "подраздел", text: "ещё" },
    ]);
  });
});
