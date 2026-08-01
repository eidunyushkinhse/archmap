// Зонд ТРОЙНИКА ОБЩЕГО ПЛЕЧА (диагноз 2026-08-01, tasks.md).
//
// Воспроизводит сцену пользователя: страница «Маркетплейс «Ярмарка»», раскрыт сам
// Маркетплейс, внутри раскрыты «Сервис оплаты» и «Сервис поиска». Три связи —
// «Инициация оплаты» (API Gateway → Payment API), «Выставление счёта» (Оркестратор
// заказа → Payment API), «Создание отправления» (Оркестратор заказа → Служба
// доставки): первая пара делит цель, вторая — источник, третья (Инициация ↔
// Создание) не делит НИЧЕГО, но все три едут по одному сегменту — нелегальный
// тройник (E25: общее плечо — только попарно, от общего порта одной роли).
//
// Детектор (чистая геометрия по path d, без знания легальности из кода):
//  • НЕЛЕГАЛЬНАЯ ПАРА: коллинеарное перекрытие (|Δоси| ≤ 0.75, пробег > 0.5),
//    НЕ покрытое общим префиксом/суффиксом пары (walk по точкам, зернит trunks.ts);
//  • ТРОЙНИК: осевая линия, где интервалы ≥ 3 рёбер имеют общую точку.
//
// Запуск (dev-стек поднят: ./dev.sh):
//   node scripts/triple-probe.mjs --prepare   # создать клон __triple-полигон
//   node scripts/triple-probe.mjs             # прогон: отчёт по сцене
//   node scripts/triple-probe.mjs --cleanup   # удалить клон
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
const CLONE_NAME = "__triple-полигон";
const SOURCE_NAME = "Маркетплейс «Ярмарка»";
const FOCUS_NAME = "Маркетплейс «Ярмарка»";
// Раскрытия лупой ПОСЛЕДОВАТЕЛЬНО (Маркетплейс → его дети Сервис оплаты/Сервис поиска)
const EXPAND_NAMES = ["Маркетплейс «Ярмарка»", "Сервис оплаты", "Сервис поиска"];

const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const doPrepare = args.includes("--prepare");
const doCleanup = args.includes("--cleanup");
const SOURCE = argOf("--source") ?? SOURCE_NAME;
const CLONE = argOf("--clone") ?? CLONE_NAME;
// page — страница фокусного узла с раскрытиями (сценарий пользователя);
// map — корневой уровень редактора-карты (быстрый детектор-скан проекта).
const MODE = argOf("--mode") ?? "page";

function makeToken(role) {
  const f = join(tmpdir(), `archmap-triple-tok-${process.pid}.txt`);
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

async function removeClones(arch) {
  const projects = await api(arch, "/projects");
  const olds = projects.filter((p) => p.name === CLONE);
  const archived = await api(arch, "/projects?archived=true");
  olds.push(...archived.filter((p) => p.name === CLONE));
  for (const old of olds) {
    if (!old.archived_at) await api(arch, `/projects/${old.id}/archive`, { method: "POST" });
    await api(arch, `/projects/${old.id}?confirm=${encodeURIComponent(old.name)}`, { method: "DELETE" });
  }
  return olds.length;
}

async function prepare() {
  const arch = makeToken("architect");
  const projects = await api(arch, "/projects");
  const src = projects.find((p) => p.name === SOURCE);
  if (!src) throw new Error(`Источник «${SOURCE}» не найден`);
  await removeClones(arch);
  const clone = await api(arch, "/projects", { method: "POST", body: JSON.stringify({ name: CLONE, start: `copy:${src.id}` }) });
  console.log(`Клон создан: ${clone.id}`);
}

async function cleanup() {
  const arch = makeToken("architect");
  const n = await removeClones(arch);
  console.log(n ? `Удалено клонов: ${n}` : "Клонов нет");
}

// ── Геометрия (d → точки → осевые сегменты) ─────────────────────────
// parseD из arrow-metrics: M/L как есть; у кривых — конечная точка (C шаг 6,
// Q шаг 4, A шаг 7 — дуги-мостики над пересечениями).
function parseD(d) {
  if (!d) return [];
  const step = { C: 6, Q: 4, A: 7 };
  const pts = [];
  const re = /([MLCQA])\s*([-\d.,\s]+)/g;
  let m;
  while ((m = re.exec(d))) {
    const n = m[2].trim().split(/[\s,]+/).map(Number);
    if (m[1] === "M" || m[1] === "L") { for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] }); }
    else { const k = step[m[1]]; for (let i = k - 2; i + 1 < n.length; i += k) pts.push({ x: n[i], y: n[i + 1] }); }
  }
  return pts;
}

const EPS = 0.5;
const NEAR_AXIS = 0.75; // допуск канала E28: точно наложенные плечи

// Точки → осевые сегменты с дугой. Диагонали и коротыши (<3px, артефакты
// скруглений/мостиков) пропускаем: детектор смотрит на реальные плечи.
function axialSegs(pts) {
  const out = [];
  let arc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.abs(dx) + Math.abs(dy);
    if (len <= EPS) continue;
    const horiz = Math.abs(dy) <= EPS;
    const vert = Math.abs(dx) <= EPS;
    if ((horiz || vert) && len > 3) {
      out.push({
        axis: horiz ? "h" : "v",
        c: horiz ? a.y : a.x,            // постоянная координата линии
        start: horiz ? a.x : a.y,        // варьируемая в начале (по ходу)
        lo: horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y),
        hi: horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y),
        arc0: arc, arc1: arc + len,
      });
    }
    arc += len;
  }
  return out;
}
const totalArc = (segs) => (segs.length ? segs[segs.length - 1].arc1 : 0);

// дуга точки на сегменте (вдоль оси от start)
const arcAt = (s, coord) => s.arc0 + Math.abs(coord - s.start);

// Общий ПРЕФИКС двух ломаных (зерно trunks.ts/prefixWalk): идём параллельно,
// пока направления совпадают; возврат — длина общего куска (arc-length по A).
function prefixLen(pa, pb) {
  if (pa.length < 2 || pb.length < 2) return 0;
  const near = (a, b) => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
  if (!near(pa[0], pb[0])) return 0;
  let ia = 0, ib = 0, len = 0;
  let posA = pa[0], posB = pb[0];
  while (ia < pa.length - 1 && ib < pb.length - 1) {
    const ax = pa[ia + 1].x - posA.x, ay = pa[ia + 1].y - posA.y;
    const bx = pb[ib + 1].x - posB.x, by = pb[ib + 1].y - posB.y;
    const aH = Math.abs(ay) <= EPS, aV = Math.abs(ax) <= EPS;
    const bH = Math.abs(by) <= EPS, bV = Math.abs(bx) <= EPS;
    if (!(aH || aV) || !(bH || bV)) break;
    const aAxis = aH ? "h" : "v", bAxis = bH ? "h" : "v";
    const aSign = aH ? Math.sign(ax) : Math.sign(ay);
    const bSign = bH ? Math.sign(bx) : Math.sign(by);
    if (aAxis !== bAxis || aSign !== bSign) break;
    const la = Math.abs(aH ? ax : ay), lb = Math.abs(bH ? bx : by);
    const run = Math.min(la, lb);
    if (run <= EPS) break;
    len += run;
    const aEnds = la - run <= EPS, bEnds = lb - run <= EPS;
    if (aEnds !== bEnds) break;
    ia++; ib++;
    posA = pa[ia]; posB = pb[ib];
  }
  return len;
}
const suffixLen = (a, b) => prefixLen([...a].reverse(), [...b].reverse());

// ── Браузерная часть ────────────────────────────────────────────────
async function settle(page) {
  let prev = null, stable = 0;
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(350);
    const busy = await page.evaluate(() => window.__archmapLayoutInflight ?? 0);
    if (busy > 0) { prev = null; stable = 0; continue; }
    const cur = JSON.stringify(await edgeSig(page));
    if (prev === cur) { if (++stable >= 2) return JSON.parse(cur); } else stable = 0;
    prev = cur;
  }
  throw new Error("Сигнатура не стабилизировалась");
}

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

// Клик лупы «Раскрыть содержимое» на узле с данным именем (узел ищется по
// тексту, кнопка — внутри; после раскрытия узел заменяется рамкой).
async function expandByName(page, name) {
  const clicked = await page.evaluate((nm) => {
    for (const n of document.querySelectorAll(".react-flow__node")) {
      if (n.classList.contains("react-flow__node-frame")) continue;
      if (!n.textContent?.includes(nm)) continue;
      const btn = n.querySelector('button[title="Раскрыть содержимое"]');
      if (btn) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }
    }
    return false;
  }, name);
  if (!clicked) throw new Error(`Не найдена лупа узла «${name}»`);
}

async function run() {
  const arch = makeToken("architect");
  const projects = await api(arch, "/projects");
  const clone = projects.find((p) => p.name === CLONE);
  if (!clone) throw new Error(`Клон «${CLONE}» не найден — сначала --prepare`);

  // id узлов и рёбра клона (для имён в отчёте)
  const allNodes = await api(arch, "/nodes/all", {}, clone.id);
  const nodeName = new Map(allNodes.map((n) => [n.id, n.name]));
  const focus = allNodes.find((n) => n.name === FOCUS_NAME);
  if (MODE === "page" && !focus) throw new Error(`Узел «${FOCUS_NAME}» не найден в клоне`);
  const allEdges = await api(arch, "/edges/", {}, clone.id);
  const edgeLabel = new Map(allEdges.map((e) => [e.id,
    `${e.label || "(без подписи)"} [${nodeName.get(e.source_id) ?? "?"} → ${nodeName.get(e.target_id) ?? "?"}]`]));

  const browser = await chromium.launch({
    executablePath: CHROME,
    env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text().slice(0, 300)); });
  await page.goto(FRONTEND);
  await page.evaluate(([tok, pid]) => {
    localStorage.setItem("access_token", tok);
    localStorage.setItem("archmap.lastProjectId", pid);
  }, [arch, clone.id]);
  const route = MODE === "map" ? `#/p/${clone.id}/map` : `#/p/${clone.id}/nodes/${focus.id}`;
  await page.goto(`${FRONTEND}/${route}`);
  await page.reload();
  try {
    await page.waitForSelector(".react-flow", { timeout: 25000 });
  } catch (e) {
    await page.screenshot({ path: "/tmp/triple-probe-fail.png" }).catch(() => {});
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(() => "");
    console.error("react-flow не появился; тело страницы:", body);
    throw e;
  }
  if (MODE === "page") {
    // Блок схемы инертен до клика-активации
    await page.locator(".esb-activate").click({ force: true }).catch(() => {});
    await settle(page);
    // Раскрытия по сценарию пользователя
    for (const nm of EXPAND_NAMES) {
      await expandByName(page, nm);
      await settle(page);
      console.log(`раскрыт: ${nm}`);
    }
  }
  const sig = await settle(page);
  await browser.close();

  // ── Детектор ──────────────────────────────────────────────────────
  const routes = new Map(); // id → { pts, segs, total }
  for (const [id, d] of Object.entries(sig)) {
    const pts = parseD(d);
    if (pts.length < 2) continue;
    const segs = axialSegs(pts);
    routes.set(id, { pts, segs, total: totalArc(segs) });
  }
  const ids = [...routes.keys()].sort();
  const label = (id) => edgeLabel.get(id) ?? id;

  // Попарно нелегальные перекрытия
  const illegalPairs = [];
  let sceneIllegal = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = routes.get(ids[i]), B = routes.get(ids[j]);
      const pref = prefixLen(A.pts, B.pts);
      const suf = suffixLen(A.pts, B.pts);
      let illegal = 0;
      for (const sa of A.segs) {
        for (const sb of B.segs) {
          if (sa.axis !== sb.axis) continue;
          if (Math.abs(sa.c - sb.c) > NEAR_AXIS) continue;
          const lo = Math.max(sa.lo, sb.lo), hi = Math.min(sa.hi, sb.hi);
          if (hi - lo <= EPS) continue;
          // дуговой интервал перекрытия на A
          const oa = arcAt(sa, lo), ob = arcAt(sa, hi);
          const olo = Math.min(oa, ob), ohi = Math.max(oa, ob);
          // покрытие легальным куском пары: [0, pref] ∪ [total − suf, total]
          let free = 0;
          if (pref > EPS) free += Math.max(0, Math.min(ohi, pref) - olo);
          if (suf > EPS) free += Math.max(0, ohi - Math.max(olo, A.total - suf));
          illegal += Math.max(0, (ohi - olo) - free);
        }
      }
      if (illegal > 1) {
        illegalPairs.push({ a: ids[i], b: ids[j], px: Math.round(illegal * 10) / 10 });
        sceneIllegal += illegal;
      }
    }
  }
  illegalPairs.sort((x, y) => y.px - x.px);

  // Тройники: бакеты по осевой линии, пересечение интервалов ≥ 3 рёбер
  const lines = new Map(); // "h|50.0" → [{ lo, hi, id }]
  for (const id of ids) {
    for (const s of routes.get(id).segs) {
      const k = `${s.axis}|${(Math.round(s.c * 2) / 2).toFixed(1)}`;
      (lines.get(k) ?? lines.set(k, []).get(k)).push({ lo: s.lo, hi: s.hi, id });
    }
  }
  const triples = [];
  for (const [k, segs] of lines) {
    // развёртки событий: считаем глубину, ловим интервалы глубины ≥ 3
    const events = [];
    for (const s of segs) { events.push([s.lo, 1, s.id]); events.push([s.hi, -1, s.id]); }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const active = new Set();
    let prev = null;
    for (const [x, d, id] of events) {
      if (prev !== null && x - prev > EPS && active.size >= 3) {
        triples.push({ line: k, lo: prev, hi: x, ids: [...active] });
      }
      if (d === 1) active.add(id); else active.delete(id);
      prev = x;
    }
  }
  // склейка смежных интервалов тройника на одной линии с тем же составом
  const merged = [];
  for (const t of triples.sort((a, b) => a.line.localeCompare(b.line) || a.lo - b.lo)) {
    const key = [...t.ids].sort().join(",");
    const last = merged[merged.length - 1];
    if (last && last.line === t.line && [...last.ids].sort().join(",") === key && t.lo - last.hi <= 1) {
      last.hi = t.hi;
    } else {
      merged.push({ ...t, key });
    }
  }

  // ── Отчёт ─────────────────────────────────────────────────────────
  console.log(`\n=== рёбер на сцене: ${ids.length} ===`);
  console.log(`\nНЕЛЕГАЛЬНЫЕ ПАРЫ (перекрытие вне общего префикса/суффикса): ${illegalPairs.length}`);
  for (const p of illegalPairs.slice(0, 15)) {
    console.log(`  ${p.px}px  ${label(p.a)}  ↔  ${label(p.b)}`);
  }
  console.log(`  итого по сцене: ${Math.round(sceneIllegal)}px`);
  console.log(`\nТРОЙНИКИ (≥ 3 рёбер на одной линии): ${merged.length}`);
  for (const t of merged) {
    console.log(`  ${t.line}  x∈[${Math.round(t.lo)}, ${Math.round(t.hi)}] (${Math.round(t.hi - t.lo)}px):`);
    for (const id of t.ids) console.log(`     • ${label(id)}`);
  }
}

if (doPrepare) await prepare();
else if (doCleanup) await cleanup();
else await run();
