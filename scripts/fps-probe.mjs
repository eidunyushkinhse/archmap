// Зонд FPS при драге узла: меряет частоту кадров (rAF) во время медленного драга
// и счётчик прогонов конвейера (__archmapLayoutRuns) — если конвейер гоняется
// ПОСРЕДИ драга, это источник просадки. Работает на клоне __drift-полигон.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const pw = await import(join(homedir(), ".npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js"));
const { chromium } = pw.default;

const FRONTEND = process.env.ARCHMAP_FRONTEND ?? "http://localhost:5173";
const BACKEND = process.env.ARCHMAP_BACKEND ?? "http://localhost:8000";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome");
const CHROME_LIBS = join(homedir(), ".cache/archmap-chrome-libs/usr/lib/x86_64-linux-gnu");
const CLONE_NAME = "__drift-полигон";

function makeToken(role) {
  const f = join(tmpdir(), `archmap-fps-tok-${process.pid}.txt`);
  execFileSync("backend/venv/bin/python", ["-c", `
import sys; sys.path.insert(0, 'backend')
from app.auth import create_access_token
open(${JSON.stringify(f)}, 'w').write(create_access_token({'sub': 'admin', 'role': ${JSON.stringify(role)}}))
`]);
  const t = readFileSync(f, "utf8").trim();
  rmSync(f);
  return t;
}

async function api(token, path, opts = {}, projectId = null) {
  const headers = {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    ...(projectId ? { "X-Project-Id": projectId } : {}),
  };
  const r = await fetch(`${BACKEND}/api/v1${path}`, { ...opts, headers });
  if (!r.ok && r.status !== 204) throw new Error(`${opts.method ?? "GET"} ${path} -> ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const arch = makeToken("architect");
const projects = await api(arch, "/projects");
const clone = projects.find((p) => p.name === CLONE_NAME);
if (!clone) throw new Error(`Клон «${CLONE_NAME}» не найден — сначала drift-probe --prepare`);

const browser = await chromium.launch({
  executablePath: CHROME,
  env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(FRONTEND);
await page.evaluate(([tok, pid]) => {
  localStorage.setItem("access_token", tok);
  localStorage.setItem("archmap.lastProjectId", pid);
}, [arch, clone.id]);
await page.goto(`${FRONTEND}/#/p/${clone.id}`);
await page.reload();
await page.waitForSelector(".react-flow", { timeout: 20000 });
await page.locator(".react-flow__controls-fitview").click({ force: true }).catch(() => {});
await page.waitForTimeout(2500); // устаканиться

// счётчик прогонов конвейера ДО драга
const runsBefore = await page.evaluate(() => (window).__archmapLayoutRuns ?? 0);
await page.evaluate(() => { (window).__edgeRenders = 0; });

// Ищем узел-ребёнка раскрытого контейнера ровно с одной связью (точный сценарий
// пользователя: «узел всего с одной связью»). Фолбэк — любой дочерний узел.
const nodesAll = await api(arch, "/nodes", {}, clone.id);
const edgesAll = await api(arch, "/edges", {}, clone.id);
const degree = new Map();
for (const e of edgesAll) {
  degree.set(e.source_id, (degree.get(e.source_id) ?? 0) + 1);
  degree.set(e.target_id, (degree.get(e.target_id) ?? 0) + 1);
}
const children = nodesAll.filter((n) => n.parent_id != null);
const child = children.find((n) => (degree.get(n.id) ?? 0) === 1) ?? children[0];
let target = page.locator(".react-flow__node").first();
if (child) {
  const loc = page.locator(`.react-flow__node[data-id="${child.id}"]`);
  if (await loc.count() > 0) { target = loc; console.log(`Дёргаем: ${child.name} (связей: ${degree.get(child.id) ?? 0})`); }
}

// включаем rAF-счётчик FPS в странице
await page.evaluate(() => {
  (window).__fpsFrames = 0;
  (window).__fpsActive = true;
  const tick = () => {
    if (!(window).__fpsActive) return;
    (window).__fpsFrames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// медленный драг целевого узла: ~1.6с, много мелких шагов
const box = await target.boundingBox();
if (!box) throw new Error("узел не виден");
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const t0 = Date.now();
await page.mouse.move(cx, cy);
await page.mouse.down();
const STEPS = 40;
for (let i = 1; i <= STEPS; i++) {
  await page.mouse.move(cx + (i / STEPS) * 120, cy + (i / STEPS) * 60, { steps: 1 });
  await page.waitForTimeout(40); // ~25 шагов/с
}
await page.mouse.up();
const elapsed = (Date.now() - t0) / 1000;

const frames = await page.evaluate(() => { (window).__fpsActive = false; return (window).__fpsFrames; });
const runsAfter = await page.evaluate(() => (window).__archmapLayoutRuns ?? 0);
const edgeRenders = await page.evaluate(() => (window).__edgeRenders ?? 0);

console.log(`Драг ${elapsed.toFixed(1)}с, rAF-кадров ${frames} → ${(frames / elapsed).toFixed(1)} FPS`);
console.log(`Рендеров рёбер всего ${edgeRenders} → ${(edgeRenders / frames).toFixed(1)} на кадр`);
console.log(`Прогоны конвейера: до ${runsBefore}, после ${runsAfter} (Δ=${runsAfter - runsBefore})`);
await browser.close();
