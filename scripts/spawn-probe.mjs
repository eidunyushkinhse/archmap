// Полигон СПАВНА детей раскрытого контейнера (эпик «структура и воздух»,
// docs/plan-spawn-spacing.md, Ф0).
//
// Замеряет геометрию ПЕРВОГО показа детей контейнера воспроизводимо и без
// мутаций живых данных: работает на одноразовом клоне проекта, раскрытие
// кликает VIEWER-ом (его раскрытия эфемерны — спавн считается и рисуется, но
// НЕ засевается; повторный прогон идентичен). Требование сценария C6/C9:
// у контейнера должна быть владеемая позиция (иначе это другой кейс —
// девственный уровень), поэтому подготовка стирает ТОЛЬКО строки детей и
// флаг expanded контейнера, а позиции узлов уровня оставляет как у оригинала.
//
// Подготовка фикстуры (мутирует ТОЛЬКО клон; повторяемо):
//   node scripts/spawn-probe.mjs --prepare [--source 'Маркетплейс «Ярмарка»']
//     → удаляет старый клон «__spawn-полигон», копирует источник (copy:),
//       в клоне снимает expanded с целевого контейнера и удаляет строки
//       view_layout его детей на корневом виде.
// Прогон (клон только читается):
//   node scripts/spawn-probe.mjs [--node 'Маркетплейс «Ярмарка»'] [--out f.json]
//     → корень клона → клик лупы контейнера → стабилизация → сигнатура +
//       метрики спавна (доля инлайн-плашек, зазоры в рамке, bbox, стрелочные).
//
// Окружение headless — как scripts/dump-levels.mjs (память headless-route-dump).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";

const pw = await import(join(homedir(), ".npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js"));
const { chromium } = pw.default;

const FRONTEND = process.env.ARCHMAP_FRONTEND ?? "http://localhost:5173";
const BACKEND = process.env.ARCHMAP_BACKEND ?? "http://localhost:8000";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome");
const CHROME_LIBS = join(homedir(), ".cache/archmap-chrome-libs/usr/lib/x86_64-linux-gnu");
const CLONE_NAME = "__spawn-полигон";
const PSQL_ENV = { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? "postgres" };

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const doPrepare = args.includes("--prepare");
const sourceName = argOf("--source") ?? "Маркетплейс «Ярмарка»";
const nodeName = argOf("--node") ?? "Маркетплейс «Ярмарка»";
const outFile = argOf("--out");
const runRole = argOf("--role") ?? "viewer"; // architect — засев спавна в клон (Ф3, доставка «Переразложить»)
const shotFile = argOf("--shot");

function makeToken(role) {
  const tokFile = join(tmpdir(), `archmap-spawn-tok-${process.pid}.txt`);
  execFileSync("backend/venv/bin/python", ["-c", `
import sys; sys.path.insert(0, 'backend')
from app.auth import create_access_token
open(${JSON.stringify(tokFile)}, 'w').write(create_access_token({'sub': 'admin', 'role': ${JSON.stringify(role)}}))
`]);
  const tok = readFileSync(tokFile, "utf8").trim();
  rmSync(tokFile);
  return tok;
}

async function api(token, path, opts = {}, projectId = null) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(projectId ? { "X-Project-Id": projectId } : {}),
  };
  const r = await fetch(`${BACKEND}/api/v1${path}`, { ...opts, headers });
  if (!r.ok && r.status !== 204) {
    throw new Error(`${opts.method ?? "GET"} ${path} -> ${r.status}: ${await r.text()}`);
  }
  return r.status === 204 ? null : r.json();
}

function psql(sql) {
  return execFileSync(
    "psql",
    ["-h", "localhost", "-U", "postgres", "-d", "archmap", "-t", "-A", "-c", sql],
    { env: PSQL_ENV, encoding: "utf8" },
  ).trim();
}

// ── Подготовка фикстуры-клона ────────────────────────────────────────────────
async function prepare() {
  const arch = makeToken("architect");
  const projects = await api(arch, "/projects");
  const src = projects.find((p) => p.name === sourceName);
  if (!src) throw new Error(`Источник «${sourceName}» не найден`);
  // клоны прежних прогонов (включая упавшие посреди prepare) сносим ВСЕ; удаление
  // гейтится архивом и подтверждением именем (двойная защита) — проходим оба
  const olds = projects.filter((p) => p.name === CLONE_NAME);
  const archived = await api(arch, "/projects?archived=true");
  olds.push(...archived.filter((p) => p.name === CLONE_NAME));
  for (const old of olds) {
    if (!old.archived_at) await api(arch, `/projects/${old.id}/archive`, { method: "POST" });
    await api(arch, `/projects/${old.id}?confirm=${encodeURIComponent(CLONE_NAME)}`, { method: "DELETE" });
    console.log(`Старый клон удалён (${old.id})`);
  }
  const clone = await api(arch, "/projects", {
    method: "POST",
    body: JSON.stringify({ name: CLONE_NAME, start: `copy:${src.id}` }),
  });
  console.log(`Клон создан: ${clone.id}`);

  const container = psql(
    `SELECT id FROM nodes WHERE project_id='${clone.id}' AND name='${nodeName.replace(/'/g, "''")}'`,
  );
  if (!container) throw new Error(`Контейнер «${nodeName}» в клоне не найден`);
  // корневой вид: снять раскрытие контейнера (позицию оставить), стереть строки детей
  psql(`UPDATE view_layout SET payload = (payload::jsonb - 'expanded')::json
        WHERE project_id='${clone.id}' AND view_id IS NULL AND item_id='${container}'`);
  const deleted = psql(`WITH gone AS (
      DELETE FROM view_layout WHERE project_id='${clone.id}' AND view_id IS NULL
        AND item_id IN (SELECT id::text FROM nodes WHERE parent_id='${container}')
      RETURNING 1) SELECT count(*) FROM gone`);
  console.log(`Фикстура готова: контейнер ${container} свёрнут, строк детей стёрто ${deleted}`);
}

// ── Сигнатура страницы (как dump-levels) ─────────────────────────────────────
async function readSignature(page) {
  return page.evaluate(() => {
    const r1 = (v) => Math.round(v * 10) / 10;
    const lastPxTranslate = (t) => {
      const m = [...(t || "").matchAll(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/g)].pop();
      return m ? { x: r1(+m[1]), y: r1(+m[2]) } : null;
    };
    const nodes = [...document.querySelectorAll(".react-flow__node")]
      .map((n) => {
        const p = lastPxTranslate(n.style.transform) ?? { x: 0, y: 0 };
        return {
          id: n.getAttribute("data-id"),
          type: [...n.classList].find((c) => c.startsWith("react-flow__node-"))?.slice("react-flow__node-".length),
          x: p.x, y: p.y,
          w: r1(n.offsetWidth), h: r1(n.offsetHeight),
        };
      })
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
    const leaders = document.querySelectorAll(".lg-edge-leader").length;
    return { nodes, edges, labels, frames, leaders };
  });
}

async function settleSignature(page) {
  let prev = null, stable = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
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

// ── Метрики спавна по сигнатуре ──────────────────────────────────────────────
function parseD(d) {
  if (!d) return [];
  const step = { C: 6, Q: 4, A: 7 };
  const pts = []; const re = /([MLCQA])\s*([-\d.,\s]+)/g; let m;
  while ((m = re.exec(d))) {
    const n = m[2].trim().split(/[\s,]+/).map(Number);
    if (m[1] === "M" || m[1] === "L") { for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] }); }
    else { const k = step[m[1]]; for (let i = k - 2; i + 1 < n.length; i += k) pts.push({ x: n[i], y: n[i + 1] }); }
  }
  return pts;
}

// осевые сегменты со слиянием коллинеарных кусков (мостики дробят линию)
function axSegs(pts) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
    const h = Math.abs(dy) <= Math.abs(dx);
    const c = h ? (a.y + b.y) / 2 : (a.x + b.x) / 2;
    const lo = h ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = h ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const last = out[out.length - 1];
    if (last && last.h === h && Math.abs(last.c - c) < 0.75 && lo <= last.hi + 0.75) {
      last.hi = Math.max(last.hi, hi); last.lo = Math.min(last.lo, lo);
    } else out.push({ h, c, lo, hi });
  }
  return out;
}

function distToPath(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

const HAIRPIN_JOG = 30; // как arrow-metrics
const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];

export function spawnMetrics(sig, containerId) {
  const paths = sig.edges.map((e) => parseD(e.d));
  // плашки: инлайн ↔ выноска (центр дальше 16px от любой линии — leader)
  let inline = 0, leader = 0;
  for (const lb of sig.labels) {
    const d = Math.min(...paths.map((p) => distToPath(lb, p)), Infinity);
    if (d > 16) leader++; else inline++;
  }
  // рамка целевого контейнера и узлы внутри
  const frame = sig.frames.find((f) => f.id === containerId) ?? null;
  let inFrame = [], gaps = [], inkIn = 0;
  if (frame) {
    inFrame = sig.nodes.filter((n) =>
      n.x >= frame.x && n.y >= frame.y && n.x + n.w <= frame.x + frame.w && n.y + n.h <= frame.y + frame.h);
    for (let i = 0; i < inFrame.length; i++) for (let k = i + 1; k < inFrame.length; k++) {
      const a = inFrame[i], b = inFrame[k];
      const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      if (gx < 0 && gy >= 0) gaps.push(gy);
      else if (gy < 0 && gx >= 0) gaps.push(gx);
    }
    gaps.sort((a, b) => a - b);
    for (const p of paths) for (let i = 0; i + 1 < p.length; i++) {
      const a = p[i], b = p[i + 1];
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h)
        inkIn += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    }
  }
  // стрелочные: развороты/шпильки/изломы/длина (как arrow-metrics) + кресты (строго
  // внутри обоих, дедуп по точке) + сегменты над узлами
  let reversals = 0, hairpins = 0, bends = 0, len = 0, overNodes = 0;
  const dirsOf = (pts) => {
    const dirs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
      const L = Math.abs(dx) + Math.abs(dy);
      if (L < 0.5) continue;
      dirs.push({ d: Math.abs(dy) <= Math.abs(dx) ? (dx > 0 ? "R" : "L") : (dy > 0 ? "D" : "U"), L });
      len += L;
    }
    return dirs;
  };
  const OPP = { R: "L", L: "R", U: "D", D: "U" };
  const bodies = sig.nodes.map((n) => ({ minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h }));
  for (const p of paths) {
    const dirs = dirsOf(p);
    bends += Math.max(0, dirs.length - 1);
    for (let i = 0; i + 2 < dirs.length; i++) {
      if (dirs[i + 2].d === OPP[dirs[i].d]) {
        reversals++;
        if (dirs[i + 1].L <= HAIRPIN_JOG) hairpins++;
      }
    }
    for (const s of axSegs(p)) {
      for (const b of bodies) {
        const [x1, x2] = s.h ? [s.lo, s.hi] : [s.c, s.c];
        const [y1, y2] = s.h ? [s.c, s.c] : [s.lo, s.hi];
        const ox = Math.min(x2, b.maxX - 2) - Math.max(x1, b.minX + 2);
        const oy = Math.min(y2, b.maxY - 2) - Math.max(y1, b.minY + 2);
        if ((s.h ? ox : oy) > 4 && (s.h ? y1 > b.minY + 2 && y1 < b.maxY - 2 : x1 > b.minX + 2 && x1 < b.maxX - 2)) {
          overNodes++;
          break;
        }
      }
    }
  }
  let crosses = 0;
  const allSegs = paths.map(axSegs);
  for (let i = 0; i < allSegs.length; i++) for (let k = i + 1; k < allSegs.length; k++) {
    const seen = new Set();
    for (const A of allSegs[i]) for (const B of allSegs[k]) {
      if (A.h === B.h) continue;
      const [H, V] = A.h ? [A, B] : [B, A];
      if (V.c > H.lo + 1.5 && V.c < H.hi - 1.5 && H.c > V.lo + 1.5 && H.c < V.hi - 1.5) {
        const key = `${Math.round(V.c)}|${Math.round(H.c)}`;
        if (!seen.has(key)) { seen.add(key); crosses++; }
      }
    }
  }
  return {
    labels: {
      total: sig.labels.length,
      // честный счёт выносок — по DOM-поводкам (.lg-edge-leader); прокси по
      // дистанции оставлен для сравнения со старыми дампами без leaders
      leadersDom: sig.leaders ?? null,
      inline, leader,
      inlineShare: sig.labels.length ? +(inline / sig.labels.length).toFixed(3) : 1,
    },
    frame: frame && {
      w: frame.w, h: frame.h, areaKpx: Math.round(frame.w * frame.h / 1000),
      nodesInside: inFrame.length,
      gaps: gaps.length ? { min: Math.round(gaps[0]), p25: Math.round(q(gaps, 0.25)), median: Math.round(q(gaps, 0.5)) } : null,
      inkPx: Math.round(inkIn),
    },
    arrows: { edges: sig.edges.length, crosses, reversals, hairpins, bends, lenPx: Math.round(len), overNodes },
  };
}

// ── Прогон: раскрыть контейнер вьюером и замерить ────────────────────────────
async function run() {
  const viewer = makeToken(runRole);
  const projects = await api(viewer, "/projects");
  const clone = projects.find((p) => p.name === CLONE_NAME);
  if (!clone) throw new Error(`Клон «${CLONE_NAME}» не найден — сначала --prepare`);
  const nodesAll = await api(viewer, "/nodes", {}, clone.id);
  const container = nodesAll.find((n) => n.name === nodeName && n.parent_id == null);
  if (!container) throw new Error(`Контейнер «${nodeName}» не найден в клоне`);

  const browser = await chromium.launch({
    executablePath: CHROME,
    env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.text().includes("[dbg-spawn]")) console.log(m.text()); });
  await page.goto(FRONTEND);
  await page.evaluate(
    ([tok, pid]) => {
      localStorage.setItem("access_token", tok);
      localStorage.setItem("archmap.lastProjectId", pid);
    },
    [viewer, clone.id],
  );
  await page.goto(`${FRONTEND}/#/p/${clone.id}`);
  await page.reload();
  await page.waitForSelector(".react-flow", { timeout: 20000 });
  await settleSignature(page);

  // лупа целевого контейнера (клик по элементу вне вьюпорта молча теряется — fitView);
  // контейнер уже раскрыт (persist-раскрытие после architect-прогона) → без клика
  await page.locator(".react-flow__controls-fitview").click({ force: true });
  await page.waitForTimeout(150);
  const node = page.locator(`.react-flow__node[data-id="${container.id}"]`);
  const frameSel = page.locator(`.lg-frame[data-frame-id="${container.id}"]`);
  let sig;
  if ((await node.count()) > 0 && (await node.locator('button[title="Раскрыть содержимое"]').count()) > 0) {
    await node.hover({ force: true });
    await node.locator('button[title="Раскрыть содержимое"]').click({ force: true });
    sig = await settleSignature(page);
  } else if ((await frameSel.count()) > 0) {
    console.log("Контейнер уже раскрыт (persist) — снимаем как есть");
    sig = await settleSignature(page);
  } else {
    throw new Error("Контейнер не отображается на корне ни узлом, ни рамкой");
  }
  if (shotFile) {
    await page.locator(".react-flow__controls-fitview").click({ force: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotFile });
    console.log(`Скриншот: ${shotFile}`);
  }
  await browser.close();

  const metrics = spawnMetrics(sig, container.id);
  console.log(JSON.stringify(metrics, null, 1));
  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify({ clone: clone.id, container: container.id, metrics, sig }, null, 1));
    console.log(`Сохранено: ${outFile}`);
  }
}

if (doPrepare) await prepare();
else await run();
