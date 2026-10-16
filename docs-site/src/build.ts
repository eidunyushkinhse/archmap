// Статическая сборка сайта документации: content/ → dist/ (CI и ручная проверка).
//   node src/build.ts            — собрать; ошибки содержимого (битые ссылки, якоря, файлы,
//                                  незакрытые блоки) останавливают сборку
//   node src/build.ts --report   — плюс карта фрагментов: какой текст на каких страницах
// Локальная работа и авторский режим — server.ts (npm run dev).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DocsError } from "./markdown.ts";
import { CONTENT_DIR, DIST_DIR, THEME_DIR } from "./paths.ts";
import { fragmentReport, prepareSite, writeStatic } from "./site.ts";

function main(): void {
  const { values } = parseArgs({
    options: {
      report: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const outDir = resolve(values.out ?? DIST_DIR);
  let prepared;
  try {
    prepared = prepareSite(CONTENT_DIR);
    writeStatic(prepared, outDir, CONTENT_DIR, THEME_DIR);
  } catch (e) {
    if (!(e instanceof DocsError)) throw e;
    console.error(`ошибка: ${e.message}`);
    process.exit(1);
  }
  for (const w of prepared.warnings) console.warn(`предупреждение: ${w}`);
  for (const e of prepared.errors) console.error(`ошибка: ${e}`);
  const status = prepared.errors.length ? `ошибок: ${prepared.errors.length} — сборка отклонена` : "без ошибок";
  console.log(`Документация: страниц ${prepared.site.pages.length}, ${status}.`);
  if (values.report) console.log(`Фрагменты (единый источник истины):\n${fragmentReport(prepared.site, CONTENT_DIR)}`);
  if (prepared.errors.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
