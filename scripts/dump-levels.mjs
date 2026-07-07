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
// Опции: --project <имя> (по умолчанию первый активный), --max-depth N (по умолчанию 2).
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
open(${JSON.stringify(tokFile)}, 'w').write(create_access_token({'sub': 'admin', 'role': 'architect'}))
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
        return { id: n.getAttribute("data-id"), type, x: p.x, y: p.y };
      })
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
      .map((el) => ({
        id: el.getAttribute("data-frame-id"),
        x: r1(parseFloat(el.style.left)), y: r1(parseFloat(el.style.top)),
        w: r1(parseFloat(el.style.width)), h: r1(parseFloat(el.style.height)),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return { nodes, edges, labels, frames };
  });
}

// Ждём стабилизации: раскладка async (ELK) + засев владения может дать 2-3 пере-рендера.
// Считаем устоявшейся, когда две подряд выборки с шагом 350мс совпали.
async function settleSignature(page) {
  let prev = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(350);
    const cur = await readSignature(page);
    const s = JSON.stringify(cur);
    if (prev === s) return cur;
    prev = s;
  }
  throw new Error("Сигнатура не стабилизировалась за 14с");
}

// Раскрыть по очереди все гостевые контейнеры уровня (лупа «Раскрыть содержимое»).
// Раскрытие может обнажить новые контейнеры — крутим до исчерпания (кэп 10 итераций).
async function expandAllGuests(page) {
  for (let i = 0; i < 10; i++) {
    const btn = page.locator('button[title="Раскрыть содержимое"]').first();
    if ((await btn.count()) === 0) return i > 0;
    await btn.click({ force: true });
    await settleSignature(page);
  }
  return true;
}

// Спуститься по пути id узлов от корня (каждый шаг — hover узла + кнопка «Войти»).
async function drillPath(page, path) {
  for (const id of path) {
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    await node.hover({ force: true });
    await node.locator('button[title="Войти"]').click({ force: true });
    await settleSignature(page);
  }
}

// Свежая загрузка холста проекта (корень). App читает токен только на монтировании.
async function freshRoot(page, projectId) {
  await page.goto(`${FRONTEND}/#/p/${projectId}`);
  await page.reload();
  await page.waitForSelector(".react-flow", { timeout: 20000 });
  return settleSignature(page);
}

// id ЛОКАЛЬНЫХ узлов текущего уровня, в которые можно «Войти» (есть drill-кнопка).
// Гостей/контейнеры не берём: их «Войти» уводит в другую ветку дерева, и такой путь
// не воспроизвести спуском от корня (drillPath каждый раз стартует с корня).
async function drillableIds(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll(".react-flow__node.react-flow__node-block")]
      .filter((n) => n.querySelector('button[title="Войти"]'))
      .map((n) => n.getAttribute("data-id"))
      .sort();
  });
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

  const levels = [];
  // BFS путей: [] = корень; путь = последовательность id для drill
  const queue = [[]];
  while (queue.length > 0) {
    const path = queue.shift();
    const rootSig = await freshRoot(page, project.id);
    let sig = rootSig;
    if (path.length > 0) {
      await drillPath(page, path);
      sig = await settleSignature(page);
    }
    levels.push({ path, state: "default", sig });
    const drills = await drillableIds(page);
    // раскрытые гости — отдельное состояние того же уровня (кумулятивно все лупы)
    if (await expandAllGuests(page)) {
      levels.push({ path, state: "expanded", sig: await readSignature(page) });
    }
    if (path.length < maxDepth) {
      for (const id of drills) queue.push([...path, id]);
    }
    console.log(`  уровень [${path.join(" > ") || "корень"}]: узлов ${sig.nodes.length}, рёбер ${sig.edges.length}`);
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
