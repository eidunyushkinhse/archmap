// Подготовка сайта (чтение, рендер, проверка) и запись статики в dist/. Общее для CLI
// сборки (build.ts) и сервера (server.ts): сервер пересобирает dist/ после каждой правки
// автора и при изменении файлов на диске.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listFragments, loadSite, makeReader, validateSite } from "./content.ts";
import { createRenderer, DocsError } from "./markdown.ts";
import { renderNotFound, renderPage, type Assets } from "./render.ts";
import type { Page, Site } from "./types.ts";

export interface Prepared {
  site: Site;
  errors: string[];
  warnings: string[];
  assets: Set<string>; // файлы из content/, на которые есть ссылки (копируются в dist)
}

// Читает content/, рендерит все страницы, проверяет ссылки. Ошибки содержимого собираются
// в список (страница с ошибкой рендерится плашкой); структурная ошибка (нет index.md,
// страница без названия) — исключение DocsError.
export function prepareSite(contentDir: string): Prepared {
  const errors: string[] = [];
  const warnings: string[] = [];
  const site = loadSite(contentDir);
  const renderer = createRenderer(makeReader(contentDir));
  for (const p of site.pages) {
    try {
      p.render = renderer.render(p.file, p.body, p.title);
    } catch (e) {
      if (!(e instanceof DocsError)) throw e;
      errors.push(e.message);
      p.render = {
        html: `<div class="callout callout-danger"><p class="callout-title">Ошибка сборки</p><p>${e.message.replace(/</g, "&lt;")}</p></div>`,
        headings: [], sections: [], links: [], assets: [], includes: [],
      };
    }
  }
  const v = validateSite(site, contentDir);
  errors.push(...v.errors);
  warnings.push(...v.warnings);
  return { site, errors, warnings, assets: v.assets };
}

function stamp(buf: Buffer | string): string {
  return createHash("sha1").update(buf).digest("hex").slice(0, 8);
}

function searchIndex(site: Site): string {
  const docs: { id: number; url: string; guide: string; title: string; heading: string; text: string }[] = [];
  for (const p of site.pages) {
    const guide = site.guides.find((g) => g.key === p.guide);
    for (const s of p.render?.sections ?? []) {
      docs.push({
        id: docs.length,
        url: p.url + (s.id ? `#${s.id}` : ""),
        guide: guide?.short ?? "",
        title: p.title,
        heading: s.id ? s.heading : "",
        text: s.text,
      });
    }
  }
  return JSON.stringify(docs);
}

// Статика темы с версией в адресе (кэш браузера сбрасывается при любой правке файла)
function writeAssets(outDir: string, themeDir: string, searchJson: string): Assets {
  const assetsDir = join(outDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const put = (name: string, content: Buffer | string): string => {
    writeFileSync(join(assetsDir, name), content);
    return `/assets/${name}?v=${stamp(content)}`;
  };
  const theme = (name: string) => readFileSync(join(themeDir, name));
  const css = put("docs.css", theme("docs.css"));
  const hljs = put("hljs.css", theme("hljs.css"));
  const js = put("docs.js", theme("docs.js"));
  const editorCss = put("editor.css", theme("editor.css"));
  const editorJs = put("editor.js", theme("editor.js"));
  put("minisearch.js", readFileSync(join(themeDir, "..", "node_modules", "minisearch", "dist", "umd", "index.js")));
  const search = put("search.json", searchJson);
  const favicon = theme("favicon.svg");
  writeFileSync(join(outDir, "favicon.svg"), favicon);
  return { css, hljs, js, editorCss, editorJs, search, favicon: `/favicon.svg?v=${stamp(favicon)}` };
}

function writePage(outDir: string, url: string, html: string): void {
  const dir = join(outDir, url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}

// Соседи страницы для «Назад/Дальше»: внутри руководства по порядку навигации
export function neighbours(site: Site, page: Page): { prev: Page | null; next: Page | null } {
  const guide = site.guides.find((g) => g.key === page.guide);
  if (!guide) return { prev: null, next: null };
  const i = guide.flat.indexOf(page);
  return { prev: guide.flat[i - 1] ?? null, next: guide.flat[i + 1] ?? null };
}

// Полная запись dist/: страницы, статика, картинки, индекс поиска, 404
export function writeStatic(prepared: Prepared, outDir: string, contentDir: string, themeDir: string): Assets {
  if (outDir === "/" || outDir === contentDir || outDir === themeDir || outDir === dirname(contentDir)) {
    throw new Error(`отказ: папка сборки ${outDir} — не для dist`);
  }
  const { site } = prepared;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const assets = writeAssets(outDir, themeDir, searchIndex(site));
  for (const p of site.pages) {
    const { prev, next } = neighbours(site, p);
    writePage(outDir, p.url, renderPage(site, p, prev, next, assets));
  }
  writeFileSync(join(outDir, "404.html"), renderNotFound(site, assets));
  for (const rel of prepared.assets) {
    const src = join(contentDir, rel);
    if (!existsSync(src)) continue;
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
  return assets;
}

// Карта «единого источника истины»: фрагмент → страницы, куда он включён
export function fragmentUsage(site: Site, contentDir: string): { file: string; usedBy: string[] }[] {
  const map = new Map<string, string[]>();
  for (const f of listFragments(contentDir)) map.set(f, []);
  for (const p of site.pages) {
    for (const inc of p.render?.includes ?? []) {
      const list = map.get(inc) ?? [];
      list.push(p.file);
      map.set(inc, list);
    }
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, usedBy]) => ({ file, usedBy }));
}

export function fragmentReport(site: Site, contentDir: string): string {
  const rows = fragmentUsage(site, contentDir);
  if (!rows.length) return "Фрагментов нет.";
  return rows
    .map((r) => `  ${r.file}\n${r.usedBy.length ? r.usedBy.map((p) => `    → ${p}`).join("\n") : "    (никуда не включён)"}`)
    .join("\n");
}
