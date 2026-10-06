// Скриншоты РЕАЛЬНОГО интерфейса ArchMap для лендинга: кадры демо-проекта
// «Маркетплейс «Ярмарка»» вместо нарисованных мокапов. Один прогон снимает все
// кадры подряд; повторный прогон после правок UI перезаписывает PNG.
//
// Запуск (dev-стек поднят через ./dev.sh):
//   node scripts/landing-shots.mjs                      # все кадры → landing-shots/
//   node scripts/landing-shots.mjs --only hero,status   # выборочно (имена — ниже, в SHOTS)
//   node scripts/landing-shots.mjs --out /tmp/shots     # другой каталог
//   node scripts/landing-shots.mjs --project "Имя"      # другой проект (по умолчанию «… v2»)
// Учётка — ARCHMAP_USERNAME/ARCHMAP_PASSWORD из окружения, иначе из mcp/.env
// (учётка демо-проекта). Токен в вывод не печатается.
//
// Правила съёмки (ТЗ дизайнера):
//  • Chromium, deviceScaleFactor 2, светлая тема, ru-RU, размер окна — по кадру;
//  • перед кадром — networkidle + оседание раскладки (счётчик __archmapLayoutInflight,
//    индикатор .lg-busy, стабильная сигнатура узлов/рёбер/вьюпорта) + 800 мс;
//  • состояние наводится ТОЛЬКО через UI: клики, URL, колесо и пан вьюпорта. В DOM и
//    данные ничего не подмешивается. Стилем скрыты лишь артефакты съёмки — тосты
//    холста и оверлей ошибок Vite (их появление пишется в лог); каретку прячет сам
//    Playwright (caret: "hide"), курсор паркуется на пустой шапке.
//  • БД НЕ МЕНЯЕТСЯ: сетевой сторож обрывает любой не-GET запрос к API, кроме двух
//    заведомо сухих превью (data-refs/preview — обращения схемы логики,
//    projects/import/unified-preview — сводка импорта). Попытка записи — кадр
//    считается проваленным, скрипт выходит с кодом 1. Поэтому кадры выбраны там, где
//    UI ничего не пишет: раскрытие лупой — на странице «Сервиса заказов», где оно уже
//    сохранено в виде (клик гасится дедупом), статусы — на сохранённом раскрытии корня.
import { readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = process.env.ARCHMAP_FRONTEND ?? "http://localhost:5173";
const BACKEND = process.env.ARCHMAP_BACKEND ?? "http://localhost:8000";
// Playwright и Chromium — там же, где у полигонных зондов (scripts/*-probe.mjs)
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
const DSF = 2;

// ── Имена демо-проекта (всё резолвится по именам через API, id не зашиты) ────────
const N = {
  orders: "Сервис заказов",
  orderApi: "Order API",
  ordersDb: "БД заказов",
  kafka: "Kafka",
  recs: "Сервис рекомендаций",
  sms: "SMS-рассыльщик",
  notifWorker: "Notification worker",
  notifDb: "БД уведомлений",
};
const DOC_LOGIC = "Создание заказа";
const CHANNEL = "catalog.product-events";
const PROCESS = "Оформление заказа";

// Вторая «пара» к mock-import.yaml для кадра импорта: прогон агента в другом
// репозитории той же демо-системы «Плёнка» (мульти-репо сценарий «Из репозитория»).
const SECOND_YAML = `# Прогон агента в репозитории биллинга «Плёнки»
nodes:
  - name: Плёнка
    shape: service
    role: система
    children:
      - name: Сервис биллинга
        shape: service
        role: сервис
        technology: Java
        source: {repo: github.com/plenka/billing}
        children:
          - name: БД
            shape: database
            technology: PostgreSQL
          - name: Планировщик списаний
            shape: service
            role: воркер
            technology: Java
            description: Раз в сутки продлевает подписки и списывает оплату.
edges:
  - from: Сервис биллинга / Планировщик списаний
    to: Сервис биллинга / БД
    label: читает подписки, пишет списания
    technology: SQL
`;

// Скрытие артефактов съёмки (не данных): тосты холста и оверлей ошибок Vite.
const HIDE_CSS = `
vite-error-overlay, .lg-overload-toast, .lg-budget-toast, .lg-dirty-toast { display: none !important; }
`;
const ARTIFACTS = "vite-error-overlay, .lg-overload-toast, .lg-budget-toast, .lg-dirty-toast";

// Сухие POST-превью, которые UI шлёт при просмотре; всё прочее не-GET — обрыв.
const DRY_RUN = [/\/api\/v1\/data-refs\/preview$/, /\/api\/v1\/projects\/import\/unified-preview$/];

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

// Сверка сцены: всё, что снимаем, обязано существовать — иначе падаем ДО браузера.
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
  const channels = await api(token, `/nodes/${ids.kafka}/channels`, pid);
  const channel = channels.find((c) => c.name === CHANNEL);
  if (!channel) throw new Error(`Канал «${CHANNEL}» не найден`);
  const processes = await api(token, "/processes", pid);
  const proc = processes.find((p) => p.name === PROCESS);
  if (!proc) throw new Error(`Процесс «${PROCESS}» не найден`);
  const detail = await api(token, `/processes/${proc.id}`, pid);
  // Шаг для карточки: первый по порядку, чья схема логики — «Создание заказа»
  const step = [...detail.messages].sort((a, b) => a.order - b.order).find((m) => m.doc_name === DOC_LOGIC);
  if (!step) throw new Error(`В процессе нет шага со схемой «${DOC_LOGIC}»`);
  return { pid, ids, channelId: channel.id, stepCaption: step.caption };
}

// ── Браузер ──────────────────────────────────────────────────────────────────
const blocked = [];   // попытки записи, оборванные сторожем
const warnings = [];  // артефакты и прочие замечания по кадрам
const notes = [];     // справки (не ошибки): что видно кадру на разных ширинах сайта
// Лупа «🔍» на узлах и рамках — эмодзи: без шрифта с ним (fonts-noto-color-emoji или
// NotoColorEmoji.ttf в ~/.local/share/fonts) Chromium рисует вместо неё квадрат.
if (!spawnSync("fc-list", [":charset=1f50d", "family"]).stdout?.toString().trim()) {
  warnings.push("нет шрифта с эмодзи 🔍 — лупа на узлах и рамках выйдет квадратом (fonts-noto-color-emoji)");
}
const results = [];   // { file, w, h } | { shot, error }

async function newPage(browser, token, pid, w, h, shot) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: DSF,
    colorScheme: "light",
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
  });
  // Токен и проект — в localStorage ДО старта приложения (App читает их при маунте)
  await ctx.addInitScript(([t, p, css]) => {
    try {
      localStorage.setItem("access_token", t);
      localStorage.setItem("archmap.lastProjectId", p);
    } catch { /* приватный режим — не наш случай */ }
    const add = () => {
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
    else add();
  }, [token, pid, HIDE_CSS]);
  // Сторож БД: пропускаем чтение и сухие превью, остальное обрываем и запоминаем
  await ctx.route("**/api/v1/**", (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;
    const dry = method === "POST" && DRY_RUN.some((re) => re.test(path));
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || dry) return route.continue();
    blocked.push({ shot, method, path });
    return route.abort("blockedbyclient");
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => warnings.push(`${shot}: ошибка страницы — ${e.message}`));
  return { ctx, page };
}

async function go(page, hash) {
  await page.goto(`${FRONTEND}/#${hash}`);
  await settle(page);
}

// Оседание: сеть затихла, конвейер раскладки не в полёте, сигнатура узлов/рёбер/
// вьюпорта стабильна два замера подряд (ловит и fitView-анимации), затем пауза.
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

// Прокрутка страницы объекта так, чтобы карточка встала к верху (как колесом —
// скролл-контейнер страницы .np-page; упирается в конец страницы, это нормально).
// Подгонка повторяется: карточки выше (схема страницы) дорастают до своей высоты
// уже после первого сдвига и толкают цель вниз.
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

// PNG: ширина/высота из заголовка IHDR — для отчёта в пикселях
function pngSize(file) {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function shoot(page, file) {
  const vp = page.viewportSize();
  // Курсор — на пустую шапку (без ховеров), фокус снимаем (без кольца фокуса)
  await page.mouse.move(Math.round(vp.width / 2), 28);
  await page.evaluate(() => {
    const a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === "function") a.blur();
  });
  await settle(page);
  const art = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.tagName.toLowerCase() + (e.className ? `.${e.className}` : "")), ARTIFACTS);
  if (art.length) warnings.push(`${file}: скрыты артефакты — ${art.join(", ")}`);
  const path = join(OUT, file);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  const size = pngSize(path);
  results.push({ file, ...size });
  console.log(`  ✓ ${file} ${size.w}×${size.h}`);
}

// Рамка вокруг набора узлов: колесом зумим к центру набора, затем правой кнопкой
// (panOnDrag=[2]) тащим пустое место холста, чтобы набор встал в центр.
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
  // Щелчок колеса RF ≈ ×2^0.2 вокруг курсора; крутим, пока набор после щелчка
  // ещё влезает в долю fill холста по обеим осям.
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
  // Точка хвата — пустой холст (узел панораму не начинает), и после сдвига в пределах холста
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

// ── Врезка: крупный фрагмент холста без UI ────────────────────────────────────
// Вьюпорт React Flow: точка flow на канве (.react-flow) = flow·k + t.
const RF_TRANSFORM = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/;
async function rfView(canvas) {
  const m = RF_TRANSFORM.exec(await canvas.evaluate((c) => c.querySelector(".react-flow__viewport").style.transform));
  return { tx: +m[1], ty: +m[2], k: +m[3] };
}
// Все надписи холста во flow: подписи связей — коробкой целиком, остальной текст
// (заголовки, пилюли, чипы рамок) — по строкам текстовых узлов.
async function flowTexts(canvas) {
  return canvas.evaluate((c, re) => {
    const cr = c.getBoundingClientRect();
    const m = new RegExp(re).exec(c.querySelector(".react-flow__viewport").style.transform);
    const tx = +m[1], ty = +m[2], k = +m[3];
    const flow = (r, text) => ({ text, x0: (r.left - cr.left - tx) / k, y0: (r.top - cr.top - ty) / k, x1: (r.right - cr.left - tx) / k, y1: (r.bottom - cr.top - ty) / k });
    const out = [];
    for (const e of c.querySelectorAll(".react-flow__edgelabel-renderer > *")) {
      const r = e.getBoundingClientRect();
      if (r.width && r.height) out.push(flow(r, e.textContent.trim()));
    }
    const w = document.createTreeWalker(c.querySelector(".react-flow__viewport"), NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      if (!n.textContent.trim() || n.parentElement.closest(".react-flow__edgelabel-renderer")) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      const r = rg.getBoundingClientRect();
      if (r.width && r.height) out.push(flow(r, n.textContent.trim()));
    }
    return out;
  }, RF_TRANSFORM.source);
}
const unite = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
// Надпись режется краем кадра: часть внутри, часть снаружи. m — зазор (в единицах
// flow): ближе m к краю с любой стороны тоже считается резом — запас на погрешность
// установки вьюпорта.
const cutBy = (t, x0, y0, x1, y1, m = 0) =>
  !(t.x0 >= x0 + m && t.x1 <= x1 - m && t.y0 >= y0 + m && t.y1 <= y1 - m) &&
  !(t.x1 <= x0 - m || t.x0 >= x1 + m || t.y1 <= y0 - m || t.y0 >= y1 + m);
// Наибольший масштаб и положение кадра area (px). Кадр на сайте виден не целиком:
// windows — прямоугольники кадра (px), которые показывает вёрстка (object-fit: cover).
// Обязательное req (flow) — целиком в пересечении ВСЕХ окон с полем pad (видно на любой
// ширине); надписи не режутся краями окон strict (индексы в windows) — каждая целиком
// внутри или целиком снаружи. Сдвиги перебираются от центра наружу.
function planFrame(req, texts, area, pad, windows, strict, zMax = 2) {
  const safe = windows.reduce((a, w) => [Math.max(a[0], w[0]), Math.max(a[1], w[1]), Math.min(a[2], w[2]), Math.min(a[3], w[3])]);
  const zFit = Math.min((safe[2] - safe[0] - 2 * pad) / (req.x1 - req.x0), (safe[3] - safe[1] - 2 * pad) / (req.y1 - req.y0), zMax);
  for (let z = zFit; z > zFit * 0.5; z *= 0.985) {
    // левый-верхний угол кадра во flow: req внутри safe с полем
    const ax = req.x1 + (pad - safe[2]) / z, bx = req.x0 - (pad + safe[0]) / z;
    const ay = req.y1 + (pad - safe[3]) / z, by = req.y0 - (pad + safe[1]) / z;
    if (ax > bx || ay > by) continue;
    let best = null;
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
      const x0 = ax + (bx - ax) * i / 40, y0 = ay + (by - ay) * j / 40;
      const bad = strict.some((k) => { const w = windows[k]; return texts.some((t) => cutBy(t, x0 + w[0] / z, y0 + w[1] / z, x0 + w[2] / z, y0 + w[3] / z, 6 / z)); });
      if (bad) continue;
      const d = Math.hypot(x0 - (ax + bx) / 2, y0 - (ay + by) / 2);
      if (!best || d < best.d) best = { z, x0, y0, d };
    }
    if (best) return best;
  }
  return null;
}
// Выставить вьюпорт (масштаб z, сдвиг tx/ty канвы): колесом — масштаб (d3-zoom:
// множитель 2^(−deltaY/500)), пустым местом холста — сдвиг. Пан на схемах страниц —
// правой кнопкой, если узлы там таскаются, иначе левой: какая сдвинула, той и тянем.
async function applyView(page, canvas, z, tx, ty) {
  const cb = await canvas.boundingBox();
  for (let i = 0; i < 12; i++) {
    const v = await rfView(canvas);
    if (Math.abs(v.k / z - 1) < 0.002) break;
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.wheel(0, -500 * Math.log2(z / v.k));
    await page.waitForTimeout(400);
  }
  const kz = (await rfView(canvas)).k;
  if (Math.abs(kz / z - 1) >= 0.002) throw new Error(`масштаб холста ${kz.toFixed(3)} вместо ${z.toFixed(3)}`);
  const buttons = ["right", "left"];
  for (let i = 0; i < 8; i++) {
    const v = await rfView(canvas);
    const dx = tx - v.tx, dy = ty - v.ty;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    const start = await canvas.evaluate((c, [dx, dy]) => {
      const r = c.getBoundingClientRect();
      for (let gy = 0.1; gy <= 0.9; gy += 0.05) for (let gx = 0.1; gx <= 0.9; gx += 0.05) {
        const x = r.left + r.width * gx, y = r.top + r.height * gy;
        if (x + dx < r.left + 10 || x + dx > r.right - 10 || y + dy < r.top + 10 || y + dy > r.bottom - 10) continue;
        const el = document.elementFromPoint(x, y);
        if (el && el.classList.contains("react-flow__pane")) return { x, y };
      }
      return null;
    }, [dx, dy]);
    if (!start) throw new Error("не нашлось пустого места холста для пана");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: buttons[0] });
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 });
    await page.mouse.up({ button: buttons[0] });
    await page.waitForTimeout(300);
    const after = await rfView(canvas);
    if (Math.abs(after.tx - v.tx) < 0.5 && Math.abs(after.ty - v.ty) < 0.5) buttons.reverse(); // эта кнопка не панорамирует
  }
  throw new Error("вьюпорт не встал в расчётное положение");
}
// Кадр-врезка: как shoot, но только прямоугольник clip (px страницы)
async function shootClip(page, file, clip) {
  const vp = page.viewportSize();
  await page.mouse.move(Math.round(vp.width / 2), 28);
  await page.evaluate(() => {
    const a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === "function") a.blur();
  });
  await settle(page);
  const art = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.tagName.toLowerCase() + (e.className ? `.${e.className}` : "")), ARTIFACTS);
  if (art.length) warnings.push(`${file}: скрыты артефакты — ${art.join(", ")}`);
  const path = join(OUT, file);
  await page.screenshot({ path, clip, animations: "disabled", caret: "hide" });
  const size = pngSize(path);
  results.push({ file, ...size });
  console.log(`  ✓ ${file} ${size.w}×${size.h}, ${(statSync(path).size / 1024).toFixed(0)} КБ`);
}

// Что карточка «Схемы с навигацией» показывает из кадра 640×480 при object-fit: cover
// по центру (замер вёрстки лендинга v7): весь кадр; три колонки (~300×300) — средние
// 462 px по ширине; одна колонка на ~700 px (628×220) — полоса 224 px по высоте; телефон
// (348×220) — полоса 404 px.
const CARD_WINDOWS = [[0, 0, 640, 480], [89, 0, 551, 480], [0, 128, 640, 352], [0, 38, 640, 442]];

// ── Кадры ────────────────────────────────────────────────────────────────────
// Каждый кадр — своё окно (размер по ТЗ) в свежем контексте браузера.
const SHOTS = {
  // Весь интерфейс: уровень «Сервис заказов» в редакторе-карте (вход по URL уровня,
  // не лупой), крошки «Маркетплейс «Ярмарка»» → «Сервис заказов», дерево слева,
  // дети + гости соседних уровней со связями; правая панель свёрнута.
  hero: { size: [1600, 1000], async run(page, s) {
    await go(page, `/p/${s.pid}/map/${s.ids.orders}`);
    await page.getByRole("button", { name: "Свернуть панель" }).last().click(); // правая (левая — первая)
    await page.locator('button[title="Развернуть панель"]').last().waitFor();
    await page.waitForTimeout(500);
    await page.locator(".react-flow__controls-fitview").click();
    await settle(page);
    await shoot(page, "shot-hero.png");
  } },

  // Глубина: страница «Сервиса заказов» — дерево развёрнуто до его детей, он выделен;
  // на схеме он раскрыт лупой на месте (рамка с детьми). В виде этой страницы раскрытие
  // и позиции детей уже сохранены — клик лупой гасится дедупом и в БД не пишет.
  depth: { size: [1600, 1200], async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orders}`);
    const chev = page.locator(".nt-row--current .nt-chevzone");
    if ((await chev.getAttribute("aria-expanded")) !== "true") await chev.click();
    const card = await scrollCardToTop(page, "Схема");
    await card.locator(".esb-activate").click(); // схема страницы инертна до клика
    const node = card.locator(`.react-flow__node[data-id="${s.ids.orders}"]`);
    await node.hover();
    await node.locator('button[title="Раскрыть содержимое"]').click();
    await card.locator(`.react-flow__node[data-id="${s.ids.orderApi}"]`).waitFor();
    await settle(page);
    await page.keyboard.press("Escape"); // деактивация схемы (синяя рамка «в работе»)
    await settle(page);
    await shoot(page, "shot-depth.png");
  } },

  // Врезка для карточки «Схемы с навигацией»: раскрытый контейнер крупно, кадр 4:3
  // (640×480 CSS → 1280×960) — только холст, без панелей и кнопок. Раскрытие — на
  // странице «Сервиса заказов», как в depth: на корне карты клик лупой пишет вид в БД.
  // В кадре: рамка с чипом «🔍 Сервис заказов ×», внутри Order API, связи наружу — от
  // API Gateway (REST) и к Kafka — с подписями. «БД заказов» в кадр не входит: она тоже
  // ребёнок контейнера и стоит у его правого края, через ~525 единиц от Order API, —
  // с ней заголовки в карточке ~300 px мельчают до 5–7 px.
  "depth-card": { size: [1400, 1100], async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orders}`);
    const card = await scrollCardToTop(page, "Схема");
    // кнопки зума, мини-карта и прочие панели холста — не в кадр (только в этой сцене)
    await page.addStyleTag({ content: ".react-flow__controls, .react-flow__minimap, .react-flow__panel { display: none !important; }" });
    await card.locator(".esb-activate").click();
    const node = card.locator(`.react-flow__node[data-id="${s.ids.orders}"]`);
    await node.hover();
    await node.locator('button[title="Раскрыть содержимое"]').click();
    await card.locator(`.react-flow__node[data-id="${s.ids.orderApi}"]`).waitFor();
    await settle(page);
    const canvas = card.locator(".react-flow").first();
    const cb = await canvas.boundingBox();
    // кадр — по центру холста: его кнопки по углам остаются снаружи
    const area = { w: 640, h: 480 };
    area.x = Math.round((cb.width - area.w) / 2);
    area.y = Math.round((cb.height - area.h) / 2);
    if (area.x < 100 || area.y < 0) throw new Error(`холст ${Math.round(cb.width)}×${Math.round(cb.height)} мал для кадра 640×480`);
    const texts = await flowTexts(canvas);
    const v0 = await rfView(canvas);
    const toFlow = (b) => ({ x0: (b.x - cb.x - v0.tx) / v0.k, y0: (b.y - cb.y - v0.ty) / v0.k, x1: (b.x + b.width - cb.x - v0.tx) / v0.k, y1: (b.y + b.height - cb.y - v0.ty) / v0.k });
    const api = toFlow(await card.locator(`.react-flow__node[data-id="${s.ids.orderApi}"]`).boundingBox());
    const one = (re) => {
      const hits = texts.filter((t) => re.test(t.text));
      if (!hits.length) throw new Error(`на холсте нет надписи ${re}`);
      // ближайшая к Order API (одноимённые надписи бывают и в других местах)
      return hits.sort((a, b) => Math.hypot(a.x0 - api.x0, a.y0 - api.y0) - Math.hypot(b.x0 - api.x0, b.y0 - api.y0))[0];
    };
    // Обязательное — Order API и чип рамки («🔍 » — отдельный текстовый узел). Подписи
    // связей наружу (от API Gateway, к Kafka) не обязательны: линии пересекают рамку в
    // любом случае, а подпись в каждом окне либо целиком видна, либо целиком скрыта.
    const req = unite(api, one(/^Сервис заказов$/));
    const plan = planFrame(req, texts, area, 12, CARD_WINDOWS, [0]);
    if (!plan) throw new Error("не нашлось кадра без разрезанных подписей");
    await applyView(page, canvas, plan.z, area.x - plan.x0 * plan.z, area.y - plan.y0 * plan.z);
    await settle(page, 300);
    // проверка по факту: в самом файле ни одна надпись не режется краем (иначе ⚠); что
    // срезают края карточки на других ширинах — справкой (ℹ): при cover это неизбежно
    const v1 = await rfView(canvas);
    const now = await flowTexts(canvas);
    const cutIn = (w) => [...new Set(now.filter((t) => cutBy(t, (area.x + w[0] - v1.tx) / v1.k, (area.y + w[1] - v1.ty) / v1.k,
      (area.x + w[2] - v1.tx) / v1.k, (area.y + w[3] - v1.ty) / v1.k)).map((t) => t.text))];
    ["файл", "три колонки", "~700 px", "телефон"].forEach((label, i) => {
      const cut = cutIn(CARD_WINDOWS[i]);
      if (cut.length) (i === 0 ? warnings : notes).push(`crop-depth-card.png, ${label}: краем режутся надписи — ${cut.join("; ")}`);
    });
    console.log(`  масштаб холста ${v1.k.toFixed(2)}: заголовок узла ≈ ${(13 * v1.k).toFixed(1)} px`);
    await shootClip(page, "crop-depth-card.png", { x: cb.x + area.x, y: cb.y + area.y, width: area.w, height: area.h });
  } },

  // Страница Order API: конфигурация (страница упирается в конец — на кадре заодно
  // карточки «Логика» с привязками схем к операциям и «OpenAPI»), окна схемы логики
  // и спеки — просмотром, как их открывает клик по строке.
  "order-api": { size: [1600, 1200], async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orderApi}`);
    await scrollCardToTop(page, "Конфигурация");
    await shoot(page, "shot-config.png");

    await page.locator(`button[title="Открыть схему «${DOC_LOGIC}»"]`).click();
    await page.locator("dialog[open] svg").first().waitFor();
    await settle(page, 1200);
    await shoot(page, "shot-logic.png");
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "detached" });

    await page.locator('.np-card:has(h3:text-is("OpenAPI")) .np-doc-row').click();
    await page.locator("dialog[open] .opblock").nth(1).waitFor();
    await settle(page, 1200);
    // Отметок «операция ↔ схема логики» в Swagger-просмотре нет: они в карточке
    // «Логика» страницы (METHOD /path у схемы) — она видна на кадре shot-config.
    await shoot(page, "shot-openapi.png");
  } },

  // Структура БД заказов: ER-диаграмма в карточке и во весь экран.
  db: { size: [1600, 1200], async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.ordersDb}`);
    await page.getByRole("button", { name: "Показать диаграмму" }).click();
    const card = await scrollCardToTop(page, "Структура");
    await card.locator("svg").first().waitFor();
    await settle(page, 1200);
    await shoot(page, "shot-db.png");
    await card.getByText("во весь экран").click();
    await page.locator("dialog[open] svg").first().waitFor();
    await settle(page, 1200);
    await shoot(page, "shot-db-full.png");
  } },

  // Канал Kafka: раскрыт catalog.product-events — тип, гарантия, срок хранения, поля.
  broker: { size: [1600, 1200], async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.kafka}`);
    await page.locator(`.bch-channel[data-flip-id="${s.channelId}"] .bch-chev`).click();
    await scrollCardToTop(page, "Каналы");
    await shoot(page, "shot-broker.png");
  } },

  // Якорь: редактор-карта уровня «Сервис заказов», двойной клик по Order API —
  // узел выделен, в правой панели свойства с якорем (репозиторий и путь).
  anchor: { size: [1600, 1200], async run(page, s) {
    await go(page, `/p/${s.pid}/map/${s.ids.orders}`);
    const box = await page.locator(`.react-flow__node[data-id="${s.ids.orderApi}"]`).boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByText("github.com/yarmarka/orders").first().waitFor();
    await settle(page);
    await shoot(page, "shot-anchor.png");
  } },

  // Процесс «Оформление заказа» в конструкторе (режим правки — локальная настройка
  // вида, не запись); вторым кадром — карточка шага с привязанной схемой логики.
  process: { size: [1600, 900], async run(page, s) {
    await go(page, `/p/${s.pid}`);
    await page.locator('button[title="Бизнес-процессы"]').click();
    await page.getByText(PROCESS, { exact: true }).first().click();
    await settle(page);
    await page.locator('button[title="Свернуть в рейл"]').click();
    await page.getByRole("button", { name: "Редактировать" }).first().click();
    await page.getByRole("button", { name: "Готово" }).waitFor();
    await settle(page);
    await shoot(page, "shot-process.png");
    await page.getByText(s.stepCaption, { exact: true }).first().click();
    await page.getByText("Схема логики", { exact: true }).waitFor();
    await settle(page);
    await shoot(page, "shot-process-step.png");
    await page.getByRole("button", { name: "Отмена" }).click(); // закрыть карточку без записи
  } },

  // Статусы: корень редактора-карты с сохранённым раскрытием «Маркетплейса» и
  // «Сервиса уведомлений». Рядом — «Сервис рекомендаций» (новый), «SMS-рассыльщик»
  // (выводится) и существующие соседи; Order API спрятан в свёрнутом «Сервисе заказов».
  status: { size: [2100, 900], async run(page, s) {
    await go(page, `/p/${s.pid}/map`);
    await page.getByRole("button", { name: "Свернуть панель" }).last().click(); // правая
    await page.getByRole("button", { name: "Свернуть панель" }).first().click(); // левая
    await page.getByRole("radio", { name: "Переход", exact: true }).click(); // вид «все статусы»
    await settle(page);
    await page.locator(".react-flow__controls-fitview").click();
    await settle(page);
    await frameNodes(page, [s.ids.recs, s.ids.orders, s.ids.sms, s.ids.notifWorker, s.ids.notifDb], 0.8);
    await shoot(page, "shot-status.png");
  } },

  // Импорт YAML: «Новый проект» → «Импорт» (из свитчера проектов — фоном демо-проект,
  // а не список всех проектов), пара YAML, живой статус и разбор остатка. НИЧЕГО не
  // создаётся: имени нет, кнопка «Создать проект» неактивна, окно закрываем «Отменой».
  import: { size: [1600, 1200], async run(page, s) {
    await go(page, `/p/${s.pid}`);
    await page.locator("button", { hasText: PROJECT_NAME }).first().click();
    await page.getByRole("button", { name: "Новый проект" }).click();
    const dlg = page.locator("dialog[open]");
    await dlg.getByRole("button", { name: "Импорт", exact: true }).click();
    const preview = () => page.waitForResponse((r) => r.url().includes("/projects/import/unified-preview"), { timeout: 20000 });
    let wait = preview();
    await dlg.locator("textarea").last().fill(readFileSync(join(ROOT, "mock-import.yaml"), "utf8"));
    await wait;
    await dlg.locator('button[title="Добавить ещё один YAML вставкой"]').click();
    wait = preview();
    await dlg.locator("textarea").last().fill(SECOND_YAML);
    await wait;
    await dlg.locator(".rq-st").first().waitFor();
    await settle(page);
    // Тело модалки — к ряду чипов «Файл 1 · Файл 2»: видны вставки, статус и вопрос
    await dlg.locator(".cp-chip").first().evaluate((chip) => {
      let sc = chip.parentElement;
      while (sc && !(sc.scrollHeight > sc.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      if (sc) sc.scrollTop += chip.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8;
    });
    // Поле вставки — к началу текста (после вставки оно прокручено к каретке в конце)
    await dlg.locator("textarea").last().evaluate((t) => { t.scrollTop = 0; });
    await shoot(page, "shot-import.png");
    await dlg.getByRole("button", { name: "Отмена" }).click();
  } },
};

// ── Прогон ───────────────────────────────────────────────────────────────────
const pw = await import(PW_MODULE);
const { chromium } = pw.default;
const token = await login();
const scene = await resolveScene(token);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  headless: true,
});
console.log(`Проект «${PROJECT_NAME}» → ${OUT}`);
for (const [name, shot] of Object.entries(SHOTS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  console.log(`• ${name}`);
  const before = blocked.length;
  const { ctx, page } = await newPage(browser, token, scene.pid, shot.size[0], shot.size[1], name);
  try {
    await shot.run(page, scene);
  } catch (e) {
    results.push({ shot: name, error: e.message.split("\n")[0] });
    console.log(`  ✗ ${name}: ${e.message.split("\n")[0]}`);
  }
  if (blocked.length > before) console.log(`  ! ${name}: UI пытался писать — запросы оборваны сторожем`);
  await ctx.close();
}
await browser.close();

console.log("\nИтог:");
for (const r of results) console.log(r.error ? `  ✗ ${r.shot}: ${r.error}` : `  ${r.file}  ${r.w}×${r.h}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
for (const n of notes) console.log(`  ℹ ${n}`);
for (const b of blocked) console.log(`  ⛔ ${b.shot}: ${b.method} ${b.path} (оборвано, в БД не дошло)`);
if (blocked.length || results.some((r) => r.error)) process.exit(1);
