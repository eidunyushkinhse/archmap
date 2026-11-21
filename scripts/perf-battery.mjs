// Батарея сценариев движка холста (эпик render-scale, docs/plan-render-scale.md).
//
// Один проход по сценариям пользователя на живом стеке, wall-clock каждого шага:
//   открытие корня → раскрытие контейнера → сворачивание → повторное раскрытие →
//   перетаскивание узла (архитектор) → вход на уровень контейнера → возврат на корень →
//   страница объекта → режим «Развёртывание» → повторное открытие корня.
// На шаг: время до тишины, время конвейера в полёте и число прогонов, фризы главного
// потока (разрыв rAF больше 100 мс), частота кадров при перетаскивании, размер сцены в DOM.
// В отличие от perf-probe.mjs (одно открытие и раскрытия по списку) проходит весь путь
// пользователя и умеет сохранять ВСЕ входы конвейера каждого шага для оффлайн-реплея
// (frontend: npm run replay-prof / npm run stage-table).
//
// Запуск (стек поднят; адреса — ARCHMAP_FRONTEND / ARCHMAP_BACKEND, как у прочих зондов):
//   node scripts/perf-battery.mjs --project "Стенд: hub25" --hub "Ядро платформы"
// Опции:
//   --role viewer|architect   читатель (по умолчанию; раскрытия эфемерны, база не меняется)
//                             или архитектор (раскладка сохраняется: сцену стенда потом
//                             пересоздать scripts/perf-scenes.py)
//   --drag <имя узла>         шаг перетаскивания (только архитектор)
//   --short                   только открытие корня, раскрытие и вход на уровень
//   --deploy                  шаг режима «Развёртывание»
//   --capture-dir <каталог>   входы конвейера шагов: <шаг>-run<N>.json
//   --out <файл.json>         результаты машинно
//   --timeout <мс на шаг>     по умолчанию 180000
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeToken } from "./probeToken.mjs";

const pw = await import(join(homedir(), ".npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js"));
const { chromium } = pw.default;
const FRONTEND = process.env.ARCHMAP_FRONTEND ?? "http://localhost:5173";
const BACKEND = process.env.ARCHMAP_BACKEND ?? "http://localhost:8000";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome");
const CHROME_LIBS = join(homedir(), ".cache/archmap-chrome-libs/usr/lib/x86_64-linux-gnu");

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const projectName = argOf("--project");
const hubName = argOf("--hub");
const role = argOf("--role") ?? "viewer";
const dragName = argOf("--drag");
const outFile = argOf("--out");
const captureDir = argOf("--capture-dir");
const stepTimeout = Number(argOf("--timeout") ?? 180000);
const short = args.includes("--short");
const withDeploy = args.includes("--deploy");
if (!projectName) { console.error("Нужен --project <имя>"); process.exit(2); }

const token = makeToken(role);
async function api(path, projectId = null) {
  const headers = { Authorization: `Bearer ${token}`, ...(projectId ? { "X-Project-Id": projectId } : {}) };
  const r = await fetch(`${BACKEND}/api/v1${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}
const projects = await api("/projects");
const project = projects.filter((p) => !p.archived_at).find((p) => p.name === projectName);
if (!project) throw new Error(`Проект «${projectName}» не найден`);
const allNodes = await api("/nodes/all", project.id);
// имя → узел; при тёзках предпочитаем контейнер (у раскрытий и уровней дети есть)
const byName = (name) => {
  const cand = allNodes.filter((n) => n.name === name);
  if (cand.length === 0) throw new Error(`Узел «${name}» не найден`);
  return cand.find((n) => allNodes.some((c) => c.parent_id === n.id)) ?? cand[0];
};
const hub = hubName ? byName(hubName) : null;

const browser = await chromium.launch({
  executablePath: CHROME,
  env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// Рекордер шага: rAF-петля пишет полёты конвейера и фризы главного потока. Заодно ловит
// входы конвейера: хук захвата пишет «последний вход» в глобал, сеттер складывает все.
async function recStart() {
  await page.evaluate(() => {
    const w = window;
    if (w.__perfRec) w.__perfRec.stopped = true;
    const rec = { t0: performance.now(), events: [], frames: 0, inputs: [], stopped: false };
    w.__perfRec = rec;
    w.__archmapCaptureInput = true;
    Object.defineProperty(w, "__archmapLastPipelineInput", {
      configurable: true,
      get: () => undefined,
      set: (v) => {
        w.__perfRec.inputs.push(JSON.stringify(v, (_k, x) => (
          x instanceof Set ? { __set: [...x] } : x instanceof Map ? { __map: [...x] } : x
        )));
      },
    });
    let last = performance.now();
    let lastInflight = w.__archmapLayoutInflight ?? 0;
    let openT = lastInflight > 0 ? 0 : null; // конвейер уже в полёте на старте
    const loop = () => {
      if (rec.stopped) return;
      const now = performance.now();
      const gap = now - last;
      rec.frames++;
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
async function recStop() {
  return page.evaluate(() => {
    const rec = window.__perfRec; rec.stopped = true;
    const pip = rec.events.filter((e) => e.type === "pipeline");
    const stalls = rec.events.filter((e) => e.type === "stall");
    return {
      pipelineMs: pip.reduce((s, e) => s + e.ms, 0),
      pipelineRuns: pip.length,
      pipelineEach: pip.map((e) => e.ms),
      pipelineInputs: rec.inputs.length,
      maxStallMs: stalls.reduce((m, e) => Math.max(m, e.ms), 0),
      stallTotalMs: stalls.reduce((s, e) => s + e.ms, 0),
      lastEventEndMs: Math.round(rec.events.reduce((m, e) => Math.max(m, e.t + (e.ms ?? 0)), 0)),
      inputs: rec.inputs,
    };
  });
}
// тишина: конвейер не в полёте и (прогоны, число узлов и рёбер в DOM) неизменны 2 с подряд
async function waitQuiet() {
  const t0 = Date.now();
  let lastKey = "", quietSince = null;
  for (;;) {
    if (Date.now() - t0 > stepTimeout) throw new Error(`не устаканилось за ${stepTimeout} мс`);
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
      if (Date.now() - quietSince >= 2000) return st;
    } else { quietSince = null; lastKey = key; }
  }
}

const results = { project: projectName, role, frontend: FRONTEND, steps: [] };
const sec = (ms) => (ms / 1000).toFixed(1) + " с";
async function step(tag, name, action) {
  await recStart();
  await action();
  const quiet = await waitQuiet();
  const { inputs, ...rec } = await recStop();
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true });
    inputs.forEach((json, i) => writeFileSync(join(captureDir, `${tag}-run${i + 1}.json`), json));
  }
  const s = { tag, name, wallMs: rec.lastEventEndMs, ...rec, scene: { nodes: quiet.n, edges: quiet.e } };
  results.steps.push(s);
  console.log(
    `[${name}] до тишины ${sec(s.wallMs)} | конвейер ${sec(rec.pipelineMs)}` +
    ` (${rec.pipelineEach.join("+") || "0"} мс, входов ${rec.pipelineInputs})` +
    ` | макс. фриз ${rec.maxStallMs} мс | сцена ${quiet.n}/${quiet.e}`,
  );
  return s;
}
const setHash = (h) => page.evaluate((x) => { location.hash = x; }, h);

// Старт со списка проектов (схем там нет): рекордер ставится ДО перехода на карту, и
// переход идёт сменой хэша — документ не перезагружается, первый прогон пойман целиком.
await page.goto(`${FRONTEND}/#/projects`);
await page.evaluate(([tok, pid]) => {
  localStorage.setItem("access_token", tok);
  localStorage.setItem("archmap.lastProjectId", pid);
}, [token, project.id]);
await page.reload();
await page.waitForSelector("body", { timeout: 30000 });
await page.waitForTimeout(1000);

await step("root", "открытие корня, холодное", () => setHash(`#/p/${project.id}/map`));

if (hub) {
  const lupa = `.react-flow__node[data-id="${hub.id}"] button[title="Раскрыть содержимое"]`;
  const expand = async () => {
    await page.waitForSelector(lupa, { timeout: 15000, state: "attached" });
    await page.locator(lupa).first().evaluate((el) => el.click());
  };
  // сохранённые раскрытия (эталоны): свернуть всё, чтобы первое раскрытие было честным;
  // глубже сначала — иначе вложенные «воскресают» при раскрытии родителя
  if ((await page.locator(lupa).count()) === 0) {
    for (let i = 0; i < 30; i++) {
      const btn = page.locator('button[title="Свернуть"]').last();
      if ((await btn.count()) === 0) break;
      await btn.evaluate((el) => el.click());
      await waitQuiet();
    }
    console.log("   (сохранённые раскрытия свёрнуты перед сценарием)");
  }
  await step("expand", `раскрытие «${hubName}», первое`, expand);
  if (!short) {
    await step("collapse", "сворачивание", async () => {
      await page.locator('button[title="Свернуть"]').last().evaluate((el) => el.click());
    });
    await step("expand2", "раскрытие повторное", expand);
  }
  if (dragName && role !== "viewer" && !short) {
    // Узел брать ближе к центру холста: у края включается автопрокрутка, и узел уезжает
    // на тысячи пикселей (память ui-verification-headless).
    const dn = byName(dragName);
    const bb = await page.locator(`.react-flow__node[data-id="${dn.id}"]`).first().boundingBox();
    if (bb) {
      const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
      let frames = 0, dragMs = 0;
      const s = await step("drag", `перетаскивание «${dragName}» и отпускание`, async () => {
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        const f0 = await page.evaluate(() => window.__perfRec.frames);
        const t0 = Date.now();
        for (let i = 1; i <= 40; i++) { await page.mouse.move(cx + i * 3, cy + i * 1.5); await page.waitForTimeout(16); }
        dragMs = Date.now() - t0;
        frames = (await page.evaluate(() => window.__perfRec.frames)) - f0;
        await page.mouse.up();
      });
      s.dragFps = Math.round((frames * 1000) / dragMs);
      console.log(`   кадров при перетаскивании: ${s.dragFps} к/с`);
    }
  }
  await step("level", "вход на уровень контейнера", () => setHash(`#/p/${project.id}/map/${hub.id}`));
  if (!short) {
    await step("back", "возврат на корень", () => setHash(`#/p/${project.id}/map`));
    await step("node-page", "страница объекта", () => setHash(`#/p/${project.id}/nodes/${hub.id}`));
  }
}
if (!short) {
  if (withDeploy) await step("deploy", "режим «Развёртывание», весь проект", () => setHash(`#/p/${project.id}/deploy`));
  await setHash("#/projects");
  await page.waitForTimeout(1500);
  await step("reopen", "повторное открытие корня после выхода в список проектов", () => setHash(`#/p/${project.id}/map`));
}

if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
await browser.close();
