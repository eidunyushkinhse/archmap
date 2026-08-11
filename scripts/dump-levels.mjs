// Полигон движка схем (R0 эпика вид-центричного движка, см. C4_ENGINE_AUDIT.md).
//
// Снимает СТРУКТУРНУЮ СИГНАТУРУ раскладки всех уровней проекта в headless-Chromium:
// позиции узлов (transform), пути рёбер (path d), плашки подписей и рамки уровней.
// Скриншоты недетерминированы — сравниваем именно структуру (см. память проекта
// ui_verification_headless). Обходит уровни BFS до --max-depth, на каждом уровне
// дампит состояние по умолчанию и состояние с раскрытыми гостевыми контейнерами.
//
// ВАЖНО: own-on-first-render персистит позиции гостей при первом показе, поэтому
// первый прогон по свежей БД «засеивает» уровни. Эталон снимать ВТОРЫМ прогоном
// (первый — прогрев), дальше сигнатура стабильна.
//
// Запуск (dev-стек должен быть поднят: ./dev.sh):
//   node scripts/dump-levels.mjs --out scripts/.polygon/baseline.json
//   node scripts/dump-levels.mjs --check scripts/.polygon/baseline.json
// Опции: --project <имя> (по умолчанию первый активный), --max-depth N (по умолчанию 2),
//   --role viewer|architect (по умолчанию viewer),
//   --levels <id|имя,…> — снять ТОЛЬКО эти уровни (плюс корень), вместо обхода по глубине.
//
// СЮРФЕЙС (важно, 2026-08-11): дампится РЕДАКТОР-КАРТА — маршрут #/p/<pid>/map/<levelId?>.
// До этой правки скрипт ходил на #/p/<pid>, и после пивота страниц (2026-08-09) там
// оказалась ProjectHomePage со ВСТРОЕННОЙ read-only схемой: полигон молча мерил не тот
// холст (у read-only нет кнопок «Войти» — обход уровней тихо вырождался в один корень).
// Спуск идёт ПО URL, а не кликами по «Войти»: маршрут принимает id уровня напрямую,
// это детерминированнее цепочки кликов и позволяет прицелиться в конкретный уровень.
// РОЛИ (R5): раскрытия контейнеров ПЕРСИСТЯТСЯ (payload.expanded) — обычные
// дампы/чеки гоняем VIEWER-ом (его раскрытия эфемерны, БД не трогается; в
// expanded-состояние входят и раскрытые ЛОКАЛЬНЫЕ контейнеры). Прогрев свежей БД
// (--role architect, own-on-first-render засев гостей) кликает ТОЛЬКО гостевые
// лупы, чтобы не записать раскрытия в БД.
//
// Окружение (выстрадано, см. память headless-route-dump):
//   chromium: ~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
//   playwright (CommonJS, import default): ~/.npm/_npx/e41f203b7505f1fb/node_modules/playwright
//   либы chrome (libnspr4/libnss3/libasound2): ~/.cache/archmap-chrome-libs/usr/lib/x86_64-linux-gnu
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";

// playwright — CommonJS из npx-кэша: named-import падает, берём default динамически
const pw = await import(join(homedir(), ".npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js"));
const { chromium } = pw.default;

const FRONTEND = process.env.ARCHMAP_FRONTEND ?? "http://localhost:5173";
const BACKEND = process.env.ARCHMAP_BACKEND ?? "http://localhost:8000";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome");
const CHROME_LIBS = join(homedir(), ".cache/archmap-chrome-libs/usr/lib/x86_64-linux-gnu");

// --- аргументы ---
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outFile = argOf("--out");
const checkFile = argOf("--check");
const projectName = argOf("--project");
const maxDepth = Number(argOf("--max-depth") ?? 2);
const role = argOf("--role") ?? "viewer";
const onlyLevels = (argOf("--levels") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!outFile && !checkFile) {
  console.error("Нужен --out <file> или --check <baseline>");
  process.exit(2);
}

// --- токен архитектора: python пишет в файл (JWT в stdout не печатаем) ---
function makeToken() {
  const tokFile = join(tmpdir(), `archmap-tok-${process.pid}.txt`);
  execFileSync("backend/venv/bin/python", ["-c", `
import sys; sys.path.insert(0, 'backend')
from app.auth import create_access_token
open(${JSON.stringify(tokFile)}, 'w').write(create_access_token({'sub': 'admin', 'role': ${JSON.stringify(role)}}))
`]);
  const tok = readFileSync(tokFile, "utf8").trim();
  rmSync(tokFile);
  return tok;
}

// --- выбор проекта через REST ---
async function pickProject(token) {
  const res = await fetch(`${BACKEND}/api/v1/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /projects → ${res.status}`);
  const list = await res.json();
  const active = list.filter((p) => !p.archived_at);
  const proj = projectName ? active.find((p) => p.name === projectName) : active[0];
  if (!proj) throw new Error(`Проект не найден (${projectName ?? "первый активный"})`);
  return proj;
}

// Все узлы проекта (id, имя, parent_id) — по ним строится список уровней БЕЗ кликов
// по холсту: уровень = узел, у которого есть дети.
async function fetchNodes(token, projectId) {
  const res = await fetch(`${BACKEND}/api/v1/nodes/all`, {
    headers: { Authorization: `Bearer ${token}`, "X-Project-Id": projectId },
  });
  if (!res.ok) throw new Error(`GET /nodes/all → ${res.status}`);
  return res.json();
}

// Уровни для обхода: корень (null) + контейнеры. По умолчанию — все контейнеры не
// глубже maxDepth; с --levels — только названные (по id или по имени узла).
function pickLevels(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthOf = (n) => {
    let d = 0;
    for (let p = n.parent_id; p != null; p = byId.get(p)?.parent_id ?? null) {
      if (++d > 20) break; // страховка от цикла в данных
    }
    return d;
  };
  const containers = nodes.filter((n) => nodes.some((m) => m.parent_id === n.id));
  if (onlyLevels.length > 0) {
    const want = new Set(onlyLevels);
    return containers.filter((n) => want.has(n.id) || want.has(n.name));
  }
  return containers.filter((n) => depthOf(n) < maxDepth);
}

// --- структурная сигнатура текущего холста ---
async function readSignature(page) {
  return page.evaluate(() => {
    const r1 = (v) => Math.round(v * 10) / 10;
    const lastPxTranslate = (t) => {
      const ms = [...(t || "").matchAll(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/g)];
      const m = ms.pop();
      return m ? { x: r1(+m[1]), y: r1(+m[2]) } : null;
    };
    const nodes = [...document.querySelectorAll(".react-flow__node")]
      .map((n) => {
        const p = lastPxTranslate(n.style.transform) ?? { x: 0, y: 0 };
        const type = [...n.classList].find((c) => c.startsWith("react-flow__node-"))?.slice("react-flow__node-".length) ?? "";
        // реальные габариты (offsetWidth не масштабируется трансформом вьюпорта) —
        // роутер V2.2b считает от них; метрики проверяют «плечо не над узлом»
        return { id: n.getAttribute("data-id"), type, x: p.x, y: p.y, w: r1(n.offsetWidth), h: r1(n.offsetHeight) };
      })
      // Рамки-узлы (R4, compound) в раздел nodes не входят — они в разделе frames,
      // сопоставимом со старым (оверлейным) представлением рамок.
      .filter((n) => n.type !== "frame")
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const roundD = (d) => (d || "").replace(/-?\d+(?:\.\d+)?/g, (s) => String(r1(+s)));
    const edges = [...document.querySelectorAll(".react-flow__edge")]
      .map((e) => ({
        id: e.getAttribute("data-id"),
        d: roundD(e.querySelector("path.react-flow__edge-path")?.getAttribute("d")),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const labels = [...document.querySelectorAll(".react-flow__edgelabel-renderer > div")]
      .map((el) => {
        const p = lastPxTranslate(el.style.transform) ?? { x: 0, y: 0 };
        return { text: (el.textContent || "").trim().slice(0, 60), x: p.x, y: p.y };
      })
      .sort((a, b) => a.text.localeCompare(b.text) || a.x - b.x || a.y - b.y);
    const frames = [...document.querySelectorAll(".lg-frame")]
      .map((el) => {
        const id = el.getAttribute("data-frame-id");
        // R4: раскрытая гостевая рамка — RF-узел (координаты в transform обёртки,
        // размер на её style). Нативные рамки — прежний оверлей (style.left/top).
        const wrap = el.closest(".react-flow__node");
        if (wrap) {
          const p = lastPxTranslate(wrap.style.transform) ?? { x: 0, y: 0 };
          return { id, x: p.x, y: p.y, w: r1(parseFloat(wrap.style.width)), h: r1(parseFloat(wrap.style.height)) };
        }
        return {
          id,
          x: r1(parseFloat(el.style.left)), y: r1(parseFloat(el.style.top)),
          w: r1(parseFloat(el.style.width)), h: r1(parseFloat(el.style.height)),
        };
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return { nodes, edges, labels, frames };
  });
}

// Ждём стабилизации: раскладка async (ELK) + засев владения может дать 2-3 пере-рендера.
// Считаем устоявшейся, когда две подряд выборки с шагом 350мс совпали.
async function settleSignature(page) {
  // ТРИ совпавших подряд выборки: раскладка стала двухфазной (первый прогон с фолбэк-
  // габаритами → замер node.measured → пере-прогон, V2.2b), и окно в две выборки ловило
  // промежуточное состояние между фазами — полигон «мигал» между прогонами.
  let prev = null, stable = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    // явный сигнал занятости: async-раскладка LevelGraph в полёте → выборка не в счёт
    const busy = await page.evaluate(() => window.__archmapLayoutInflight ?? 0);
    if (busy > 0) { prev = null; stable = 0; continue; }
    const cur = await readSignature(page);
    const s = JSON.stringify(cur);
    if (prev === s) {
      if (++stable >= 2) return cur;
    } else stable = 0;
    prev = s;
  }
  throw new Error("Сигнатура не стабилизировалась за 16с");
}

// Раскрыть по очереди все контейнеры уровня (лупа «Раскрыть содержимое»): гостевые
// и — с R5 — локальные. Раскрытие может обнажить новые контейнеры — крутим до
// исчерпания (кэп 30 итераций). В architect-режиме (прогрев) кликаем ТОЛЬКО
// гостевые лупы: раскрытия локалов архитектором персистятся и замусорили бы БД.
async function expandAllGuests(page) {
  const sel = role === "architect"
    ? '.react-flow__node-container button[title="Раскрыть содержимое"]'
    : 'button[title="Раскрыть содержимое"]';
  for (let i = 0; i < 30; i++) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) === 0) return i > 0;
    // Раскрытия раздвигают раскладку — очередная лупа уходит за вьюпорт, и
    // playwright-клик по ней падает ДАЖЕ с force («outside of the viewport»),
    // роняя весь дамп. Вписываем холст (кнопка fitView в Controls; на сигнатуру не
    // влияет — она в graph-координатах), а клик шлём СИНТЕТИЧЕСКИЙ, из DOM: он не
    // требует видимости, а React ловит его делегированным слушателем корня.
    await page.locator(".react-flow__controls-fitview").click({ force: true }).catch(() => {});
    await page.waitForTimeout(150);
    await btn.evaluate((el) => el.click());
    await settleSignature(page);
  }
  return true;
}

// Свернуть боковые панели: холст на весь экран. Панели лежат ПОВЕРХ холста, и
// force-клик по элементу, оказавшемуся после fitView под панелью, молча уходит
// в панель (событие получает верхний элемент под точкой) — с ростом схем это
// стало стабильно ронять раскрытие луп. На сигнатуру панели не влияют (она в
// graph-координатах).
async function collapsePanels(page) {
  for (const btn of await page.locator('button[title="Свернуть панель"]').all()) {
    await btn.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(200);
}

// Свежая загрузка холста РЕДАКТОРА-КАРТЫ на нужном уровне (levelId = null — корень).
// App читает токен только на монтировании, поэтому каждый уровень грузим с reload:
// так между уровнями не протекает состояние (раскрытия, выделение, гистерезис маршрутов).
async function freshLevel(page, projectId, levelId) {
  const suffix = levelId ? `/${levelId}` : "";
  await page.goto(`${FRONTEND}/#/p/${projectId}/map${suffix}`);
  await page.reload();
  await page.waitForSelector(".react-flow", { timeout: 20000 });
  await collapsePanels(page);
  return settleSignature(page);
}

async function main() {
  const token = makeToken();
  const project = await pickProject(token);
  console.log(`Проект: ${project.name} (${project.id}), max-depth ${maxDepth}`);

  const browser = await chromium.launch({
    executablePath: CHROME,
    env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  // токен и проект — до первого рендера App
  await page.goto(FRONTEND);
  await page.evaluate(
    ([tok, pid]) => {
      localStorage.setItem("access_token", tok);
      localStorage.setItem("archmap.lastProjectId", pid);
    },
    [token, project.id],
  );

  // Список уровней берём из ДЕРЕВА проекта, а не из кликов по холсту: корень + контейнеры.
  const allNodes = await fetchNodes(token, project.id);
  const targets = [{ id: null, name: "корень" }, ...pickLevels(allNodes)];
  console.log(`Уровней к снятию: ${targets.length}`);

  const levels = [];
  for (const t of targets) {
    const sig = await freshLevel(page, project.id, t.id);
    // path остаётся массивом (ключ дампа и diff): [] — корень, [levelId] — уровень
    const path = t.id ? [t.id] : [];
    levels.push({ path, state: "default", sig });
    // раскрытые контейнеры — отдельное состояние того же уровня (кумулятивно все лупы)
    if (await expandAllGuests(page)) {
      levels.push({ path, state: "expanded", sig: await readSignature(page) });
    }
    console.log(`  уровень ${t.name}: узлов ${sig.nodes.length}, рёбер ${sig.edges.length}`);
  }
  await browser.close();

  const dump = { project: project.name, maxDepth, levels };

  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(dump, null, 1));
    console.log(`Сигнатура сохранена: ${outFile} (${levels.length} состояний)`);
  }
  if (checkFile) {
    const base = JSON.parse(readFileSync(checkFile, "utf8"));
    const key = (l) => `${l.path.join(">") || "root"}:${l.state}`;
    const baseMap = new Map(base.levels.map((l) => [key(l), l.sig]));
    const curMap = new Map(dump.levels.map((l) => [key(l), l.sig]));
    let bad = 0;
    for (const [k, bs] of baseMap) {
      const cs = curMap.get(k);
      if (!cs) { console.error(`ПРОПАЛ уровень ${k}`); bad++; continue; }
      for (const part of ["nodes", "edges", "labels", "frames"]) {
        const a = JSON.stringify(bs[part]);
        const b = JSON.stringify(cs[part]);
        if (a !== b) {
          bad++;
          console.error(`ДИФФ ${k} · ${part}: базовых ${bs[part].length}, текущих ${cs[part].length}`);
          const bd = bs[part].filter((x) => !cs[part].some((y) => JSON.stringify(x) === JSON.stringify(y)));
          for (const x of bd.slice(0, 3)) console.error(`   − ${JSON.stringify(x).slice(0, 160)}`);
          const cd = cs[part].filter((x) => !bs[part].some((y) => JSON.stringify(x) === JSON.stringify(y)));
          for (const x of cd.slice(0, 3)) console.error(`   + ${JSON.stringify(x).slice(0, 160)}`);
        }
      }
    }
    for (const k of curMap.keys()) if (!baseMap.has(k)) { console.error(`НОВЫЙ уровень ${k}`); bad++; }
    if (bad > 0) {
      console.error(`ПОЛИГОН КРАСНЫЙ: расхождений ${bad}`);
      process.exit(1);
    }
    console.log(`ПОЛИГОН ЗЕЛЁНЫЙ: ${baseMap.size} состояний совпали`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
