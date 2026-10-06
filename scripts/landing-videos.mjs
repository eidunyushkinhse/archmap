// Видео РЕАЛЬНОГО интерфейса ArchMap для анимированных вставок лендинга. Сценарии
// повторяют нынешние покадровые анимации (hero / process / status), но снимаются с
// живого UI: раскрытие контейнера, переход на страницу объекта, фильтры статусов —
// с настоящими переходами продукта, а не подменой кадров.
//
// Запуск (dev-стек поднят через ./dev.sh):
//   node scripts/landing-videos.mjs                       # все → landing-shots/vid-*.mp4 + .webm
//   node scripts/landing-videos.mjs --only hero,status
//   node scripts/landing-videos.mjs --out DIR --project "Имя" --scale 1 --trace --keep-raw
//   --scale N      DSF съёмки, по умолчанию 2 (рамка лендинга на ретине); 1 — черновик
//   --width N      ширина файла (по умолчанию кадр как снят, но не шире 1720 px)
//   --crf-mp4 / --crf-webm  качество x264 / VP9 (23 / 34)
//   --trace        хронометраж сцены по шагам — для подгонки hold
//   --keep-raw     оставить кадры скринкаста (JPEG + frames.json) во временном каталоге
// ffmpeg ищется в FFMPEG, PATH и ~/.cache/archmap-ffmpeg/ffmpeg (статическая сборка с
// x264 и VP9). Без него — запасной путь: встроенная запись Playwright, сырой WebM
// (vid-<name>.raw.webm) с подготовкой сцены в начале; скрипт печатает
// data-start/data-end для <div data-video> на лендинге.
//
// Правила съёмки — как у landing-shots.mjs: состояние только через UI, сторож рвёт
// любые не-GET запросы к API (кроме двух сухих превью), артефакты съёмки скрыты
// стилем. Playwright курсор не рендерит, поэтому курсор и рябь клика рисуются
// оверлеем внутри страницы тем же глифом и цветом, что на лендинге. Движения
// курсора — с замедлением (glide), прокрутка — колесом мелкими дельтами.
//
// DSF 2: одного DSF контекста мало — скринкаст CDP отдаёт кадр в размере вьюпорта
// (1600×1000 при DSF 2), и запись выходит половинной с серыми полями. Поэтому
// Chromium запускается ещё и с --force-device-scale-factor — тогда кадр скринкаста в
// физических пикселях.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = process.env.ARCHMAP_FRONTEND ?? "http://localhost:5173";
const BACKEND = process.env.ARCHMAP_BACKEND ?? "http://localhost:8000";
const PW_MODULE = process.env.PLAYWRIGHT_MODULE
  ?? join(homedir(), ".npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js");
const CHROME = process.env.CHROME_PATH
  ?? join(homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome");
const CHROME_LIBS = process.env.CHROME_LIBS
  ?? join(homedir(), ".cache/archmap-chrome-libs/usr/lib/x86_64-linux-gnu");

const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const OUT = resolve(argOf("--out") ?? join(ROOT, "landing-shots"));
const PROJECT_NAME = argOf("--project") ?? "Маркетплейс «Ярмарка» v2";
const ONLY = argOf("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const SCALE = Number(argOf("--scale") ?? 2);
// Ширина файла. По умолчанию — кадр как снят, но не шире 1720 px: рамка лендинга
// 860 px, на ретине это 1720 физических пикселей. Шире — только лишние байты, а кадр
// 4200 px (статусы при --scale 2) иные аппаратные декодеры H.264 не берут вовсе.
const WIDTH = argOf("--width") ? Number(argOf("--width")) : null;
const FRAME_W = 860; // ширина рамки лендинга: .vis{max-width:860px}
const MAX_WIDTH = 2 * FRAME_W;
const KEEP_RAW = args.includes("--keep-raw");
const FPS = 30;
const CRF_MP4 = Number(argOf("--crf-mp4") ?? 23);
const CRF_WEBM = Number(argOf("--crf-webm") ?? 34);
// ffmpeg: FFMPEG из окружения → PATH → статическая сборка в кэше (как либы Chromium)
const FFMPEG = [process.env.FFMPEG, "ffmpeg", join(homedir(), ".cache/archmap-ffmpeg/ffmpeg")]
  .filter(Boolean)
  .find((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
const HAS_FFMPEG = Boolean(FFMPEG);

// ── Имена демо-проекта (резолвятся по именам через API) ──────────────────────
const N = {
  orders: "Сервис заказов",
  orderApi: "Order API",
  kafka: "Kafka",
  recs: "Сервис рекомендаций",
  sms: "SMS-рассыльщик",
  notifWorker: "Notification worker",
  notifDb: "БД уведомлений",
};
const DOC_LOGIC = "Создание заказа";
const PROCESS = "Оформление заказа";

const HIDE_CSS = `
vite-error-overlay, .lg-overload-toast, .lg-budget-toast, .lg-dirty-toast { display: none !important; }
`;
const DRY_RUN = [/\/api\/v1\/data-refs\/preview$/, /\/api\/v1\/projects\/import\/unified-preview$/];

// Оверлей курсора: тот же глиф и рябь, что в .pcur/.prip на лендинге (--acc #1168bd).
// popover="manual" держит его в top-layer; при открытии <dialog> поднимаем заново,
// чтобы курсор оставался поверх модалок. Правая кнопка (пан холста) рябь не даёт.
// Масштаб k = ширина окна / ширина рамки лендинга: видео в рамке ужимается в k раз,
// и курсор с рябью выходят того же размера, что в анимации на скринах (иначе вдвое
// мельче, а кольцо ряби — в пиксель толщиной).
const cursorJs = (k) => `(() => {
  const K = ${k.toFixed(3)};
  const css = '#lp-cur{position:fixed;left:0;top:0;right:auto;bottom:auto;width:0;height:0;margin:0;padding:0;border:0;background:none;overflow:visible;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(23,25,28,.35));transform:translate(-9999px,-9999px)}'
    + '#lp-cur svg{position:absolute;left:-3px;top:-2px}'
    + '#lp-cur .rip{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #1168bd;opacity:0;transform:scale(.3)}'
    + '#lp-cur.clk .rip{animation:lprip .35s ease-out}'
    + '@keyframes lprip{0%{opacity:.9;transform:scale(.3)}100%{opacity:0;transform:scale(1.4)}}';
  const mount = () => {
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement('div'); c.id = 'lp-cur'; c.setAttribute('popover', 'manual');
    c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2l16 11-7 1.5 4.5 8-3 1.5-4.5-8L2 21z" fill="#fff" stroke="#0f172a" stroke-width="1.6" stroke-linejoin="round"></path></svg><span class="rip"></span>';
    document.body.appendChild(c);
    const raise = () => { try { c.hidePopover(); } catch {} try { c.showPopover(); } catch {} };
    raise();
    window.addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px) scale(' + K + ')'; }, true);
    window.addEventListener('mousedown', (e) => { if (e.button !== 0) return; c.classList.remove('clk'); void c.offsetWidth; c.classList.add('clk'); }, true);
    new MutationObserver(raise).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();`;

// ── Учётка и API ─────────────────────────────────────────────────────────────
function credentials() {
  let user = process.env.ARCHMAP_USERNAME;
  let pass = process.env.ARCHMAP_PASSWORD;
  const envFile = join(ROOT, "mcp/.env");
  if ((!user || !pass) && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "ARCHMAP_USERNAME" && !user) user = v;
      if (m[1] === "ARCHMAP_PASSWORD" && !pass) pass = v;
    }
  }
  if (!user || !pass) throw new Error("Нет учётки: задайте ARCHMAP_USERNAME/ARCHMAP_PASSWORD или mcp/.env");
  return { user, pass };
}

async function login() {
  const { user, pass } = credentials();
  const r = await fetch(`${BACKEND}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: user, password: pass }),
  });
  if (!r.ok) throw new Error(`Вход не удался: ${r.status}`);
  return (await r.json()).access_token;
}

async function api(token, path, projectId = null) {
  const headers = { Authorization: `Bearer ${token}`, ...(projectId ? { "X-Project-Id": projectId } : {}) };
  const r = await fetch(`${BACKEND}/api/v1${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

async function resolveScene(token) {
  const projects = await api(token, "/projects");
  const project = projects.find((p) => p.name === PROJECT_NAME);
  if (!project) throw new Error(`Проект «${PROJECT_NAME}» не найден`);
  const pid = project.id;
  const nodes = await api(token, "/nodes/all", pid);
  const ids = {};
  for (const [key, name] of Object.entries(N)) {
    const hits = nodes.filter((n) => n.name === name);
    if (hits.length !== 1) throw new Error(`Объект «${name}»: найдено ${hits.length}`);
    ids[key] = hits[0].id;
  }
  const processes = await api(token, "/processes", pid);
  const proc = processes.find((p) => p.name === PROCESS);
  if (!proc) throw new Error(`Процесс «${PROCESS}» не найден`);
  const detail = await api(token, `/processes/${proc.id}`, pid);
  const step = [...detail.messages].sort((a, b) => a.order - b.order).find((m) => m.doc_name === DOC_LOGIC);
  if (!step) throw new Error(`В процессе нет шага со схемой «${DOC_LOGIC}»`);
  return { pid, ids, stepCaption: step.caption };
}

// ── Браузер ──────────────────────────────────────────────────────────────────
const blocked = [];
const warnings = [];
const results = [];

async function newPage(browser, token, pid, w, h, name) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: SCALE,
    colorScheme: "light",
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    // Встроенная запись Playwright — только запасной путь без ffmpeg (см. «Запись»)
    ...(HAS_FFMPEG ? {} : { recordVideo: { dir: join(tmpdir(), "archmap-landing-videos"), size: { width: w * SCALE, height: h * SCALE } } }),
  });
  await ctx.addInitScript(([t, p, css, cur]) => {
    try {
      localStorage.setItem("access_token", t);
      localStorage.setItem("archmap.lastProjectId", p);
    } catch { /* приватный режим — не наш случай */ }
    const add = () => {
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
      // eslint-disable-next-line no-new-func
      new Function(cur)();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
    else add();
  }, [token, pid, HIDE_CSS, cursorJs(w / FRAME_W)]);
  await ctx.route("**/api/v1/**", (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;
    const dry = method === "POST" && DRY_RUN.some((re) => re.test(path));
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || dry) return route.continue();
    blocked.push({ name, method, path });
    return route.abort("blockedbyclient");
  });
  const page = await ctx.newPage();
  const videoStart = now(); // запасной путь: запись стартует вместе со страницей
  page.on("pageerror", (e) => warnings.push(`${name}: ошибка страницы — ${e.message}`));
  return { ctx, page, videoStart };
}

async function go(page, hash) {
  await page.goto(`${FRONTEND}/#${hash}`);
  await settle(page);
}

async function settle(page, extraMs = 800) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  let prev = null;
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(300);
    const s = await page.evaluate(() => {
      const busy = (window.__archmapLayoutInflight ?? 0) + document.querySelectorAll(".lg-busy").length;
      const nodes = [...document.querySelectorAll(".react-flow__node")]
        .map((n) => `${n.getAttribute("data-id")}${n.style.transform}`).join("|");
      const edges = [...document.querySelectorAll(".react-flow__edge path.react-flow__edge-path")]
        .map((p) => p.getAttribute("d")).join("|");
      const vps = [...document.querySelectorAll(".react-flow__viewport")].map((v) => v.style.transform).join("|");
      return { busy, sig: `${nodes}#${edges}#${vps}` };
    });
    if (s.busy > 0) { prev = null; stable = 0; continue; }
    if (s.sig === prev) { if (++stable >= 2) break; } else { stable = 0; prev = s.sig; }
  }
  await page.waitForTimeout(extraMs);
}

async function scrollCardToTop(page, title, offset = 70) {
  const card = page.locator(`.np-card:has(h3:text-is("${title}"))`).first();
  await card.waitFor();
  for (let i = 0; i < 6; i++) {
    const moved = await card.evaluate((e, off) => {
      const sc = e.closest(".np-page");
      if (!sc) return 0;
      const before = sc.scrollTop;
      sc.scrollTop += e.getBoundingClientRect().top - off;
      return Math.abs(sc.scrollTop - before);
    }, offset);
    await page.waitForTimeout(500);
    if (moved < 1) break;
  }
  return card;
}

async function frameNodes(page, ids, fill = 0.8) {
  const measure = () => page.evaluate((list) => {
    const rs = list.map((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect()).filter(Boolean);
    const p = document.querySelector(".react-flow").getBoundingClientRect();
    return {
      n: rs.length,
      x0: Math.min(...rs.map((r) => r.left)), y0: Math.min(...rs.map((r) => r.top)),
      x1: Math.max(...rs.map((r) => r.right)), y1: Math.max(...rs.map((r) => r.bottom)),
      px0: p.left, py0: p.top, px1: p.right, py1: p.bottom,
    };
  }, ids);
  let m = await measure();
  if (m.n !== ids.length) throw new Error(`на холсте ${m.n} из ${ids.length} целевых узлов`);
  const STEP = 2 ** 0.2;
  for (let i = 0; i < 12; i++) {
    const fits = (m.x1 - m.x0) * STEP <= fill * (m.px1 - m.px0) && (m.y1 - m.y0) * STEP <= fill * (m.py1 - m.py0);
    if (!fits) break;
    await page.mouse.move((m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(250);
    m = await measure();
  }
  await settle(page, 300);
  m = await measure();
  const dx = (m.px0 + m.px1) / 2 - (m.x0 + m.x1) / 2;
  const dy = (m.py0 + m.py1) / 2 - (m.y0 + m.y1) / 2;
  const start = await page.evaluate(({ dx, dy, m }) => {
    for (let gy = 0.1; gy <= 0.9; gy += 0.05) {
      for (let gx = 0.1; gx <= 0.9; gx += 0.05) {
        const x = m.px0 + (m.px1 - m.px0) * gx;
        const y = m.py0 + (m.py1 - m.py0) * gy;
        const ex = x + dx, ey = y + dy;
        if (ex < m.px0 + 10 || ex > m.px1 - 10 || ey < m.py0 + 10 || ey > m.py1 - 10) continue;
        const el = document.elementFromPoint(x, y);
        if (el && el.classList.contains("react-flow__pane")) return { x, y };
      }
    }
    return null;
  }, { dx, dy, m });
  if (!start) throw new Error("не нашлось пустого места холста для пана");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 15 });
  await page.mouse.up({ button: "right" });
  await settle(page, 300);
}

// ── Режиссура: курсор, клики, паузы ──────────────────────────────────────────
// Текущая позиция курсора — своя, Playwright её не отдаёт.
const pos = { x: 0, y: 0 };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const TRACE = args.includes("--trace");
// Все тайминги — по монотонным часам. Настенные в WSL2 шагают при синхронизации с
// хостом — замечен откат на 1,5 с посреди прогона; по ним окно записи съезжало, а
// шаги анимации шли назад.
const now = () => performance.now();
let sceneT0 = 0;
// --trace: отметки хронометража сцены (секунды от её начала) — для подгонки hold
const mark = (label) => { if (TRACE) console.log(`    ${((now() - sceneT0) / 1000).toFixed(2)} ${label}`); };

// Шаг анимации по часам, но без скачков: если очередной вызов CDP завис (страница
// занята), часы анимации стоят — движение продолжится с того же места, а не
// перепрыгнет вперёд. Прыжок прокрутки после зависания давал в записи белые
// недорисованные кадры. За один шаг часы идут не больше чем на 100 мс: обычный шаг
// при --scale 2 сам по себе 30–70 мс (mouse.move ждёт кадра), его не тормозим.
async function animate(page, ms, step) {
  let t = 0, last = now();
  for (;;) {
    const at = now();
    t += Math.min(at - last, 100);
    last = at;
    const k = Math.min(1, t / ms);
    await step(ease(k));
    if (k >= 1) break;
    await page.waitForTimeout(12);
  }
}
// Плавный перелёт в точку за ms. Курсор реально наводится — ховеры по пути настоящие.
async function glide(page, x, y, ms = 700) {
  const from = { ...pos };
  await animate(page, ms, (e) => page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e));
  pos.x = x; pos.y = y;
}
async function center(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("цель вне экрана");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function clickOn(page, locator, ms = 700) {
  const c = await center(locator);
  await glide(page, c.x, c.y, ms);
  await page.waitForTimeout(140);
  await page.mouse.click(c.x, c.y);
}
async function dblOn(page, locator, ms = 700) {
  const c = await center(locator);
  await glide(page, c.x, c.y, ms);
  await page.waitForTimeout(140);
  await page.mouse.dblclick(c.x, c.y);
}
const hold = (page, ms) => page.waitForTimeout(ms);
// Плавная прокрутка колесом: мелкие дельты с замедлением на концах. Тиками по 120 px
// headless-Chromium прыгает без анимации — в записи это рывки ~12 к/с. Первый
// вызов колеса после перехода на страницу может зависнуть на сотни мс — его
// прогревают пикселем заранее, пока курсор стоит (см. hero).
async function scrollSmooth(page, dy, ms = 1200) {
  let done = 0;
  await animate(page, ms, async (e) => {
    const to = Math.round(dy * e);
    if (to !== done) { await page.mouse.wheel(0, to - done); done = to; }
  });
}
// Готовность без «мёртвой» паузы: конвейер раскладки не в полёте, индикатор занятости
// снят. settle сверх того ждёт стабильной сигнатуры два замера по 300 мс и запас —
// в подготовке это к месту, а в кадре даёт пустые секунды.
async function ready(page, timeout = 8000) {
  const t = now();
  while (now() - t < timeout) {
    const busy = await page.evaluate(() => (window.__archmapLayoutInflight ?? 0) + document.querySelectorAll(".lg-busy").length);
    if (!busy) return;
    await page.waitForTimeout(100);
  }
}
// Элемент появился и его рамка не меняется два замера подряд (вписывание, анимации).
async function stableBox(locator, timeout = 8000) {
  await locator.waitFor({ timeout });
  const t = now();
  let prev = "", same = 0;
  while (now() - t < timeout) {
    const b = await locator.boundingBox();
    const sig = b ? [b.x, b.y, b.width, b.height].map(Math.round).join(",") : "";
    same = sig && sig === prev ? same + 1 : 0;
    if (same >= 2) return;
    prev = sig;
    await locator.page().waitForTimeout(100);
  }
}
// Курсор паркуется на пустой шапке до старта сцены (без ховеров и ряби в кадре).
async function park(page) {
  const vp = page.viewportSize();
  pos.x = Math.round(vp.width / 2); pos.y = 28;
  await page.mouse.move(pos.x, pos.y);
}

// ── Сценарии ─────────────────────────────────────────────────────────────────
// setup — подготовка (в итоговое видео не входит), scene — то, что снимаем,
// teardown — уборка после записи (тоже вне кадра). Внутри сцены — только ожидания
// конкретных элементов и hold под длительность анимаций продукта.
const VIDEOS = {
  // Глубина: страница «Сервиса заказов» → лупой раскрываем его на схеме страницы
  // (настоящая анимация раскрытия) → двойным кликом по Order API уходим на его
  // страницу → колесом доезжаем до карточки «Конфигурация».
  hero: { size: [1600, 1000], async setup(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orders}`);
    const chev = page.locator(".nt-row--current .nt-chevzone");
    if ((await chev.getAttribute("aria-expanded")) !== "true") await chev.click();
    const card = await scrollCardToTop(page, "Схема");
    await card.locator(".esb-activate").click(); // схема страницы инертна до клика
    await settle(page);
    await park(page);
    return { card };
  }, async scene(page, s, { card }) {
    await hold(page, 500);
    const node = card.locator(`.react-flow__node[data-id="${s.ids.orders}"]`);
    const c = await center(node);
    await glide(page, c.x, c.y, 800);               // ховер показывает лупу
    await clickOn(page, node.locator('button[title="Раскрыть содержимое"]'), 350);
    mark("лупа");
    await card.locator(`.react-flow__node[data-id="${s.ids.orderApi}"]`).waitFor();
    await hold(page, 1300);                           // анимация раскрытия + пауза
    // readOnly-схема страницы: двойной клик по блоку — переход на его страницу
    // (EmbeddedSchemaBlock: onEditNode → onNavigateNode)
    await dblOn(page, card.locator(`.react-flow__node[data-id="${s.ids.orderApi}"]`), 800);
    mark("двойной клик");
    const config = page.locator('.np-card:has(h3:text-is("Конфигурация"))').first();
    await config.waitFor();
    // Схема страницы Order API догружается и меняет высоту карточек — до прокрутки
    // ждём её узлы, иначе содержимое прыгнет посреди прокрутки.
    await page.locator('.np-card:has(h3:text-is("Схема")) .react-flow__node').first().waitFor();
    await ready(page);
    mark("страница Order API готова");
    await hold(page, 200);
    // Курсор — в правое поле страницы: под ним на прокрутке не проплывают карточки, и
    // на инертной схеме не всплывает подсказка «кликните, чтобы взаимодействовать».
    const aside = await config.evaluate((el) => {
      const sc = el.closest(".np-page").getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: (r.right + sc.right) / 2, y: sc.top + sc.height * 0.55 };
    });
    await glide(page, aside.x, aside.y, 500);
    await page.mouse.wheel(0, 1); // прогрев колеса: зависание первого вызова — пока курсор стоит
    await hold(page, 150);
    // Ровно до «Конфигурации» у верха (или до конца страницы, если раньше упрёмся)
    const dist = await config.evaluate((el) => {
      const sc = el.closest(".np-page");
      const want = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 16;
      return Math.max(0, Math.min(want, sc.scrollHeight - sc.clientHeight - sc.scrollTop));
    });
    mark(`прокрутка ${Math.round(dist)} px`);
    await scrollSmooth(page, dist, 1300);
    await hold(page, 2000);
    mark("конец");
  } },

  // Процессы: раздел «Бизнес-процессы» → «Оформление заказа» → шаг → его схема логики.
  // Режим правки — локальная настройка вида (запись не идёт), карточку закрываем
  // «Отменой» уже после записи.
  process: { size: [1600, 1000], async setup(page, s) {
    await go(page, `/p/${s.pid}`);
    await park(page);
  }, async scene(page, s) {
    await hold(page, 400);
    await clickOn(page, page.locator('button[title="Бизнес-процессы"]'), 700);
    // «Оформление заказа» — первый в списке, раздел открывает его сам: клик по уже
    // выбранному пункту в кадре ничего не меняет, поэтому его нет
    await page.getByText(PROCESS, { exact: true }).first().waitFor();
    await page.locator('button[title="Свернуть в рейл"]').waitFor();
    await ready(page);
    mark("раздел процессов");
    await hold(page, 600);
    await clickOn(page, page.locator('button[title="Свернуть в рейл"]'), 600);
    mark("рейл");
    await hold(page, 700);                            // рейл сворачивается, диаграмма раздвигается
    await clickOn(page, page.getByRole("button", { name: "Редактировать" }).first(), 600);
    await page.getByRole("button", { name: "Готово" }).waitFor();
    mark("режим правки");
    await hold(page, 400);
    await clickOn(page, page.getByText(s.stepCaption, { exact: true }).first(), 700);
    await page.getByText("Схема логики", { exact: true }).waitFor();
    mark("карточка шага");
    await hold(page, 600);
    await clickOn(page, page.locator('button[title="Открыть схему на чтение"]').first(), 500);
    // Сама схема, а не первая попавшаяся иконка шапки диалога: у корневого svg mermaid
    // есть aria-roledescription. После вставки схема ещё вписывается в окно — ждём,
    // пока её рамка не замрёт.
    await stableBox(page.locator("dialog[open] svg[aria-roledescription]").first());
    mark("схема в диалоге");
    await hold(page, 1800);
    mark("конец");
  }, async teardown(page) {
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "detached" }).catch(() => {});
    await page.getByRole("button", { name: "Отмена" }).click().catch(() => {});
  } },

  // Статусы: корень карты, вид «Переход» → «Как есть» (новый «Сервис рекомендаций»
  // уходит) → «Как будет» (выводимый «SMS-рассыльщик» уходит) → снова «Переход».
  status: { size: [2100, 900], async setup(page, s) {
    await go(page, `/p/${s.pid}/map`);
    await page.getByRole("button", { name: "Свернуть панель" }).last().click();
    await page.getByRole("button", { name: "Свернуть панель" }).first().click();
    await page.getByRole("radio", { name: "Переход", exact: true }).click();
    await settle(page);
    await page.locator(".react-flow__controls-fitview").click();
    await settle(page);
    await frameNodes(page, [s.ids.recs, s.ids.orders, s.ids.sms, s.ids.notifWorker, s.ids.notifDb], 0.8);
    await park(page);
  }, async scene(page) {
    const radio = (name) => page.getByRole("radio", { name, exact: true });
    await hold(page, 600);
    await clickOn(page, radio("Как есть"), 600);
    mark("как есть");
    await hold(page, 1400);
    await clickOn(page, radio("Как будет"), 450);
    mark("как будет");
    await hold(page, 1400);
    await clickOn(page, radio("Переход"), 400);
    mark("переход");
    await hold(page, 1400);
    mark("конец");
  } },
};

// ── Запись ───────────────────────────────────────────────────────────────────
// Скринкаст CDP: кадры JPEG ложатся на диск как есть и кодируются один раз, после
// прогона. Время кадра — момент прибытия по монотонным часам: метка
// metadata.timestamp у Chromium настенная и в WSL2 расходится с часами скрипта. recordVideo Playwright для итоговых файлов
// не годится: он в реальном времени жмёт поток в VP8 на 1 Мбит/с одним потоком — текст
// схем мылится (при 3200×2000 кодер ещё и не успевает за кадрами), а обрезка и
// перекодирование в mp4/webm мылили бы второй раз.
async function startCapture(page, dir) {
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: now() / 1000 });
  });
  const vp = page.viewportSize();
  await cdp.send("Page.startScreencast", {
    format: "jpeg", quality: 92, maxWidth: vp.width * SCALE, maxHeight: vp.height * SCALE,
  });
  // Первый кадр Chromium присылает сразу — с него начинается сцена
  while (!frames.length) await page.waitForTimeout(20);
  return { frames, stop: () => cdp.send("Page.stopScreencast").catch(() => {}) };
}

// ── Кодирование ──────────────────────────────────────────────────────────────
// Кадры → видео постоянной частоты: каждый кадр держится до следующего (concat с
// duration), фильтр fps раскладывает их по сетке FPS. Окно — [t0, t1] сцены: первым
// идёт кадр, что был на экране в момент t0.
function encode({ name, frames, dir, t0, t1 }) {
  let i0 = 0;
  frames.forEach((f, i) => { if (f.t <= t0) i0 = i; });
  const seq = frames.slice(i0).filter((f, k) => k === 0 || f.t < t1);
  const lines = ["ffconcat version 1.0"];
  seq.forEach((f, k) => {
    const to = k + 1 < seq.length ? seq[k + 1].t : t1;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, to - Math.max(f.t, t0)).toFixed(4)}`);
  });
  lines.push(`file '${seq[seq.length - 1].file}'`); // без повтора concat теряет длительность последнего
  const list = join(dir, "frames.ffconcat");
  writeFileSync(list, lines.join("\n") + "\n");
  // JPEG скринкаста — BT.601 полного диапазона; в файл — BT.709 ТВ-диапазона с явной
  // разметкой, иначе браузеры гадают о матрице и синий уезжает.
  const size = WIDTH ? `${WIDTH}:-2` : `'min(iw,${MAX_WIDTH})':-2`;
  const vf = `fps=${FPS},scale=${size}:flags=lanczos:in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p`;
  const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-an", "-vf", vf,
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  const base = join(OUT, `vid-${name}`);
  const runs = [
    [...input, "-c:v", "libx264", "-preset", "slow", "-crf", String(CRF_MP4), "-threads", "4", "-movflags", "+faststart", `${base}.mp4`],
    [...input, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(CRF_WEBM), "-row-mt", "1", "-threads", "4", `${base}.webm`],
  ];
  for (const a of runs) {
    const r = spawnSync(FFMPEG, a, { stdio: ["ignore", "ignore", "pipe"] });
    if (r.status !== 0) throw new Error(`ffmpeg: ${(r.stderr?.toString().trim().split("\n").pop()) || `код ${r.status ?? r.signal}`}`);
  }
  const gaps = seq.slice(1).map((f, k) => f.t - seq[k].t);
  return {
    files: [`vid-${name}.mp4`, `vid-${name}.webm`],
    sizes: [statSync(`${base}.mp4`).size, statSync(`${base}.webm`).size],
    frames: seq.length,
    maxGap: gaps.length ? Math.max(...gaps) : 0,
  };
}
const mb = (n) => `${(n / 1048576).toFixed(2)} МБ`;

// ── Прогон ───────────────────────────────────────────────────────────────────
const pw = await import(PW_MODULE);
const { chromium } = pw.default;
const token = await login();
const scene = await resolveScene(token);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  args: SCALE !== 1 ? [`--force-device-scale-factor=${SCALE}`] : [],
  headless: true,
});
console.log(`Проект «${PROJECT_NAME}» → ${OUT}${HAS_FFMPEG ? "" : "  (ffmpeg не найден — сырой WebM без обрезки)"}`);
const jobs = []; // записанные сцены: кодируются после закрытия браузера
for (const [name, v] of Object.entries(VIDEOS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  console.log(`• ${name}`);
  const before = blocked.length;
  const { ctx, page, videoStart } = await newPage(browser, token, scene.pid, v.size[0], v.size[1], name);
  const video = page.video(); // только на запасном пути
  const dir = join(tmpdir(), "archmap-landing-videos", `${name}-${process.pid}`);
  let cap = null, t0 = null, t1 = null;
  try {
    const state = await v.setup(page, scene);
    if (HAS_FFMPEG) cap = await startCapture(page, dir);
    t0 = sceneT0 = now();
    await v.scene(page, scene, state ?? {});
    t1 = now();
    await v.teardown?.(page);
  } catch (e) {
    results.push({ name, error: e.message.split("\n")[0] });
    console.log(`  ✗ ${name}: ${e.message.split("\n")[0]}`);
  }
  if (blocked.length > before) console.log(`  ! ${name}: UI пытался писать — запросы оборваны сторожем`);
  await cap?.stop();
  await ctx.close();
  if (cap) {
    if (t0 && t1) jobs.push({ name, frames: cap.frames, dir, t0: t0 / 1000, t1: t1 / 1000 });
    else if (!KEEP_RAW) rmSync(dir, { recursive: true, force: true });
  }
  if (video) {
    const raw = await video.path();
    if (t0 && t1) {
      const start = (t0 - videoStart) / 1000, end = (t1 - videoStart) / 1000;
      const file = `vid-${name}.raw.webm`;
      copyFileSync(raw, join(OUT, file));
      results.push({ name, files: [file], dur: end - start, start, end });
      console.log(`  ✓ ${file}  data-start="${start.toFixed(2)}" data-end="${end.toFixed(2)}"`);
    }
    unlinkSync(raw);
  }
}
await browser.close();

// Кодирование — после закрытия браузера: x264 на кадре 3200×2000 берёт ~2.5 ГБ, и рядом
// с живым Chromium его снимал OOM-киллер.
for (const j of jobs) {
  const dur = j.t1 - j.t0;
  try {
    const r = encode(j);
    results.push({ name: j.name, files: r.files, dur, sizes: r.sizes });
    console.log(`  ✓ ${r.files.join(", ")}  ${dur.toFixed(1)} с, ${mb(r.sizes[0])} / ${mb(r.sizes[1])}, кадров ${r.frames}, макс. пауза ${(r.maxGap * 1000).toFixed(0)} мс`);
  } catch (e) { results.push({ name: j.name, error: e.message }); console.log(`  ✗ ${j.name}: ${e.message}`); }
  if (KEEP_RAW) {
    writeFileSync(join(j.dir, "frames.json"), JSON.stringify({ t0: j.t0, t1: j.t1, frames: j.frames }));
    console.log(`    кадры: ${j.dir}`);
  } else rmSync(j.dir, { recursive: true, force: true });
}

console.log("\nИтог:");
for (const r of results) console.log(r.error ? `  ✗ ${r.name}: ${r.error}` : `  ${r.files.join(", ")}  ${r.dur.toFixed(1)} с${r.sizes ? `  (${r.sizes.map(mb).join(" / ")})` : ""}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
for (const b of blocked) console.log(`  ⛔ ${b.name}: ${b.method} ${b.path} (оборвано, в БД не дошло)`);
if (blocked.length || results.some((r) => r.error)) process.exit(1);
