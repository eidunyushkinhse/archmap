// Зонд ДРЕЙФА ГИСТЕРЕЗИСНЫХ ПРОГОНОВ (tasks.md «ДРЕЙФ», «ХВОСТЫ» п.в).
//
// Воспроизводит «дыхание» маршрутов: каждый дроп драга гоняет ПОЛНЫЙ прогон уровня
// с prev от прошлого прогона; цепочка не сходится к фикспойнту — маршруты меняются
// поколение за поколением даже при возврате узла в исходную позицию.
//
// Механика: клонируем «Ярмарку», открываем архитектором, снимаем сигнатуру рёбер,
// затем N раз дёргаем один корневой узел туда-обратно (каждый дроп = полный пересчёт
// с гистерезисом). Сравниваем сигнатуру рёбер ПОКОЛЕНИЕ К ПОКОЛЕНИЮ (churn = число
// изменившихся путей) и против базовой (gen 0). Если churn не затухает к нулю —
// цепочка не сходится (дрейф). Работает на клоне, живые данные не трогает.
//
// Запуск (dev-стек поднят: ./dev.sh):
//   node scripts/drift-probe.mjs --prepare            # создать клон __drift-полигон
//   node scripts/drift-probe.mjs [--gens 6] [--dx 40] # прогон: чурн по поколениям
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
const SOURCE_NAME = "Маркетплейс «Ярмарка»";
const PSQL_ENV = { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? "postgres" };

const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const doPrepare = args.includes("--prepare");
const gens = Number(argOf("--gens") ?? 6);
const dx = Number(argOf("--dx") ?? 40);

function makeToken(role) {
  const f = join(tmpdir(), `archmap-drift-tok-${process.pid}.txt`);
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

function psql(sql) {
  return execFileSync("psql", ["-h", "localhost", "-U", "postgres", "-d", "archmap", "-t", "-A", "-c", sql],
    { env: PSQL_ENV, encoding: "utf8" }).trim();
}

async function prepare() {
  const arch = makeToken("architect");
  const projects = await api(arch, "/projects");
  const src = projects.find((p) => p.name === SOURCE_NAME);
  if (!src) throw new Error(`Источник «${SOURCE_NAME}» не найден`);
  const olds = projects.filter((p) => p.name === CLONE_NAME);
  const archived = await api(arch, "/projects?archived=true");
  olds.push(...archived.filter((p) => p.name === CLONE_NAME));
  for (const old of olds) {
    if (!old.archived_at) await api(arch, `/projects/${old.id}/archive`, { method: "POST" });
    await api(arch, `/projects/${old.id}?confirm=${encodeURIComponent(CLONE_NAME)}`, { method: "DELETE" });
  }
  const clone = await api(arch, "/projects", { method: "POST", body: JSON.stringify({ name: CLONE_NAME, start: `copy:${src.id}` }) });
  console.log(`Клон создан: ${clone.id}`);
}

// Сигнатура рёбер: id → округлённый path d. Сравниваем поколения.
async function edgeSig(page) {
  return page.evaluate(() => {
    const r1 = (v) => Math.round(v * 10) / 10;
    const roundD = (d) => (d || "").replace(/-?\d+(?:\.\d+)?/g, (s) => String(r1(+s)));
    const out = {};
    for (const e of document.querySelectorAll(".react-flow__edge")) {
      out[e.getAttribute("data-id")] = roundD(e.querySelector("path.react-flow__edge-path")?.getAttribute("d"));
    }
    return out;
  });
}

function churn(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let changed = 0, added = 0, gone = 0;
  for (const k of keys) {
    if (!(k in a)) added++;
    else if (!(k in b)) gone++;
    else if (a[k] !== b[k]) changed++;
  }
  return { changed, added, gone, total: keys.size };
}

async function settle(page) {
  let prev = null, stable = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(350);
    const busy = await page.evaluate(() => window.__archmapLayoutInflight ?? 0);
    if (busy > 0) { prev = null; stable = 0; continue; }
    const cur = JSON.stringify(await edgeSig(page));
    if (prev === cur) { if (++stable >= 2) return JSON.parse(cur); } else stable = 0;
    prev = cur;
  }
  throw new Error("Сигнатура не стабилизировалась");
}

async function run() {
  const arch = makeToken("architect");
  const projects = await api(arch, "/projects");
  const clone = projects.find((p) => p.name === CLONE_NAME);
  if (!clone) throw new Error(`Клон «${CLONE_NAME}» не найден — сначала --prepare`);

  const browser = await chromium.launch({
    executablePath: CHROME,
    env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
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
  const base = await settle(page);
  console.log(`gen 0: ${Object.keys(base).length} рёбер (база)`);

  // Выбираем корневой узел покрупнее (первый видимый не-frame) — дёргаем его.
  const nodeHandle = page.locator(".react-flow__node").first();
  const nodeId = await nodeHandle.getAttribute("data-id");
  console.log(`Дёргаем узел ${nodeId} на ±${dx}px, ${gens} поколений`);

  let prevSig = base;
  for (let g = 1; g <= gens; g++) {
    // направление чередуем: нечётные — вправо, чётные — обратно влево (возврат к базе)
    const dir = g % 2 === 1 ? dx : -dx;
    const box = await nodeHandle.boundingBox();
    if (!box) throw new Error("узел не виден");
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dir, cy, { steps: 6 });
    await page.mouse.up();
    const sig = await settle(page);
    const c = churn(prevSig, sig);
    const cBase = churn(base, sig);
    console.log(`gen ${g}: Δк-предыдущему ~${c.changed} +${c.added} -${c.gone} | Δк-базе ~${cBase.changed} +${cBase.added} -${cBase.gone}`);
    prevSig = sig;
  }
  await browser.close();
}

if (doPrepare) await prepare();
else await run();
