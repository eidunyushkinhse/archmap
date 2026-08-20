// Зонд ПРОИЗВОДИТЕЛЬНОСТИ рендерера (эпик renderer-perf, Ф0 — базлайн).
//
// Меряет wall-clock сценарии пользователя на живом dev-стеке:
//   - открытие редактора-карты (корень или уровень) / страницы объекта (контекст-схема);
//   - последовательные раскрытия контейнеров по именам (клик по лупе).
// Для каждого шага снимает: время до тишины, суммарное время конвейера в полёте
// (__archmapLayoutInflight), число прогонов (__archmapLayoutRuns), максимальный
// фриз главного потока (разрыв rAF > 100мс), размер сцены (узлы/рёбра DOM).
//
// Роль viewer: раскрытия эфемерны, БД не мутируется — прогоны повторяемы.
//
// Запуск (dev-стек поднят, env бэка в окружении: set -a; source backend/.env; set +a):
//   node scripts/perf-probe.mjs --project "Sentry Эталон" --expand "Sentry,Консьюмеры Kafka"
//   node scripts/perf-probe.mjs --project "Zabbix 7 Эталон" --level "Zabbix server" --expand "Опрос и сбор"
//   node scripts/perf-probe.mjs --project "Zabbix 7 Эталон" --surface node --level "Zabbix server"
// Опции: --surface map|node (default map), --level <имя узла> (фокус карты / объект страницы),
//   --expand <имя,имя,…>, --out <file.json>, --timeout <мс на шаг, default 120000>.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const pw = await import(join(homedir(), ".npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js"));
const { chromium } = pw.default;

const FRONTEND = process.env.ARCHMAP_FRONTEND ?? "http://localhost:5173";
const BACKEND = process.env.ARCHMAP_BACKEND ?? "http://localhost:8000";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome");
const CHROME_LIBS = join(homedir(), ".cache/archmap-chrome-libs/usr/lib/x86_64-linux-gnu");

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const projectName = argOf("--project");
const surface = argOf("--surface") ?? "map";
const levelName = argOf("--level");
const expandNames = (argOf("--expand") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const outFile = argOf("--out");
const stepTimeout = Number(argOf("--timeout") ?? 120000);
const collapseFirst = args.includes("--collapse-first");
const captureFile = argOf("--capture"); // сохранить ПОСЛЕДНИЙ вход конвейера (для реплея)
if (!projectName) { console.error("Нужен --project <имя>"); process.exit(2); }

function makeToken() {
  const f = join(tmpdir(), `archmap-perf-tok-${process.pid}.txt`);
  execFileSync("backend/venv/bin/python", ["-c", `
import sys; sys.path.insert(0, 'backend')
from app.auth import create_access_token
open(${JSON.stringify(f)}, 'w').write(create_access_token({'sub': 'admin', 'role': 'viewer'}))
`]);
  const t = readFileSync(f, "utf8").trim(); rmSync(f); return t;
}

async function api(token, path, projectId = null) {
  const headers = { Authorization: `Bearer ${token}`, ...(projectId ? { "X-Project-Id": projectId } : {}) };
  const r = await fetch(`${BACKEND}/api/v1${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

const token = makeToken();
const projects = await api(token, "/projects");
const project = projects.filter((p) => !p.archived_at).find((p) => p.name === projectName);
if (!project) throw new Error(`Проект «${projectName}» не найден`);
const allNodes = await api(token, "/nodes/all", project.id);
const hasChildren = (id) => allNodes.some((n) => n.parent_id === id);
// имя → узел; при дублях предпочитаем контейнер (у раскрытий и уровней дети есть)
function byName(name) {
  const cand = allNodes.filter((n) => n.name === name);
  if (cand.length === 0) throw new Error(`Узел «${name}» не найден`);
  const containers = cand.filter((n) => hasChildren(n.id));
  const pick = containers[0] ?? cand[0];
  if (cand.length > 1) console.error(`ВНИМАНИЕ: имя «${name}» неоднозначно (${cand.length}), взят ${pick.id}`);
  return pick;
}

const browser = await chromium.launch({
  executablePath: CHROME,
  env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// --- in-page рекордер: rAF-петля пишет полёты конвейера и фризы главного потока ---
async function recStart(page) {
  await page.evaluate(() => {
    const w = window;
    if (w.__perfRec) w.__perfRec.stopped = true;
    const rec = { t0: performance.now(), events: [], stopped: false };
    w.__perfRec = rec;
    let last = performance.now();
    let lastInflight = w.__archmapLayoutInflight ?? 0;
    let openT = lastInflight > 0 ? 0 : null; // конвейер уже в полёте на старте
    const loop = () => {
      if (rec.stopped) return;
      const now = performance.now();
      const gap = now - last;
      if (gap > 100) rec.events.push({ type: "stall", t: now - rec.t0 - gap, ms: Math.round(gap) });
      const inflight = w.__archmapLayoutInflight ?? 0;
      if (inflight > 0 && lastInflight === 0) openT = now - rec.t0;
      if (inflight === 0 && lastInflight > 0 && openT != null) {
        rec.events.push({ type: "pipeline", t: openT, ms: Math.round(now - rec.t0 - openT) });
        openT = null;
      }
      lastInflight = inflight;
      last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
async function recStop(page) {
  return page.evaluate(() => {
    const w = window;
    const rec = w.__perfRec; rec.stopped = true;
    const pip = rec.events.filter((e) => e.type === "pipeline");
    const stalls = rec.events.filter((e) => e.type === "stall");
    return {
      pipelineMs: pip.reduce((s, e) => s + e.ms, 0),
      pipelineRuns: pip.length,
      maxStallMs: stalls.reduce((m, e) => Math.max(m, e.ms), 0),
      stallTotalMs: stalls.reduce((s, e) => s + e.ms, 0),
      lastEventEndMs: Math.round(rec.events.reduce((m, e) => Math.max(m, e.t + (e.ms ?? 0)), 0)),
      events: rec.events.map((e) => ({ ...e, t: Math.round(e.t) })),
    };
  });
}

// тишина: конвейер не в полёте и (runs, число DOM-узлов/рёбер) неизменны 2с подряд
async function waitQuiet(page) {
  const t0 = Date.now();
  let lastKey = "", quietSince = null;
  for (;;) {
    if (Date.now() - t0 > stepTimeout) throw new Error(`не устаканилось за ${stepTimeout}мс`);
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => ({
      inflight: window.__archmapLayoutInflight ?? 0,
      runs: window.__archmapLayoutRuns ?? 0,
      n: document.querySelectorAll(".react-flow__node").length,
      e: document.querySelectorAll(".react-flow__edge").length,
    }));
    const key = JSON.stringify(st);
    if (st.inflight === 0 && key === lastKey) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 2000) return { ...st, quietAtMs: quietSince - t0 };
    } else { quietSince = null; lastKey = key; }
  }
}

const results = { project: projectName, surface, level: levelName ?? "(корень)", steps: [] };

async function measureStep(name, action) {
  await recStart(page);
  const t0 = Date.now();
  await action();
  const quiet = await waitQuiet(page);
  const rec = await recStop(page);
  void t0;
  // от действия до начала тишины — по рекордеру: конец последнего события (конвейер/фриз)
  const step = {
    name,
    wallToQuietMs: Math.max(rec.lastEventEndMs, 0),
    ...rec,
    scene: { nodes: quiet.n, edges: quiet.e },
  };
  results.steps.push(step);
  const s = (ms) => (ms / 1000).toFixed(1) + "с";
  console.log(`[${name}] тишина через ~${s(step.wallToQuietMs)} | конвейер ${s(rec.pipelineMs)} за ${rec.pipelineRuns} прогонов | макс.фриз ${rec.maxStallMs}мс (всего ${s(rec.stallTotalMs)}) | сцена ${quiet.n} узлов / ${quiet.e} рёбер`);
}

// --- сценарий ---
const focus = levelName ? byName(levelName) : null;
// Старт с ЛЕНДИНГА (#/projects — там нет схем), рекордер ставится ДО перехода на карту.
// Переход — сменой хэша: документ не перезагружается, рекордер ловит ВЕСЬ первый
// прогон (fetch данных + конвейер + маунт сцены), а не хвост после waitForSelector.
await page.goto(`${FRONTEND}/#/projects`);
await page.evaluate(([tok, pid]) => {
  localStorage.setItem("access_token", tok);
  localStorage.setItem("archmap.lastProjectId", pid);
}, [token, project.id]);
await page.reload();
if (captureFile) await page.evaluate(() => { window.__archmapCaptureInput = true; });
await page.waitForSelector("body", { timeout: 30000 });
await page.waitForTimeout(1000); // лендинг догрузился, фоновых фетчей нет

const targetHash = surface === "node"
  ? `#/p/${project.id}/nodes/${focus.id}`
  : `#/p/${project.id}/map${focus ? `/${focus.id}` : ""}`;

await measureStep(surface === "node" ? `страница объекта «${levelName}»` : `открытие карты ${levelName ?? "корня"}`, async () => {
  await page.evaluate((h) => { location.hash = h; }, [targetHash].join(""));
});

if (collapseFirst) {
  // Свернуть все раскрытые контейнеры (персист архитектора): кнопка «Свернуть» на рамке.
  // Viewer — эфемерно. Крутим до исчерпания: сворачивание родителя прячет детей.
  for (let i = 0; i < 30; i++) {
    // ГЛУБЖЕ СНАЧАЛА: дети в RF-массиве идут после родителей — last() сворачивает
    // вложенное прежде родителя, иначе вложенные остаются в expanded-множестве
    // и «воскресают» раскрытыми при следующем раскрытии родителя.
    const btn = page.locator('button[title="Свернуть"]').last();
    if ((await btn.count()) === 0) break;
    await btn.evaluate((el) => el.click());
    await waitQuiet(page);
  }
  console.log("(всё свёрнуто — стартовое состояние сценария)");
}

for (const name of expandNames) {
  const node = byName(name);
  const sel = `.react-flow__node[data-id="${node.id}"] button[title="Раскрыть содержимое"]`;
  // ждём наличия в DOM (не «видимости»: лупа может быть за вьюпортом), клик синтетический
  await page.waitForSelector(sel, { timeout: 15000, state: "attached" });
  await measureStep(`раскрытие «${name}»`, async () => {
    await page.locator(sel).first().evaluate((el) => el.click());
  });
}

if (captureFile) {
  // последний вход конвейера — сериализация с кодированием Set/Map (реплей их оживит)
  const json = await page.evaluate(() => {
    const inp = window.__archmapLastPipelineInput;
    if (!inp) return null;
    return JSON.stringify(inp, (_k, v) => {
      if (v instanceof Set) return { __set: [...v] };
      if (v instanceof Map) return { __map: [...v] };
      return v;
    });
  });
  if (json) { writeFileSync(captureFile, json); console.log(`вход конвейера захвачен → ${captureFile}`); }
  else console.error("ВНИМАНИЕ: __archmapLastPipelineInput пуст — захват не сработал");
}
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
await browser.close();
