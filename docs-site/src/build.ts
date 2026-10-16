// Сборка сайта документации: content/ → dist/.
//   node src/build.ts            — собрать; ошибки содержимого (битые ссылки, якоря, файлы,
//                                  незакрытые блоки) останавливают сборку
//   node src/build.ts --serve    — собрать, поднять http://localhost:8800 и пересобирать по
//                                  правке content/ или theme/ (ошибки — в консоль, сайт живёт)
//   node src/build.ts --report   — карта фрагментов: какой текст на каких страницах
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadSite, makeReader, validateSite } from "./content.ts";
import { createRenderer, DocsError } from "./markdown.ts";
import { renderHome, renderNotFound, renderPage, renderStandalone, type Assets } from "./render.ts";
import { serve } from "./serve.ts";
import type { Site } from "./types.ts";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONTENT_DIR = join(PKG, "content");
export const THEME_DIR = join(PKG, "theme");
const MINISEARCH = join(PKG, "node_modules", "minisearch", "dist", "umd", "index.js");

export interface BuildOutcome {
  errors: string[];
  warnings: string[];
  pages: number;
  site: Site;
}

function stamp(buf: Buffer | string): string {
  return createHash("sha1").update(buf).digest("hex").slice(0, 8);
}

// Статика темы с версией в адресе
function writeAssets(outDir: string, searchJson: string): Assets {
  const assetsDir = join(outDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const put = (name: string, content: Buffer | string): string => {
    writeFileSync(join(assetsDir, name), content);
    return `/assets/${name}?v=${stamp(content)}`;
  };
  const css = put("docs.css", readFileSync(join(THEME_DIR, "docs.css")));
  const hljs = put("hljs.css", readFileSync(join(THEME_DIR, "hljs.css")));
  const js = put("docs.js", readFileSync(join(THEME_DIR, "docs.js")));
  put("minisearch.js", readFileSync(MINISEARCH));
  const search = put("search.json", searchJson);
  const faviconSrc = readFileSync(join(THEME_DIR, "favicon.svg"));
  writeFileSync(join(outDir, "favicon.svg"), faviconSrc);
  return { css, hljs, js, search, favicon: `/favicon.svg?v=${stamp(faviconSrc)}` };
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

function writePage(outDir: string, url: string, html: string): void {
  const dir = join(outDir, url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}

export function build(outDir: string): BuildOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const site = loadSite(CONTENT_DIR);
  const renderer = createRenderer(makeReader(CONTENT_DIR));
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
  const v = validateSite(site, CONTENT_DIR);
  errors.push(...v.errors);
  warnings.push(...v.warnings);

  // Папка сборки — только внутри пакета или явно указанная; чистим целиком
  if (outDir === "/" || outDir === PKG || outDir === CONTENT_DIR || outDir === THEME_DIR) {
    throw new Error(`отказ: папка сборки ${outDir} — не для dist`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const assets = writeAssets(outDir, searchIndex(site));

  writePage(outDir, "/", renderHome(site, assets));
  for (const g of site.guides) {
    g.flat.forEach((p, i) => {
      writePage(outDir, p.url, renderPage(site, g, p, g.flat[i - 1] ?? null, g.flat[i + 1] ?? null, assets));
    });
  }
  for (const p of site.pages) {
    if (p.guide === null && p !== site.home) writePage(outDir, p.url, renderStandalone(site, p, assets));
  }
  writeFileSync(join(outDir, "404.html"), renderNotFound(site, assets));
  for (const rel of v.assets) {
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(CONTENT_DIR, rel), dest);
  }
  return { errors, warnings, pages: site.pages.length, site };
}

// Карта «единого источника истины»: фрагмент → страницы, куда он включён
export function fragmentReport(site: Site): string {
  const map = new Map<string, string[]>();
  for (const p of site.pages) {
    for (const inc of p.render?.includes ?? []) {
      const list = map.get(inc) ?? [];
      list.push(p.file);
      map.set(inc, list);
    }
  }
  if (!map.size) return "Включений нет.";
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([frag, pages]) => `  ${frag}\n${pages.map((p) => `    → ${p}`).join("\n")}`)
    .join("\n");
}

function report(r: BuildOutcome, strict: boolean): void {
  for (const w of r.warnings) console.warn(`предупреждение: ${w}`);
  for (const e of r.errors) console.error(`ошибка: ${e}`);
  const status = r.errors.length ? `ошибок: ${r.errors.length}` : "без ошибок";
  console.log(`Документация: страниц ${r.pages}, ${status}${strict && r.errors.length ? " — сборка отклонена" : ""}.`);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      serve: { type: "boolean", default: false },
      report: { type: "boolean", default: false },
      port: { type: "string" },
      out: { type: "string" },
    },
  });
  const outDir = resolve(values.out ?? join(PKG, "dist"));
  if (values.serve) {
    const run = () => {
      try {
        report(build(outDir), false);
      } catch (e) {
        console.error(`ошибка: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    run();
    serve(outDir, Number(values.port ?? process.env.DOCS_PORT ?? 8800), run, [CONTENT_DIR, THEME_DIR]);
    return;
  }
  let outcome: BuildOutcome;
  try {
    outcome = build(outDir);
  } catch (e) {
    if (!(e instanceof DocsError)) throw e;
    console.error(`ошибка: ${e.message}`);
    process.exit(1);
  }
  report(outcome, true);
  if (values.report) console.log(`Фрагменты (единый источник истины):\n${fragmentReport(outcome.site)}`);
  if (outcome.errors.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
