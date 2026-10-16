// Markdown → HTML: markdown-it с правилами документации.
//  - <!--@include: путь--> — включение фрагмента (единый источник истины): текст пишется один
//    раз в content/_shared и вставляется в любую страницу; ссылки и картинки внутри фрагмента
//    считаются от его собственного расположения, а не от страницы, куда он попал.
//  - Ссылки на страницы — относительными путями к .md (превращаются в адреса и проверяются
//    после сборки всех страниц), якоря — «#id»; заголовки получают id из текста или явный {#id}.
//  - Картинки — относительными путями; подпись — из title: ![alt](путь "подпись").
//  - Блоки ::: note | tip | warning | danger | details (с необязательным заголовком).
import { posix } from "node:path";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type { RenderRule } from "markdown-it/lib/renderer.mjs";
import hljs from "highlight.js/lib/core";
import langBash from "highlight.js/lib/languages/bash";
import langDiff from "highlight.js/lib/languages/diff";
import langDockerfile from "highlight.js/lib/languages/dockerfile";
import langIni from "highlight.js/lib/languages/ini";
import langJavascript from "highlight.js/lib/languages/javascript";
import langJson from "highlight.js/lib/languages/json";
import langNginx from "highlight.js/lib/languages/nginx";
import langPlaintext from "highlight.js/lib/languages/plaintext";
import langPython from "highlight.js/lib/languages/python";
import langSql from "highlight.js/lib/languages/sql";
import langTypescript from "highlight.js/lib/languages/typescript";
import langXml from "highlight.js/lib/languages/xml";
import langYaml from "highlight.js/lib/languages/yaml";
import { splitFrontMatter } from "./frontmatter.ts";
import { escapeHtml } from "./html.ts";
import { SlugSet, slugify } from "./slug.ts";
import type { AssetRef, Heading, LinkRef, RenderResult, SearchSection } from "./types.ts";

// Ошибка содержимого (не программы): сборка перечисляет такие и останавливается
export class DocsError extends Error {}

export interface SourceReader {
  /** Текст файла по пути от корня content или null, если файла нет. */
  read(file: string): string | null;
}

// Окружение одного рендера. Массивы общие для страницы и всех её фрагментов; file и stack
// свои у каждого включения.
interface Env {
  page: string;
  file: string;
  stack: string[];
  headings: Heading[];
  links: LinkRef[];
  assets: AssetRef[];
  includes: string[];
  slugs: SlugSet;
}

function isEnv(v: unknown): v is Env {
  return typeof v === "object" && v !== null && "slugs" in v && "page" in v;
}

const INCLUDE_RE = /^<!--\s*@include:\s*(\S+)\s*-->\s*$/;
const CUSTOM_ID_RE = /\s*\{#([\p{L}\p{N}_-]+)\}\s*$/u;
const CALLOUTS: Record<string, string> = {
  note: "Примечание",
  tip: "Совет",
  warning: "Внимание",
  danger: "Осторожно",
};

for (const [name, lang] of Object.entries({
  bash: langBash, diff: langDiff, dockerfile: langDockerfile, ini: langIni, javascript: langJavascript,
  json: langJson, nginx: langNginx, plaintext: langPlaintext, python: langPython, sql: langSql,
  typescript: langTypescript, xml: langXml, yaml: langYaml,
})) hljs.registerLanguage(name, lang);

// Адрес страницы по пути файла: user/navigation.md → /user/navigation/, user/index.md → /user/
export function pageUrl(file: string): string {
  if (file === "index.md") return "/";
  const noExt = file.replace(/\.md$/, "");
  const path = noExt.endsWith("/index") ? noExt.slice(0, -"/index".length) : noExt;
  return `/${path}/`;
}

// Путь от корня content: относительный — от папки файла base, с «/» — от корня
export function resolvePath(base: string, ref: string): string {
  const clean = ref.replace(/\\/g, "/");
  const joined = clean.startsWith("/")
    ? posix.normalize(clean.slice(1))
    : posix.normalize(posix.join(posix.dirname(base), clean));
  if (joined === ".." || joined.startsWith("../") || posix.isAbsolute(joined)) {
    throw new DocsError(`${base}: путь выходит за пределы content — «${ref}»`);
  }
  return joined;
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

function splitHash(href: string): { path: string; hash: string } {
  const noQuery = href.split("?")[0];
  const i = noQuery.indexOf("#");
  return i < 0 ? { path: noQuery, hash: "" } : { path: noQuery.slice(0, i), hash: noQuery.slice(i + 1) };
}

// markdown-it кодирует кириллицу в адресах (#тут → #%D1%82…): для разбора и проверки
// нужен адрес как написан
function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function inlineText(children: Token[]): string {
  let out = "";
  for (const c of children) {
    if (c.type === "text" || c.type === "code_inline") out += c.content;
    else if (c.type === "softbreak" || c.type === "hardbreak") out += " ";
    else if (c.type === "image") out += inlineText(c.children ?? []);
  }
  return out;
}

function highlight(code: string, info: string): string {
  const name = info.trim().split(/\s+/)[0] ?? "";
  const language = name && hljs.getLanguage(name) ? name : null;
  const inner = language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code);
  const attr = name ? ` data-lang="${escapeHtml(name)}"` : "";
  return `<pre class="hljs"${attr}><code>${inner}</code></pre>\n`;
}

// ── Правило блока: <!--@include: путь--> ────────────────────────────────────────────────
function includeRule(state: StateBlock, startLine: number, silent: boolean, reader: SourceReader): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  if (state.src.charCodeAt(pos) !== 0x3c /* < */) return false;
  const m = INCLUDE_RE.exec(state.src.slice(pos, state.eMarks[startLine]));
  if (!m) return false;
  if (silent) return true;
  const env = state.env as unknown;
  if (!isEnv(env)) throw new DocsError("включение вне контекста страницы");
  const ref = m[1];
  const target = resolvePath(env.file, ref);
  if (env.stack.includes(target)) throw new DocsError(`${env.file}: циклическое включение — «${ref}»`);
  const src = reader.read(target);
  if (src === null) throw new DocsError(`${env.file}: включаемый файл не найден — «${ref}»`);
  env.includes.push(target);
  const childEnv: Env = { ...env, file: target, stack: [...env.stack, target] };
  const tokens: Token[] = [];
  // Только блочный разбор: инлайны, якоря и ссылки доделает общий проход по странице;
  // чей это текст, помечает meta.file — от него считаются относительные пути фрагмента.
  state.md.block.parse(splitFrontMatter(src).body, state.md, childEnv, tokens);
  for (const t of tokens) {
    const meta: Record<string, unknown> = typeof t.meta === "object" && t.meta !== null ? t.meta : {};
    if (meta.file === undefined) t.meta = { ...meta, file: target };
  }
  state.tokens.push(...tokens);
  state.line = startLine + 1;
  return true;
}

function fileOf(token: Token, fallback: string): string {
  const meta: unknown = token.meta;
  if (typeof meta === "object" && meta !== null && "file" in meta && typeof meta.file === "string") return meta.file;
  return fallback;
}

// ── Правила ядра ────────────────────────────────────────────────────────────────────────
// «## Заголовок {#id}» → явный якорь (до разбора инлайнов, чтобы «{#id}» не попал в текст)
function customIdRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i + 1 < tokens.length; i++) {
    const open = tokens[i];
    const inline = tokens[i + 1];
    if (open.type !== "heading_open" || inline.type !== "inline") continue;
    const m = CUSTOM_ID_RE.exec(inline.content);
    if (!m) continue;
    inline.content = inline.content.slice(0, m.index);
    open.attrSet("id", m[1]);
  }
}

// Якоря заголовков, список заголовков страницы, ссылка «#» у каждого
function headingsRule(state: StateCore): void {
  const env: unknown = state.env;
  if (!isEnv(env)) return;
  const tokens = state.tokens;
  for (let i = 0; i + 1 < tokens.length; i++) {
    const open = tokens[i];
    const inline = tokens[i + 1];
    if (open.type !== "heading_open" || inline.type !== "inline") continue;
    const text = inlineText(inline.children ?? []);
    let id = open.attrGet("id");
    if (id !== null) {
      if (!env.slugs.add(id)) throw new DocsError(`${fileOf(inline, env.page)}: повторный якорь {#${id}} на странице ${env.page}`);
    } else {
      id = env.slugs.take(slugify(text));
      open.attrSet("id", id);
    }
    env.headings.push({ level: Number(open.tag.slice(1)), id, text });
    const anchor = new state.Token("html_inline", "", 0);
    anchor.content = `<a class="h-anchor" href="#${escapeHtml(id)}" aria-label="Ссылка на раздел">#</a>`;
    inline.children = [...(inline.children ?? []), anchor];
  }
}

// Ссылки и картинки: относительные пути → адреса, внешние — в новой вкладке
function linksRule(state: StateCore): void {
  const env: unknown = state.env;
  if (!isEnv(env)) return;
  for (const t of state.tokens) {
    if (t.type !== "inline" || !t.children) continue;
    const base = fileOf(t, env.file);
    for (const c of t.children) {
      if (c.type === "link_open") {
        const href = c.attrGet("href");
        if (href !== null) resolveLink(c, decodeHref(href), base, env);
      } else if (c.type === "image") {
        const src = c.attrGet("src");
        if (src !== null && !isExternal(src)) {
          const target = resolvePath(base, decodeHref(src));
          env.assets.push({ from: base, target, raw: src });
          c.attrSet("src", `/${target}`);
        }
      }
    }
  }
}

function resolveLink(token: Token, href: string, base: string, env: Env): void {
  if (isExternal(href)) {
    if (/^https?:/i.test(href) || href.startsWith("//")) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener");
    }
    return;
  }
  if (href.startsWith("#")) {
    env.links.push({ page: env.page, from: base, target: env.page, hash: href.slice(1), raw: href });
    return;
  }
  const { path, hash } = splitHash(href);
  const target = resolvePath(base, path);
  if (target.endsWith(".md")) {
    env.links.push({ page: env.page, from: base, target, hash, raw: href });
    token.attrSet("href", pageUrl(target) + (hash ? `#${hash}` : ""));
  } else {
    env.assets.push({ from: base, target, raw: href });
    token.attrSet("href", `/${target}`);
  }
}

// Абзац из одной картинки → <figure>, подпись из title → <figcaption>
function figuresRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const open = tokens[i];
    const inline = tokens[i + 1];
    const close = tokens[i + 2];
    if (open.type !== "paragraph_open" || inline.type !== "inline" || close.type !== "paragraph_close") continue;
    const kids = inline.children ?? [];
    if (kids.length !== 1 || kids[0].type !== "image") continue;
    open.tag = "figure";
    close.tag = "figure";
    open.attrJoin("class", "fig");
    const img = kids[0];
    const title = img.attrGet("title");
    if (title) {
      img.attrs = (img.attrs ?? []).filter(([k]) => k !== "title");
      const cap = new state.Token("html_inline", "", 0);
      cap.content = `<figcaption>${escapeHtml(title)}</figcaption>`;
      inline.children = [img, cap];
    }
  }
}

const imageRender: RenderRule = (tokens, idx, options, env, self) => {
  const t = tokens[idx];
  t.attrSet("alt", self.renderInlineAsText(t.children ?? [], options, env));
  t.attrSet("loading", "lazy");
  return self.renderToken(tokens, idx, options);
};

// ── Правило блока: ::: note | tip | warning | danger | details [заголовок] … ::: ──────────
const CONTAINER_RE = /^:::\s*(note|tip|warning|danger|details)\b[ \t]*(.*)$/;

function containerRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  if (state.src.charCodeAt(pos) !== 0x3a /* : */) return false;
  const m = CONTAINER_RE.exec(state.src.slice(pos, state.eMarks[startLine]));
  if (!m) return false;
  if (silent) return true;
  const kind = m[1];
  const title = m[2].trim();
  let nextLine = startLine;
  let closed = false;
  while (++nextLine < endLine) {
    if (state.sCount[nextLine] < state.blkIndent) break;
    const p = state.bMarks[nextLine] + state.tShift[nextLine];
    if (state.src.slice(p, state.eMarks[nextLine]).trim() === ":::") {
      closed = true;
      break;
    }
  }
  if (!closed) {
    const env: unknown = state.env;
    const file = isEnv(env) ? env.file : "?";
    throw new DocsError(`${file}: блок «::: ${kind}» не закрыт — нужна строка «:::» после него`);
  }
  const open = state.push("docs_container_open", "div", 1);
  open.info = kind;
  open.content = title;
  open.map = [startLine, nextLine];
  open.block = true;
  const oldLineMax = state.lineMax;
  state.lineMax = nextLine;
  state.md.block.tokenize(state, startLine + 1, nextLine);
  state.lineMax = oldLineMax;
  const close = state.push("docs_container_close", "div", -1);
  close.info = kind;
  close.block = true;
  state.line = nextLine + 1;
  return true;
}

const containerOpenRender: RenderRule = (tokens, idx) => {
  const t = tokens[idx];
  if (t.info === "details") {
    return `<details class="details"><summary>${escapeHtml(t.content || "Подробнее")}</summary>\n`;
  }
  const title = t.content || CALLOUTS[t.info];
  return `<div class="callout callout-${t.info}"><p class="callout-title">${escapeHtml(title)}</p>\n`;
};

const containerCloseRender: RenderRule = (tokens, idx) =>
  tokens[idx].info === "details" ? "</details>\n" : "</div>\n";

// Поисковый индекс: текст страницы кусками по заголовкам h2/h3
function extractSections(tokens: Token[], pageTitle: string): SearchSection[] {
  const sections: SearchSection[] = [];
  let cur: SearchSection = { heading: pageTitle, id: "", text: "" };
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    if (text || cur.id) sections.push({ ...cur, text: text.slice(0, 5000) });
    buf = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open" && (t.tag === "h2" || t.tag === "h3")) {
      flush();
      const inline = tokens[i + 1];
      cur = {
        heading: inline?.type === "inline" ? inlineText(inline.children ?? []) : "",
        id: t.attrGet("id") ?? "",
        text: "",
      };
      i += 2;
      continue;
    }
    if (t.type === "inline") buf.push(inlineText(t.children ?? []));
    else if (t.type === "fence" || t.type === "code_block") buf.push(t.content);
  }
  flush();
  return sections;
}

export interface Renderer_ {
  render(file: string, body: string, title: string): RenderResult;
}

export function createRenderer(reader: SourceReader): Renderer_ {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true, quotes: "«»„“", highlight });
  md.block.ruler.before(
    "html_block",
    "docs_include",
    (state, startLine, _endLine, silent) => includeRule(state, startLine, silent, reader),
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
  md.block.ruler.before("fence", "docs_container", containerRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.core.ruler.before("inline", "docs_custom_id", customIdRule);
  md.core.ruler.push("docs_headings", headingsRule);
  md.core.ruler.push("docs_links", linksRule);
  md.core.ruler.push("docs_figures", figuresRule);
  md.renderer.rules.docs_container_open = containerOpenRender;
  md.renderer.rules.docs_container_close = containerCloseRender;
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
  md.renderer.rules.table_close = () => "</table></div>";
  md.renderer.rules.image = imageRender;

  return {
    render(file, body, title) {
      const env: Env = {
        page: file, file, stack: [file],
        headings: [], links: [], assets: [], includes: [], slugs: new SlugSet(),
      };
      const tokens = md.parse(body, env);
      const html = md.renderer.render(tokens, md.options, env);
      return {
        html,
        headings: env.headings,
        sections: extractSections(tokens, title),
        links: env.links,
        assets: env.assets,
        includes: env.includes,
      };
    },
  };
}
