// Содержимое: обход content/, страницы и руководства, навигация, проверка ссылок и файлов.
//  - Руководство — папка верхнего уровня с index.md (титульная страница); её фронтматтер даёт
//    название, короткое имя (short) и порядок (order).
//  - Страница — любой .md вне папок с «_» в начале; подпапка — раздел навигации (заголовок —
//    из её index.md, если есть). Порядок — order во фронтматтере, затем по названию.
//  - Фрагменты для включений живут в папках с «_» (content/_shared); страницами они не становятся.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fmNumber, fmString, splitFrontMatter } from "./frontmatter.ts";
import { DocsError, pageUrl, type SourceReader } from "./markdown.ts";
import type { Guide, NavItem, Page, Site } from "./types.ts";

function isHidden(name: string): boolean {
  return name.startsWith("_") || name.startsWith(".");
}

function walk(root: string, rel: string, hidden: boolean, out: string[]): void {
  const dir = rel ? join(root, rel) : root;
  for (const name of readdirSync(dir).sort()) {
    const relPath = rel ? `${rel}/${name}` : name;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (isHidden(name) === hidden || (hidden && isHidden(rel.split("/")[0] ?? ""))) walk(root, relPath, hidden, out);
      continue;
    }
    if (!name.endsWith(".md")) continue;
    const underHidden = relPath.split("/").some((seg, i, arr) => i < arr.length - 1 && isHidden(seg));
    if (underHidden === hidden && !(isHidden(name) && !hidden)) out.push(relPath);
  }
}

// Страницы: .md вне «_»-папок
export function listMarkdown(root: string): string[] {
  const out: string[] = [];
  walk(root, "", false, out);
  return out;
}

// Фрагменты: .md внутри «_»-папок
export function listFragments(root: string): string[] {
  const out: string[] = [];
  walk(root, "", true, out);
  return out.filter((f) => f.split("/").some((seg, i, arr) => i < arr.length - 1 && isHidden(seg)));
}

export function makeReader(root: string): SourceReader {
  return {
    read(file) {
      const abs = join(root, file);
      if (!existsSync(abs) || !statSync(abs).isFile()) return null;
      return readFileSync(abs, "utf8");
    },
  };
}

function loadPage(root: string, file: string): Page {
  const src = readFileSync(join(root, file), "utf8");
  let fm: Page["fm"];
  let body: string;
  try {
    ({ fm, body } = splitFrontMatter(src));
  } catch (e) {
    throw new DocsError(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let title = fmString(fm, "title");
  if (title === null) {
    // Без title во фронтматтере — первый «# Заголовок» становится названием и уходит из тела
    const m = /^\s*# (.+)\r?\n/.exec(body);
    if (m) {
      title = m[1].trim();
      body = body.slice(m[0].length);
    } else {
      throw new DocsError(`${file}: нет названия — добавьте «title:» во фронтматтер или «# Заголовок» первой строкой`);
    }
  }
  const slash = file.indexOf("/");
  return {
    file,
    url: pageUrl(file),
    title,
    description: fmString(fm, "description") ?? "",
    order: fmNumber(fm, "order") ?? 1000,
    fm,
    guide: slash < 0 ? null : file.slice(0, slash),
    body,
    render: null,
  };
}

function navOrder(item: NavItem): number {
  return item.kind === "page" ? item.page.order : item.order;
}

function navTitle(item: NavItem): string {
  return item.kind === "page" ? item.page.title : item.title;
}

// Дерево навигации папки prefix («user/», «user/import/») по страницам руководства
export function buildNav(members: Page[], prefix: string): NavItem[] {
  const items: NavItem[] = [];
  const subdirs = new Set<string>();
  for (const p of members) {
    if (!p.file.startsWith(prefix)) continue;
    const rest = p.file.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      if (rest !== "index.md") items.push({ kind: "page", page: p });
    } else {
      subdirs.add(rest.slice(0, slash));
    }
  }
  for (const d of subdirs) {
    const sub = `${prefix}${d}/`;
    const inside = members.filter((p) => p.file.startsWith(sub));
    const index = inside.find((p) => p.file === `${sub}index.md`) ?? null;
    items.push({ kind: "section", title: index?.title ?? d, order: index?.order ?? 1000, index, items: buildNav(inside, sub) });
  }
  items.sort((a, b) => navOrder(a) - navOrder(b) || navTitle(a).localeCompare(navTitle(b), "ru"));
  return items;
}

export function flattenNav(items: NavItem[]): Page[] {
  const out: Page[] = [];
  for (const it of items) {
    if (it.kind === "page") out.push(it.page);
    else {
      if (it.index) out.push(it.index);
      out.push(...flattenNav(it.items));
    }
  }
  return out;
}

// Цепочка разделов, в которых лежит страница (для хлебных крошек)
export function navPath(items: NavItem[], page: Page): Extract<NavItem, { kind: "section" }>[] {
  for (const it of items) {
    if (it.kind !== "section") continue;
    if (it.index === page) return [it];
    const deeper = navPath(it.items, page);
    if (deeper.length || it.items.some((x) => x.kind === "page" && x.page === page)) return [it, ...deeper];
  }
  return [];
}

export function loadSite(root: string): Site {
  const files = listMarkdown(root);
  const pages = files.map((f) => loadPage(root, f));
  const byFile = new Map(pages.map((p) => [p.file, p]));
  const home = byFile.get("index.md");
  if (!home) throw new DocsError("нет content/index.md — главной страницы документации");

  const guides: Guide[] = [];
  for (const p of pages) {
    if (!/^[^/]+\/index\.md$/.test(p.file)) continue;
    const key = p.file.slice(0, p.file.indexOf("/"));
    const members = pages.filter((q) => q.guide === key);
    const nav = buildNav(members, `${key}/`);
    guides.push({
      key,
      title: p.title,
      short: fmString(p.fm, "short") ?? p.title,
      description: p.description,
      order: p.order,
      index: p,
      nav,
      flat: [p, ...flattenNav(nav)],
    });
  }
  guides.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "ru"));
  for (const p of pages) {
    if (p.guide !== null && !guides.some((g) => g.key === p.guide)) {
      throw new DocsError(`${p.file}: в папке ${p.guide}/ нет index.md — руководство без титульной страницы`);
    }
  }
  return { home, guides, pages, byFile };
}

export interface Validation {
  errors: string[];
  warnings: string[];
  assets: Set<string>; // файлы для копирования в сборку (пути от корня content)
}

// После рендера всех страниц: ссылки ведут на существующие страницы и якоря, файлы есть,
// фрагменты кем-то включены
export function validateSite(site: Site, root: string): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const assets = new Set<string>();
  const included = new Set<string>();
  for (const p of site.pages) {
    const r = p.render;
    if (!r) continue;
    for (const inc of r.includes) included.add(inc);
    for (const l of r.links) {
      const target = site.byFile.get(l.target);
      if (!target) {
        const hint = l.target.split("/").some((seg) => seg.startsWith("_"))
          ? " (на фрагменты не ссылаются — только на страницы, куда они включены)"
          : "";
        errors.push(`${l.from}: ссылка на несуществующую страницу «${l.raw}»${hint}`);
        continue;
      }
      if (l.hash && !target.render?.headings.some((h) => h.id === l.hash)) {
        const ids = (target.render?.headings ?? []).map((h) => `#${h.id}`).join(", ") || "нет якорей";
        errors.push(`${l.from}: якорь «#${l.hash}» не найден на странице ${l.target} (есть: ${ids})`);
      }
    }
    for (const a of r.assets) {
      const abs = join(root, a.target);
      if (!existsSync(abs) || !statSync(abs).isFile()) errors.push(`${a.from}: файл не найден — «${a.raw}»`);
      else assets.add(a.target);
    }
  }
  for (const f of listFragments(root)) {
    if (!included.has(f)) warnings.push(`фрагмент ${f} никуда не включён`);
  }
  return { errors, warnings, assets };
}
