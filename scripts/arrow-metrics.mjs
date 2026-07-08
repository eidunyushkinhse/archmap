// Метрики качества стрелок по дампу полигона (V2.6 эпика стрелок, ARROWS_V2_ANALYSIS.md).
//
// Читает JSON от scripts/dump-levels.mjs и считает по каждому ребру:
//   • развороты — антипараллельные сегменты i и i+2 (широкая «П» легитимна, но следим);
//   • шпильки — разворот с коротким средним сегментом (<= 30px): визуальный дефект,
//     после V2.1 у авто-рёбер их быть НЕ должно;
//   • изломы и манхэттенову длину.
// Одним аргументом — сводка и топ проблемных рёбер; двумя — сравнение «до → после».
//
//   node scripts/arrow-metrics.mjs scripts/.polygon/baseline-post-V22.json
//   node scripts/arrow-metrics.mjs old.json new.json
import { readFileSync } from "node:fs";

const HAIRPIN_JOG = 30;

// path d → точки (M/L как есть; у C-кривой скругления берём конечную точку)
function parseD(d) {
  if (!d) return [];
  const pts = []; const re = /([MLC])\s*([-\d.,\s]+)/g; let m;
  while ((m = re.exec(d))) {
    const n = m[2].trim().split(/[\s,]+/).map(Number);
    if (m[1] === "M" || m[1] === "L") { for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] }); }
    else { for (let i = 4; i + 1 < n.length; i += 6) pts.push({ x: n[i], y: n[i + 1] }); }
  }
  return pts;
}

// точки → осевые сегменты с направлением (соседние однонаправленные сливаются:
// артефакты скруглений не плодят ложных изломов)
function segs(pts) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
    const len = Math.abs(dx) + Math.abs(dy); if (len < 0.5) continue;
    const s = { dx: Math.abs(dx) > Math.abs(dy) ? Math.sign(dx) : 0, dy: Math.abs(dy) >= Math.abs(dx) ? Math.sign(dy) : 0, len };
    const last = out[out.length - 1];
    if (last && last.dx === s.dx && last.dy === s.dy) last.len += s.len; else out.push(s);
  }
  return out;
}

function collect(file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const rows = new Map();
  for (const lvl of j.levels) for (const e of (lvl.sig.edges ?? [])) {
    const ss = segs(parseD(e.d));
    let revs = 0, hairpins = 0;
    for (let i = 0; i + 2 < ss.length + 0 && ss[i + 2]; i++) {
      const a = ss[i], b = ss[i + 1], c = ss[i + 2];
      if (a.dx === -c.dx && a.dy === -c.dy && (a.dx !== 0 || a.dy !== 0)) {
        revs++;
        if (b.len <= HAIRPIN_JOG) hairpins++;
      }
    }
    rows.set(`${lvl.path.join(">") || "root"}:${lvl.state}:${e.id}`, {
      revs, hairpins, bends: Math.max(0, ss.length - 1),
      len: Math.round(ss.reduce((s, x) => s + x.len, 0)),
      shape: ss.map((s) => (s.dx ? (s.dx > 0 ? "R" : "L") : (s.dy > 0 ? "D" : "U"))).join(""),
      lens: ss.map((s) => Math.round(s.len)).join(","),
    });
  }
  return rows;
}

const sum = (rows, f) => [...rows.values()].reduce((s, r) => s + f(r), 0);
const withRevs = (rows) => [...rows.values()].filter((r) => r.revs > 0).length;

function summary(name, rows) {
  console.log(`${name}: рёбер ${rows.size}, шпилек ${sum(rows, (r) => r.hairpins)}, ` +
    `разворотов ${sum(rows, (r) => r.revs)} (рёбер с ними ${withRevs(rows)}), ` +
    `изломов ${sum(rows, (r) => r.bends)}, длина ${sum(rows, (r) => r.len)}`);
}

const [fa, fb] = process.argv.slice(2);
if (!fa) { console.error("Нужен файл дампа (и, опционально, второй для сравнения)"); process.exit(2); }
const A = collect(fa);
summary(fa.split("/").pop(), A);
if (!fb) {
  const bad = [...A.entries()].filter(([, r]) => r.hairpins > 0 || r.revs > 0)
    .sort((x, y) => y[1].hairpins - x[1].hairpins || y[1].revs - x[1].revs).slice(0, 15);
  for (const [k, r] of bad) console.log(`  шпилек ${r.hairpins}, разворотов ${r.revs} | ${k.slice(0, 70)} | ${r.shape} ${r.lens}`);
} else {
  const B = collect(fb);
  summary(fb.split("/").pop(), B);
  console.log("Диффы (изменились развороты или изломы на ≥2):");
  for (const [k, b] of B) {
    const a = A.get(k); if (!a) continue;
    if (a.revs !== b.revs || Math.abs(a.bends - b.bends) >= 2)
      console.log(`  ${a.revs}→${b.revs} rev, ${a.bends}→${b.bends} bend | ${k.slice(0, 58)}\n    было:  ${a.shape} ${a.lens}\n    стало: ${b.shape} ${b.lens}`);
  }
}
