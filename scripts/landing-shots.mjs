// Скриншоты РЕАЛЬНОГО интерфейса ArchMap для лендинга: неподвижные кадры демо-проекта
// «Маркетплейс «Ярмарка»» вместо нарисованных мокапов. Один прогон снимает все кадры
// подряд; повторный прогон после правок UI перезаписывает PNG. Ролики снимает
// scripts/landing-videos.mjs.
//
// Запуск (стек поднят через ./dev.sh; другой стенд — ARCHMAP_FRONTEND и ARCHMAP_BACKEND):
//   node scripts/landing-shots.mjs                          # кадры копии «Ярмарки» → landing-shots/
//   node scripts/landing-shots.mjs --only process,crop-db   # выборочно (имена — ниже, в SHOTS)
//   node scripts/landing-shots.mjs --out /tmp/shots         # другой каталог
//   node scripts/landing-shots.mjs --project "Имя"          # другой проект (по умолчанию копия «Ярмарки»)
//   node scripts/landing-shots.mjs --only embed --embed frontend/dist-embed   # картинка живой схемы
// Кадры: crop-* — врезки (вкладки «Не только схема», карточка «Схемы с навигацией», вопрос
// импорта, холст «Развёртывание»), shot-process — раздел «Процессы», embed-still — живая
// схема на телефоне (сцена embed снимает свежую сборку npm run build:embed и без --embed
// пропускается).
//
// Правило масштаба: текст интерфейса читается на странице лендинга. Колонка страницы
// 1200 px: кадр во всю ширину снимается окном около 1280×800 при DSF 2 (в широком окне
// интерфейс на странице выходит мелким); врезка вкладки показывается на 760 px, её файл
// около 1700 px; основной текст (13 px) на странице не мельче 11 px. Сцены печатают расчёт.
//
// Кадры «Ярмарки» снимаются на КОПИИ эталона («Новый проект» → «Копия» из «… v2», имя демо
// «Маркетплейс «Ярмарка»», описание как у демо в app/demo.py): сам эталон «… v2» не трогаем,
// из него пересобирается демо-шаблон. Копию до съёмки готовят через интерфейс: на корне
// карты «Переразложить уровень», для кадра depth-canvas — схема страницы «Сервиса поиска»
// (что именно — в комментарии сцены).
//
// Мок (MOCKS ниже): раздел «Где что крутится» (холст «Развёртывание») показывает не
// «Ярмарку», а маленький придуманный проект «Онлайн-касса» из scripts/fixtures/
// landing-deploy.yaml: на большой схеме площадки тонут в объектах. Сцена мока снимается
// только на своём моке, прогон по «Ярмарке» её пропускает, а прогон по моку — все остальные:
//   node scripts/landing-shots.mjs --only deploy-canvas --project "Онлайн-касса"
// Второй мок, «Уведомления заказов» (landing-status.yaml), нужен только ролику статусов
// (landing-videos.mjs). Моки живут в базе рядом с эталоном; пересоздание из фикстур и
// расстановка — docs/plan-landing-docs-2026-11.md §2.4.
// Учётка — ARCHMAP_USERNAME/ARCHMAP_PASSWORD из окружения, иначе из mcp/.env
// (учётка демо-проекта). Токен в вывод не печатается.
//
// Правила съёмки (ТЗ дизайнера):
//  • Chromium, светлая тема, ru-RU, размер окна и DSF — по кадру;
//  • перед кадром — networkidle + оседание раскладки (счётчик __archmapLayoutInflight,
//    индикатор .lg-busy, стабильная сигнатура узлов/рёбер/вьюпорта) + 800 мс;
//  • состояние наводится ТОЛЬКО через UI: клики, URL, колесо и пан вьюпорта. В DOM и
//    данные ничего не подмешивается. Стилем скрыты лишь артефакты съёмки: тосты холста,
//    оверлей ошибок Vite (их появление пишется в лог), кнопки холста у врезок холста,
//    строка или подпись, которую режет край кадра, и то, что лежит в кадре за пределами
//    снимаемого блока (оформление врезки, как поле вокруг неё);
//    каретку прячет сам Playwright (caret: "hide"), курсор паркуется на пустой шапке.
//  • БД НЕ МЕНЯЕТСЯ: сетевой сторож обрывает любой не-GET запрос к API, кроме двух
//    заведомо сухих превью (data-refs/preview — обращения схемы логики,
//    projects/import/unified-preview — сводка импорта). Попытка записи — кадр
//    считается проваленным, скрипт выходит с кодом 1. Поэтому кадры выбраны там, где
//    UI ничего не пишет: раскрытие лупой — на схеме страницы «Сервиса поиска», где оно уже
//    сохранено в виде (клик гасится дедупом), холст «Развёртывание» — на моке с
//    сохранённой расстановкой. Первый показ любого вида пишет его раскладку, поэтому
//    вид, который ни разу не открывали, до съёмки открывают через интерфейс.
import { readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, resolve, sep } from "node:path";
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
const PROJECT_NAME = argOf("--project") ?? "Маркетплейс «Ярмарка»";
const ONLY = argOf("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const EMBED_DIR = argOf("--embed") ? resolve(argOf("--embed")) : null;
const DSF = 2;

// ── Имена демо-проекта (всё резолвится по именам через API, id не зашиты) ────────
const N = {
  orderApi: "Order API",
  ordersDb: "БД заказов",
  kafka: "Kafka",
  // кадр карточки «Схемы с навигацией» (depth-canvas)
  search: "Сервис поиска",
  searchApi: "Search API",
  elastic: "Elasticsearch",
  catalog: "Сервис каталога",
  gateway: "API Gateway",
};
const DOC_LOGIC = "Создание заказа";
const CHANNEL = "catalog.product-events";
const PROCESS = "Оформление заказа";

// ── Мок лендинга: сцена раздела снимается на своём маленьком проекте ───────────
// Имена «Ярмарки» (N) в моке не ищутся.
const MOCKS = {
  "Онлайн-касса": { scenes: ["deploy-canvas"] },
};
const MOCK = MOCKS[PROJECT_NAME] ?? null;
// Сцена → мок, на котором она снимается; сцены без мока — на «Ярмарке» или её копии
const MOCK_OF = Object.fromEntries(Object.entries(MOCKS).flatMap(([p, m]) => m.scenes.map((sc) => [sc, p])));
// Сцены без проекта: снимают не стенд, а собранную страницу (живая схема)
const LOCAL = new Set(["embed"]);

// Вторая «пара» к scripts/fixtures/mock-import.yaml для кадра импорта: прогон агента в другом
// репозитории той же демо-системы «Плёнка» (мульти-репо сценарий «Из репозитория»). У объектов с
// вложенными тип указан: без него ввоз файл не принимает (решение владельца 2026-11-01).
const SECOND_YAML = `# Прогон агента в репозитории биллинга «Плёнки»
nodes:
  - name: Плёнка
    shape: service
    element: system
    role: система
    children:
      - name: Сервис биллинга
        shape: service
        element: system
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
  if (MOCK) return { pid };
  const nodes = await api(token, "/nodes/all", pid);
  const idOf = (name) => {
    const hits = nodes.filter((n) => n.name === name);
    if (hits.length !== 1) throw new Error(`Объект «${name}»: найдено ${hits.length}`);
    return hits[0].id;
  };
  const ids = {};
  for (const [key, name] of Object.entries(N)) ids[key] = idOf(name);
  const channels = await api(token, `/nodes/${ids.kafka}/channels`, pid);
  if (!channels.some((c) => c.name === CHANNEL)) throw new Error(`Канал «${CHANNEL}» не найден`);
  const processes = await api(token, "/processes", pid);
  const proc = processes.find((p) => p.name === PROCESS);
  if (!proc) throw new Error(`Процесс «${PROCESS}» не найден`);
  const detail = await api(token, `/processes/${proc.id}`, pid);
  // Шаг для панели шага: первый по порядку, чья схема логики — «Создание заказа»
  const step = [...detail.messages].sort((a, b) => a.order - b.order).find((m) => m.doc_name === DOC_LOGIC);
  if (!step) throw new Error(`В процессе нет шага со схемой «${DOC_LOGIC}»`);
  return { pid, ids, stepCaption: step.caption };
}

// ── Браузер ──────────────────────────────────────────────────────────────────
const blocked = [];   // попытки записи, оборванные сторожем
const warnings = [];  // артефакты и прочие замечания по кадрам
// Лупа «🔍» на узлах и рамках — эмодзи: без шрифта с ним (fonts-noto-color-emoji или
// NotoColorEmoji.ttf в ~/.local/share/fonts) Chromium рисует вместо неё квадрат.
if (!spawnSync("fc-list", [":charset=1f50d", "family"]).stdout?.toString().trim()) {
  warnings.push("нет шрифта с эмодзи 🔍 — лупа на узлах и рамках выйдет квадратом (fonts-noto-color-emoji)");
}
const results = [];   // { file, w, h } | { shot, error }

async function newPage(browser, token, pid, w, h, shot, dsf = DSF) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: dsf,
    colorScheme: "light",
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
  });
  // Токен и проект — в localStorage ДО старта приложения (App читает их при маунте)
  await ctx.addInitScript(([t, p, css]) => {
    try {
      if (t) localStorage.setItem("access_token", t);
      if (p) localStorage.setItem("archmap.lastProjectId", p);
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

// Раздел страницы объекта по заголовку: «Схема», «Конфигурация», «Каналы»…
const section = (page, title) => page.locator(`.ds-sec:has(h3.ds-sec-title:text-is("${title}"))`).first();

// Прокрутка страницы объекта так, чтобы блок встал верхом на offset px от верха окна (как
// колесом — скролл-контейнер страницы .np-page; упирается в конец страницы, это нормально).
// Подгонка повторяется: блоки выше (схема страницы) дорастают до своей высоты уже после
// первого сдвига и толкают цель вниз.
async function scrollToTop(page, block, offset) {
  await block.waitFor();
  for (let i = 0; i < 6; i++) {
    const moved = await block.evaluate((e, off) => {
      const sc = e.closest(".np-page");
      if (!sc) return 0;
      const before = sc.scrollTop;
      sc.scrollTop += e.getBoundingClientRect().top - off;
      return Math.abs(sc.scrollTop - before);
    }, offset);
    await page.waitForTimeout(500);
    if (moved < 1) break;
  }
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
    // Точность — пиксель: сдвиг меньше пикселя мышью не выполнить (порог драга), а кадру
    // такая точность не нужна.
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
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
    if (process.env.SHOTS_DEBUG) console.log(`  пан ${buttons[0]} на ${dx.toFixed(0)},${dy.toFixed(0)} из ${start.x.toFixed(0)},${start.y.toFixed(0)}: ${v.tx.toFixed(0)},${v.ty.toFixed(0)} → ${after.tx.toFixed(0)},${after.ty.toFixed(0)} (цель ${tx.toFixed(0)},${ty.toFixed(0)})`);
    if (Math.abs(after.tx - v.tx) < 0.5 && Math.abs(after.ty - v.ty) < 0.5) buttons.reverse(); // эта кнопка не панорамирует
  }
  throw new Error("вьюпорт не встал в расчётное положение (SHOTS_DEBUG=1 печатает попытки)");
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

// ── Врезки вкладок «Не только схема» ─────────────────────────────────────────
// Окно вкладок на лендинге 16:10.4 шириной 760 px: врезка — блок интерфейса шириной около
// 850 CSS px (файл около 1700 px), на сайте он идёт в масштабе около 0,9 и читается.
// Высота — ровно пропорция окна: при переключении вкладок картинка не прыгает.
const STAGE_RATIO = 16 / 10.4;
const STAGE_W = 760;
// Размер основного текста интерфейса (13 px) на лендинге при ширине кадра w CSS px
const onStage = (w, px = 13) => `${px} px → ${(px * STAGE_W / w).toFixed(1)} px на лендинге`;
// Окна поверх страницы (схема логики, спецификация, ER-диаграмма) снимаются «плоским
// окном»: без своих скруглений, рамки и тени — рамку и скругление рисует окно вкладок
// лендинга, и в углах не выступает подложка (затемнение под окном, фон страницы).
// Строка текста на нижнем крае кадра скрывается целиком (cutText), а не режется пополам —
// у схем край холста естественен.
async function shootFlat(page, file, target, { cutText = true } = {}) {
  await page.addStyleTag({ content: "dialog::backdrop{background:transparent!important}" });
  // Скругление и тень бывают и у самого dialog, и у его корня внутри
  await target.evaluate((e) => {
    for (const el of [e, e.firstElementChild].filter(Boolean)) {
      for (const [k, v] of [["border-radius", "0"], ["box-shadow", "none"], ["border-color", "transparent"], ["outline", "none"]]) {
        el.style.setProperty(k, v, "important");
      }
    }
  });
  const box = await target.boundingBox();
  const width = Math.round(box.width);
  const height = Math.round(width / STAGE_RATIO);
  if (box.height < height) throw new Error(`окно ${width}×${Math.round(box.height)} ниже кадра ${width}×${height} — увеличьте высоту окна сцены`);
  const clip = { x: Math.round(box.x), y: Math.round(box.y), width, height };
  if (cutText) await hideCutText(target, clip.y + clip.height);
  console.log(`  окно ${width} px: ${onStage(width)}`);
  await shootClip(page, file, clip);
}
// Текст, который режет нижний край кадра edge, прячется целиком: по текстовым узлам, а не по
// элементам (текст бывает прямо в ячейке рядом с вложенными). Поля ввода (у архитектора)
// текстовых узлов не имеют — их край ловится по самому элементу.
async function hideCutText(root, edge) {
  await root.evaluate((e, edge) => {
    const crosses = (r) => r.top < edge && r.bottom > edge;
    const hide = (el) => el.style.setProperty("visibility", "hidden", "important");
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      if (!n.textContent.trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) {
        if (crosses(r)) { hide(n.parentElement); break; }
      }
    }
    for (const f of e.querySelectorAll("textarea, input, select")) {
      if (crosses(f.getBoundingClientRect())) hide(f);
    }
  }, edge);
}
// Врезка блока страницы объекта (раздел, шапка со свойствами): колонка документа с полем
// PAD вокруг, от верха блока first до низа блока last на высоту пропорции окна. Всё, что на
// странице ниже last, в кадр не идёт — прячется (оформление кадра: иначе снизу торчал бы
// верх следующего раздела); короткий блок добирается белым полем страницы.
const PAD = 16;
async function shootBlock(page, file, first, last = first) {
  const col = await page.locator(".np-header").boundingBox();
  const top = await first.boundingBox();
  const width = Math.round(col.width + 2 * PAD);
  const clip = { x: Math.round(col.x - PAD), y: Math.round(top.y - PAD), width, height: Math.round(width / STAGE_RATIO) };
  const vp = page.viewportSize();
  if (clip.y + clip.height > vp.height) throw new Error(`кадр ${width}×${clip.height} выходит за окно ${vp.width}×${vp.height} — увеличьте высоту окна сцены`);
  const bottom = await last.evaluate((e) => {
    // Следом идущее на каждом уровне вверх до колонки документа — прячем
    for (let el = e; el && !el.classList.contains("np-inner"); el = el.parentElement) {
      for (let n = el.nextElementSibling; n; n = n.nextElementSibling) n.style.setProperty("visibility", "hidden", "important");
    }
    return e.getBoundingClientRect().bottom;
  });
  if (bottom > clip.y + clip.height) {
    warnings.push(`${file}: блок ниже кадра на ${Math.round(bottom - clip.y - clip.height)} px — низ блока срезан`);
    await hideCutText(last, clip.y + clip.height);
  }
  console.log(`  колонка ${Math.round(col.width)} px, кадр ${width} px: ${onStage(width)}; блок занимает ${Math.round(100 * (Math.min(bottom, clip.y + clip.height) - clip.y + PAD) / clip.height)}% высоты кадра`);
  await shootClip(page, file, clip);
}
// Левую панель (дерево) — в полосу: блоку страницы достаётся вся ширина окна
async function collapseTree(page) {
  await page.getByRole("button", { name: "Свернуть панель" }).first().click();
  await page.locator('button[title="Развернуть панель"]').first().waitFor();
  await page.waitForTimeout(400);
}
// Просмотрщик схемы (usePanZoom): перетаскивание левой кнопкой — пан.
async function dragViewer(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}
// Рамка узла mermaid-схемы в окне просмотра: flowchart — g.node с текстом text
async function svgNodeBox(page, text) {
  const n = page.locator("dialog[open] svg g.node").filter({ hasText: text }).first();
  await n.waitFor();
  return n.boundingBox();
}
// Подпись масштаба просмотрщика («90%»)
const viewerZoom = async (dlg) => (await dlg.getByText(/^\d+%$/).first().textContent()).trim();

// Что карточка «Схемы с навигацией» показывает из кадра 640×427: окно картинки на лендинге
// той же пропорции 3:2 шириной 440 px (object-fit: contain) — кадр целиком, без обрезки.
const CARD_WINDOWS = [[0, 0, 640, 427]];
const CARD_W = 440;

// Живая схема: статическая раздача папки сборки (npm run build:embed) на свободном порту
function serveDir(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".wasm": "application/wasm" };
  const server = createServer((req, res) => {
    const path = resolve(dir, "." + decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(dir + sep) || !existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" });
    res.end(readFileSync(path));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// ── Кадры ────────────────────────────────────────────────────────────────────
// Каждый кадр — своё окно в свежем контексте браузера; size — окно, dsf — плотность
// (по умолчанию 2), подобранная так, чтобы файл врезки был около 1700 px.
const SHOTS = {
  // Врезка для карточки «Схемы с навигацией». Мысль кадра: систему раскрыли прямо на схеме,
  // внутри рамки её объекты, а стрелки соседей идут внутрь рамки, каждая к своему объекту.
  // Кадр 3:2 (640×427 CSS → 1280×854), только холст: схема страницы «Сервиса поиска», он
  // раскрыт лупой — в рамке «🔍 Сервис поиска ×» Elasticsearch и Search API в ряд; над ними
  // свёрнутая система «Сервис каталога» (лупа, «1 из 4»: связь идёт от её «Индексатора
  // товаров») и API Gateway, обе стрелки входят в рамку сверху. Подписи связей скрыты
  // тумблером холста (настройка вида в браузере, в БД не пишет): на карточке 440 px они
  // выходят около 9 px (11 px × 1,19 × 440/640), мельче заголовков, и только шумят, а мысль
  // кадра несут стрелки. Кадр — ровно эта группа: рамка
  // «Маркетплейса», в которую она вложена, остаётся за краем, иначе две пунктирные рамки
  // спорят, какая из них раскрыта.
  // ⚠ Только на КОПИИ эталона, подготовленной через интерфейс: открыта страница «Сервиса
  // поиска» (первый показ вида сам пишет раскладку), он раскрыт лупой на её схеме, API
  // Gateway сдвинут вплотную к «Сервису каталога» (шаг столбцов 260), Elasticsearch и Search
  // API перетащены в ряд под «Сервис каталога» и API Gateway (шаг рядов около 175): группа
  // плотная, и на карточке 440 px заголовки блоков не мельче 10 px. Страничные схемы
  // стартуют свёрнутыми, и клик лупой по уже сохранённому раскрытию гасится дедупом — в БД
  // не пишет. На эталоне «… v2» эта страница не открывалась: сторож оборвёт её первую
  // запись, и кадр провалится.
  "depth-canvas": { size: [1280, 900], async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.search}`);
    const card = section(page, "Схема");
    await scrollToTop(page, card, 70);
    await card.locator(".esb-activate").click(); // схема страницы инертна до клика
    const labels = card.getByRole("button", { name: "Подписи связей" });
    if ((await labels.getAttribute("aria-pressed")) !== "true") await labels.click();
    // кнопки зума, мини-карта и прочие панели холста — не в кадр (только в этой сцене)
    await page.addStyleTag({ content: ".react-flow__controls, .react-flow__minimap, .react-flow__panel { display: none !important; }" });
    const node = card.locator(`.react-flow__node[data-id="${s.ids.search}"]`);
    await node.hover();
    await node.locator('button[title="Раскрыть содержимое"]').click();
    await card.locator(`.react-flow__node[data-id="${s.ids.searchApi}"]`).waitFor();
    await settle(page);
    const canvas = card.locator(".react-flow").first();
    const cb = await canvas.boundingBox();
    // кадр — по центру холста: его кнопки по углам остаются снаружи
    const area = { w: CARD_WINDOWS[0][2], h: CARD_WINDOWS[0][3] };
    area.x = Math.round((cb.width - area.w) / 2);
    area.y = Math.round((cb.height - area.h) / 2);
    if (area.x < 90 || area.y < 0) throw new Error(`холст ${Math.round(cb.width)}×${Math.round(cb.height)} мал для кадра ${area.w}×${area.h}`);
    const texts = await flowTexts(canvas);
    const v0 = await rfView(canvas);
    const toFlow = (b) => ({ x0: (b.x - cb.x - v0.tx) / v0.k, y0: (b.y - cb.y - v0.ty) / v0.k, x1: (b.x + b.width - cb.x - v0.tx) / v0.k, y1: (b.y + b.height - cb.y - v0.ty) / v0.k });
    const flowOf = async (id) => toFlow(await card.locator(`.react-flow__node[data-id="${id}"]`).boundingBox());
    const frame = await flowOf(s.ids.search);
    const [es, sa, cat, gw] = await Promise.all([s.ids.elastic, s.ids.searchApi, s.ids.catalog, s.ids.gateway].map(flowOf));
    // Расстановка подготовленной копии: дети в ряд, каждый сосед над «своим» ребёнком
    const mid = (b) => (b.x0 + b.x1) / 2;
    const w = es.x1 - es.x0;
    const arranged = Math.abs(es.y0 - sa.y0) < w * 0.1 && es.x1 < sa.x0 && cat.y1 < frame.y0 && gw.y1 < frame.y0 &&
      Math.abs(mid(cat) - mid(es)) < w * 0.25 && Math.abs(mid(gw) - mid(sa)) < w * 0.25;
    if (!arranged) throw new Error("на схеме страницы «Сервиса поиска» не та расстановка — кадр снимается на подготовленной копии (см. комментарий сцены)");
    const req = unite(unite(frame, cat), gw);
    const plan = planFrame(req, texts, area, 14, CARD_WINDOWS, [0], 2);
    if (!plan) throw new Error("не нашлось кадра без разрезанных подписей");
    await applyView(page, canvas, plan.z, area.x - plan.x0 * plan.z, area.y - plan.y0 * plan.z);
    await settle(page, 300);
    // проверка по факту: в самом файле ни одна надпись не режется краем (иначе ⚠)
    const v1 = await rfView(canvas);
    const now = await flowTexts(canvas);
    const win = CARD_WINDOWS[0];
    const cut = [...new Set(now.filter((t) => cutBy(t, (area.x + win[0] - v1.tx) / v1.k, (area.y + win[1] - v1.ty) / v1.k,
      (area.x + win[2] - v1.tx) / v1.k, (area.y + win[3] - v1.ty) / v1.k)).map((t) => t.text))];
    if (cut.length) warnings.push(`crop-depth-canvas.png: краем режутся надписи — ${cut.join("; ")}`);
    // на лендинге кадр показывается в окне карточки шириной 440 px
    const title = 13 * v1.k;
    console.log(`  масштаб холста ${v1.k.toFixed(2)}: заголовок блока ≈ ${title.toFixed(1)} px в кадре, ${(title * CARD_W / area.w).toFixed(1)} px на карточке ${CARD_W} px`);
    await shootClip(page, "crop-depth-canvas.png", { x: cb.x + area.x, y: cb.y + area.y, width: area.w, height: area.h });
  } },

  // Врезка раздела «Развёртывание» — на моке «Онлайн-касса» (scripts/fixtures/landing-deploy.yaml):
  // холст «Развёртывание» всего проекта. Мысль кадра: площадки вложены рамками, сервис в двух
  // кластерах стоит дважды с пометками «1/2» и «2/2». Рамка «Облако» в три ряда: сверху ВМ
  // брокера, посередине Кластер A (Веб-кабинет, API кассы 1/2) и Кластер B (API кассы 2/2,
  // Фискализатор), снизу Managed PostgreSQL; внешний «Оператор фискальных данных» на этом
  // холсте не рисуется: внешняя система не размещается (Р42), поэтому группы «Размещение не
  // указано» в кадре нет. Кадр 16:10 (1280×800 CSS → 2560×1600, на лендинге во всю колонку
  // 1200 px), только холст; подписи связей скрыты тумблером холста (aria-pressed — «скрыты»;
  // настройка вида в браузере, в БД не пишет): семь подписей, три из них повторяют соседние,
  // перегружают кадр и ложатся на плашки площадок. Дерево слева свёрнуто — холсту вся ширина.
  // ⚠ Карточки мока расставлены заранее (авто-раскладка холста для врезки разрежена): первый
  // показ холста пишет раскладку вида, поэтому холст мока до съёмки открывается и
  // расставляется (§2.4 плана), а сцена только читает.
  "deploy-canvas": { size: [1600, 1100], async run(page, s) {
    await go(page, `/p/${s.pid}/deploy`);
    await page.locator(".react-flow__node").first().waitFor();
    await settle(page);
    await collapseTree(page);
    const labels = page.getByRole("button", { name: "Подписи связей" });
    if ((await labels.getAttribute("aria-pressed")) !== "true") await labels.click();
    await settle(page);
    // кнопки холста (undo, зум), мини-карта, легенда — не в кадр (только в этой сцене)
    await page.addStyleTag({ content: ".react-flow__controls, .react-flow__minimap, .react-flow__panel, .sleg-btn, .sleg-panel { display: none !important; }" });
    const canvas = page.locator(".dp-stage .react-flow").first();
    const cb = await canvas.boundingBox();
    const area = { w: 1280, h: 800 };
    area.x = Math.round((cb.width - area.w) / 2);
    area.y = Math.round((cb.height - area.h) / 2);
    if (area.x < 40 || area.y < 40) throw new Error(`холст ${Math.round(cb.width)}×${Math.round(cb.height)} мал для кадра ${area.w}×${area.h}`);
    const texts = await flowTexts(canvas);
    const v0 = await rfView(canvas);
    // обязательное — все карточки и рамки площадок целиком (плашки площадок — в надписях)
    const req = await canvas.evaluate((c, [tx, ty, k]) => {
      const cr = c.getBoundingClientRect();
      let b = null;
      for (const n of c.querySelectorAll(".react-flow__node")) {
        const r = n.getBoundingClientRect();
        if (!r.width) continue;
        const f = { x0: (r.left - cr.left - tx) / k, y0: (r.top - cr.top - ty) / k, x1: (r.right - cr.left - tx) / k, y1: (r.bottom - cr.top - ty) / k };
        b = b ? { x0: Math.min(b.x0, f.x0), y0: Math.min(b.y0, f.y0), x1: Math.max(b.x1, f.x1), y1: Math.max(b.y1, f.y1) } : f;
      }
      return b;
    }, [v0.tx, v0.ty, v0.k]);
    const win = [[0, 0, area.w, area.h]];
    const plan = planFrame(texts.reduce(unite, req), texts, area, 24, win, [0], 2);
    if (!plan) throw new Error("не нашлось кадра без разрезанных надписей");
    await applyView(page, canvas, plan.z, area.x - plan.x0 * plan.z, area.y - plan.y0 * plan.z);
    await settle(page, 300);
    const v1 = await rfView(canvas);
    const title = 13 * v1.k;
    console.log(`  масштаб холста ${v1.k.toFixed(2)}: заголовок карточки ≈ ${title.toFixed(1)} px в кадре, ${(title * 1200 / area.w).toFixed(1)} px на лендинге (1200 px)`);
    await shootClip(page, "crop-deploy-canvas.png", { x: cb.x + area.x, y: cb.y + area.y, width: area.w, height: area.h });
  } },

  // Раздел «Процессы» (кадр 16:10 во всю колонку 1200 px). Мысль кадра: процесс собран из
  // объектов архитектуры, а от шага один шаг до схемы логики. Процесс «Оформление заказа» в
  // чтении: участники сверху, пронумерованные шаги; выбран шаг, у которого есть схема логики
  // («Создание заказа»), справа его панель со строкой «Схема логики». Список процессов свёрнут:
  // ширина нужнее диаграмме. Выбор шага и свёртка списка — состояние экрана, в БД не пишут.
  // Окно 1280×800 при DSF 2: на колонке 1200 px подпись шага (12 px) выходит 11,3 px.
  process: { size: [1280, 800], async run(page, s) {
    await go(page, `/p/${s.pid}`);
    await page.getByRole("button", { name: "Процессы", exact: true }).first().click(); // вкладка шапки
    await settle(page);
    await page.locator(".pr-row", { hasText: PROCESS }).first().click();
    await settle(page);
    await page.getByRole("button", { name: "Свернуть список процессов" }).click();
    await settle(page);
    await page.locator(".seq-label").filter({ hasText: s.stepCaption }).first().click();
    await page.getByText("Схема логики", { exact: true }).first().waitFor();
    await settle(page);
    // Диаграмма длиннее окна и уходит за нижний край. Подпись шага, которую режет край окна,
    // прячется целиком (как строка у края врезки): иначе внизу висел бы обрывок подписи.
    const vh = page.viewportSize().height;
    const cut = await page.locator(".seq-label").evaluateAll((els, edge) => els.filter((e) => {
      const r = e.getBoundingClientRect();
      if (!(r.top < edge && r.bottom > edge)) return false;
      e.style.setProperty("visibility", "hidden", "important");
      return true;
    }).map((e) => e.textContent.trim().slice(0, 30)), vh);
    if (cut.length) console.log(`  у нижнего края скрыта подпись шага: ${cut.join("; ")}`);
    const fs = await page.locator(".seq-label").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    console.log(`  окно 1280 px на колонке 1200 px: подпись шага ${fs} px → ${(fs * 1200 / 1280).toFixed(1)} px, основной текст 13 px → ${(13 * 1200 / 1280).toFixed(1)} px`);
    await shoot(page, "shot-process.png");
  } },

  // Импорт YAML, врезка блока «Доверить агенту». Мысль кадра: при слиянии файлов от разных
  // агентов ArchMap задаёт понятный вопрос с вариантами ответа. «Новый проект» → «Импорт» (из
  // переключателя проектов — фоном демо-проект, а не список всех проектов), пара YAML вставкой
  // текста, живой статус и разбор остатка. В кадре строка статуса «Не всё сошлось идеально» и
  // блок вопроса целиком (счётчик «Вопрос 1 из N», вопрос, варианты, один «по умолчанию»,
  // «Назад/Дальше»), без зоны файлов и подвала окна (замечание владельца 2026-10-16). Окно
  // узкое (440 px, окно ввоза — во всю ширину без полей): вопрос переносится на четыре
  // строки, и врезка выходит почти квадратной, как место под неё на лендинге; плотность
  // подобрана под файл 1088 px в ширину. НИЧЕГО не создаётся: имени нет, кнопка «Создать
  // проект» неактивна, окно закрываем «Отменой».
  import: { size: [440, 1100], dsf: 1088 / 408, async run(page, s) {
    await go(page, `/p/${s.pid}`);
    await page.locator("button.ps-trigger").click();
    await page.locator("button.ds-menu-item", { hasText: "Новый проект" }).click();
    const dlg = page.locator("dialog[open]");
    await dlg.getByRole("button", { name: "Импорт", exact: true }).click();
    const preview = () => page.waitForResponse((r) => r.url().includes("/projects/import/unified-preview"), { timeout: 20000 });
    for (const text of [readFileSync(join(ROOT, "scripts", "fixtures", "mock-import.yaml"), "utf8"), SECOND_YAML]) {
      await dlg.getByRole("button", { name: "Вставить текст" }).click();
      const wait = preview();
      await dlg.locator("textarea.fz-paste").fill(text);
      await wait;
    }
    const status = dlg.locator(".rq-st").first();
    const block = dlg.locator(".rq-block").first();
    await block.getByText(/^Вопрос 1 из \d+$/).waitFor();
    await settle(page);
    // Поле врезки: по бокам 24 px (варианты ответа шире блока на 10 px), сверху и снизу не
    // меньше 16 px. Пропорция — как у прежнего файла (1088×1096): лендинг держит место под
    // почти квадратную картинку, поэтому короткий блок встаёт посередине по высоте.
    const PAD_Q = 16, PAD_X = 24, RATIO = 1088 / 1096;
    // Поле вставки над строкой статуса и свёртка «Придется подправить вручную» под блоком в
    // кадр не входят, а их края попадали бы в поля врезки — прячем всё, что выше строки
    // статуса и ниже блока.
    await block.evaluate((b) => {
      const hide = (n) => n.style.setProperty("visibility", "hidden", "important");
      for (let n = b.nextElementSibling; n; n = n.nextElementSibling) hide(n);
      const result = b.closest(".cp-result") ?? b.parentElement;
      for (let n = result.previousElementSibling; n; n = n.previousElementSibling) hide(n);
    });
    const st0 = await status.boundingBox();
    const bl0 = await block.boundingBox();
    const content = bl0.y + bl0.height - st0.y;
    const width = Math.round(bl0.width + 2 * PAD_X);
    const height = Math.max(Math.round(width / RATIO), Math.round(content + 2 * PAD_Q));
    if (height > Math.round(width / RATIO)) warnings.push(`crop-import.png: блок выше пропорции ${width}×${Math.round(width / RATIO)} — кадр ${width}×${height}`);
    const above = Math.floor((height - content) / 2);
    // Строка статуса — на above px ниже верха области прокрутки окна: над кадром шапка окна
    const scrollTop = await status.evaluate((el, off) => {
      let sc = el.parentElement;
      while (sc && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      if (!sc) return 0;
      const top = sc.getBoundingClientRect().top;
      sc.scrollTop += el.getBoundingClientRect().top - (top + off);
      return top;
    }, above);
    await page.waitForTimeout(300);
    const st = await status.boundingBox();
    const bl = await block.boundingBox();
    const clip = { x: Math.round(bl.x - PAD_X), y: Math.round(st.y - above), width, height };
    if (clip.y < scrollTop || clip.y + height > page.viewportSize().height) throw new Error("блок вопросов не помещается в окно — увеличьте высоту окна сцены");
    console.log(`  врезка ${clip.width}×${clip.height} CSS px; основной текст 13 px → ${(13 * 544 / clip.width).toFixed(1)} px при показе шириной 544 px`);
    await shootClip(page, "crop-import.png", clip);
    await dlg.getByRole("button", { name: "Отмена" }).click();
  } },

  // ── Врезки вкладок: каждая — блок интерфейса крупно (STAGE_RATIO, см. shootFlat) ──
  // Схема логики «Создание заказа». Мысль кадра: алгоритм обработчика нарисован блок-схемой.
  // Окно на чтение (окно схемы 848 px: шапка «Order API · Создание заказа · POST /orders»),
  // масштаб на шаг мельче открытого (87 %): под шапкой ромб «Позиций не больше лимита?»,
  // обе ветки и блоки под ними целиком — отказ «422: слишком много позиций» и расчёт суммы.
  // Блок проверки над ромбом в кадр уже не влезает: при 87 % текст схемы на лендинге
  // 12,5 px, а мельче шаг масштаба (76 %) дал бы меньше 11 px.
  "crop-logic": { size: [912, 760], async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orderApi}`);
    await page.locator(`button[title="Открыть схему «${DOC_LOGIC}»"]`).click();
    const dlg = page.locator("dialog[open]");
    await dlg.locator("svg").first().waitFor();
    await settle(page, 600);
    await dlg.getByRole("button", { name: "Уменьшить" }).click(); // шаг к центру, как щелчок по «−»
    await page.waitForTimeout(400);
    // Ромб — под шапку окна с полем 20 px (стрелка в него сверху уходит под шапку); тащим за
    // пустое поле слева от схемы
    const box = await dlg.boundingBox();
    const head = await dlg.locator(".doc-head").boundingBox();
    const diamond = await svgNodeBox(page, "Позиций не больше");
    await dragViewer(page, { x: box.x + 40, y: box.y + box.height / 2 }, 0, head.y + head.height + 20 - diamond.y);
    const bottom = box.y + Math.round(box.width / STAGE_RATIO);
    for (const t of ["422", "Посчитать"]) {
      const b = await svgNodeBox(page, t);
      if (b.y + b.height > bottom - 4) warnings.push(`crop-logic.png: блок «${t}…» срезан нижним краем кадра`);
    }
    const fs = await dlg.locator("svg g.node").first().evaluate((g) => parseFloat(getComputedStyle(g.querySelector("p, span, div") ?? g).fontSize));
    const z = await viewerZoom(dlg);
    console.log(`  масштаб ${z}: текст схемы ${fs} px → ${(fs * parseInt(z) / 100 * STAGE_W / box.width).toFixed(1)} px на лендинге`);
    await shootFlat(page, "crop-logic.png", dlg, { cutText: false });
  } },

  // Спецификация Order API. Мысль кадра: видно, какие эндпоинты сервис отдаёт наружу. Окно
  // спецификации (848 px): заголовок, описание и список операций целиком — «POST /orders»
  // свёрнута, последняя «GET /orders/{order_id}» раскрыта (параметр пути, ниже ответы):
  // раскрытая первая заслонила бы остальной список.
  "crop-openapi": { size: [912, 760], async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orderApi}`);
    await section(page, "OpenAPI").locator(".ds-row-main").first().click();
    const dlg = page.locator("dialog[open]");
    await dlg.locator(".opblock-summary").last().click();
    await dlg.locator(".opblock.is-open").first().waitFor();
    await settle(page, 800);
    await shootFlat(page, "crop-openapi.png", dlg);
  } },

  // ER-диаграмма БД заказов. Мысль кадра: таблицы, колонки и связи базы. Окно «Структура: БД
  // заказов» (848 px, открывается в масштабе для чтения 90 %), масштаб на шаг мельче (78 %):
  // таблица orders левым краем у поля окна — имя, типы и имена колонок, ключ; над ней линии
  // связей order_id и таблицы order_items (её имя у левого края) и order_saga, которые на неё
  // ссылаются. Пояснения колонок широкие, справа уходят за край окна.
  "crop-db": { size: [896, 760], async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.ordersDb}`);
    await page.getByRole("button", { name: "Показать диаграмму" }).click();
    await page.locator('button[title="Открыть диаграмму во весь экран"]').click();
    const dlg = page.locator("dialog[open]");
    await dlg.locator("svg").first().waitFor();
    await settle(page, 600);
    await dlg.getByRole("button", { name: "Уменьшить" }).click(); // шаг к центру, как щелчок по «−»
    await page.waitForTimeout(400);
    // Таблица order_items — левым краем у поля окна, верхом под шапкой: она в кадре целиком
    // (типы, имена, ключи, комментарии). Ниже левая часть orders (типы, имена, ключ) и связь
    // order_id между ними. Таблицы шире кадра из-за комментариев, обе целиком не входят: имя
    // orders стоит по центру таблицы и остаётся за правым краем, order_saga в кадр не попадает.
    const box = await dlg.boundingBox();
    const entity = (name) => dlg.locator(`svg g.node[id*="-entity-${name}-"]`).first();
    const items = await entity("order_items").boundingBox();
    await dragViewer(page, { x: box.x + box.width / 2, y: box.y + box.height - 40 }, box.x + 32 - items.x, box.y + 72 - items.y);
    await dlg.locator('button[aria-label="Увеличить"]').first().evaluate((b) => { b.parentElement.style.visibility = "hidden"; }); // пилюля масштаба
    // В кадре обязаны быть: имя order_items, левый край обеих таблиц (колонки типов и имён)
    // и не меньше трёх строк orders; order_saga в кадр не заходит
    const bottom = box.y + box.width / STAGE_RATIO;
    const right = box.x + box.width;
    const label = await entity("order_items").locator("text=order_items").first().boundingBox().catch(() => null);
    if (!label || label.x < box.x || label.x + label.width > right || label.y + label.height > bottom) warnings.push("crop-db.png: имя таблицы order_items не в кадре");
    const at = { items: await entity("order_items").boundingBox(), orders: await entity("orders").boundingBox(), saga: await entity("order_saga").boundingBox() };
    if (at.items.x < box.x || at.items.y + at.items.height > bottom) warnings.push("crop-db.png: таблица order_items режется краем кадра слева или снизу");
    if (at.orders.x < box.x || at.orders.x + 280 > right || at.orders.y + 130 > bottom) warnings.push("crop-db.png: левые колонки orders не в кадре");
    if (at.saga.x < right && at.saga.y < bottom) warnings.push("crop-db.png: в кадр зашёл край order_saga");
    const fs = await entity("orders").evaluate((g) => parseFloat(getComputedStyle(g.querySelector("p, span, div, text") ?? g).fontSize));
    const z = await viewerZoom(dlg);
    console.log(`  масштаб ${z}: текст таблицы ${fs} px → ${(fs * parseInt(z) / 100 * STAGE_W / box.width).toFixed(1)} px на лендинге`);
    await shootFlat(page, "crop-db.png", dlg, { cutText: false });
  } },

  // Канал Kafka catalog.product-events на странице брокера. Мысль кадра: у канала описаны поля
  // сообщения и видно, кто публикует и кто читает. Раздел «Каналы», канал раскрыт: назначение,
  // ключ, гарантия и срок хранения, поля, «Кто публикует / кто потребляет». Окно 960 px с
  // деревом в полосе: колонка документа 848 px, текст на лендинге не мельче 11 px.
  "crop-broker": { size: [960, 900], dsf: 1696 / 880, async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.kafka}`);
    await collapseTree(page);
    const sec = section(page, "Каналы");
    const items = sec.locator(".fact-item");
    // Имя канала у архитектора — в поле (значение не текст), у читателя — текстом
    const i = await items.evaluateAll((els, name) => els.findIndex((e) =>
      (e.querySelector('textarea[aria-label="Канал"]')?.value ?? e.querySelector(".fact-name")?.textContent ?? "").trim() === name), CHANNEL);
    if (i < 0) throw new Error(`на странице нет канала «${CHANNEL}»`);
    await items.nth(i).getByRole("button", { name: "Развернуть канал" }).click();
    await items.nth(i).getByText("Кто публикует / кто потребляет").waitFor();
    await scrollToTop(page, sec, 100); // ниже шапки приложения с полем врезки
    await settle(page, 400);
    // Блок кадра — раздел до раскрытого канала включительно: следующий канал не в кадр
    await shootBlock(page, "crop-broker.png", sec, items.nth(i));
  } },

  // Конфигурация Order API. Мысль кадра: параметры конфигурации с пояснением и со схемами,
  // которые от них зависят. Раздел «Конфигурация»: параметр, тип, обязательность, значение по
  // умолчанию из кода, «что переключает» и строки «Зависит: …» под ним. Окно 912 px с деревом
  // в полосе: колонка документа 802 px — в 748 px имя MAX_ITEMS_PER_ORDER у архитектора уже
  // переносится; пояснения переносятся, и раздел заполняет кадр плотнее, чем в 848 px.
  // Ширина кадра 834 px даёт после плотности ровно 1696×1102, как у соседних врезок.
  "crop-config": { size: [914, 900], dsf: 1696 / 834, async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orderApi}`);
    await collapseTree(page);
    const sec = section(page, "Конфигурация");
    await sec.getByText(/^Зависит:/).first().waitFor();
    await scrollToTop(page, sec, 100); // ниже шапки приложения с полем врезки
    await settle(page, 400);
    await shootBlock(page, "crop-config.png", sec);
  } },

  // Источник Order API. Мысль кадра: у объекта записано, откуда он взялся — репозиторий и
  // путь. Шапка страницы (путь, имя, описание) и свойства со строкой «Источник»
  // («github.com/yarmarka/orders / services/order-api» целиком). Окно 760 px с деревом в
  // полосе: свойства встают одной колонкой, и шапка со свойствами заполняет кадр.
  "crop-anchor": { size: [760, 900], dsf: 1696 / 680, async run(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orderApi}`);
    await collapseTree(page);
    await page.getByText("github.com/yarmarka/orders / services/order-api").first().waitFor();
    const head = page.locator(".np-header");
    await scrollToTop(page, head, 100); // ниже шапки приложения с полем врезки
    await settle(page, 400);
    await shootBlock(page, "crop-anchor.png", head, page.locator(".np-props"));
  } },

  // Живая схема лендинга на телефоне (≤700 px лендинг вставляет картинку вместо iframe):
  // embed.html свежей сборки (npm run build:embed → frontend/dist-embed, путь — --embed) в
  // инертном виде, окно 640×640. Приглашение «Нажмите, чтобы…» и кнопки холста скрыты
  // стилем (кадр — сама схема), пульс подсказки на лупе стоит (animations: disabled).
  // Бэкенд не нужен: страница отвечает себе сама (src/embed/staticBackend).
  embed: { size: [640, 640], async run(page) {
    const server = await serveDir(EMBED_DIR);
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/embed.html`);
      await page.locator(".react-flow__node").first().waitFor();
      await settle(page);
      await page.addStyleTag({ content: ".esb-activate, .lp-done, .lg-seg, .react-flow__controls, .react-flow__panel, .sleg-btn { display: none !important; }" });
      const n = await page.locator(".react-flow__node").count();
      console.log(`  узлов на холсте: ${n}`);
      await shoot(page, "embed-still.png");
    } finally {
      server.close();
    }
  } },
};

// ── Прогон ───────────────────────────────────────────────────────────────────
const pw = await import(PW_MODULE);
const { chromium } = pw.default;
const names = Object.keys(SHOTS).filter((n) => !ONLY || ONLY.includes(n));
const needStand = names.some((n) => !LOCAL.has(n));
const token = needStand ? await login() : null;
const scene = needStand ? await resolveScene(token) : null;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  headless: true,
});
console.log(`Проект «${PROJECT_NAME}» → ${OUT}`);
for (const name of names) {
  const shot = SHOTS[name];
  // Сцена мока — только на своём моке; на моке — только его сцены; живая схема — с --embed
  const owner = MOCK_OF[name] ?? null;
  if (LOCAL.has(name)) {
    if (!EMBED_DIR || !existsSync(join(EMBED_DIR, "embed.html"))) {
      console.log(`• ${name}: пропуск — нужна сборка живой схемы (--embed frontend/dist-embed после npm run build:embed)`);
      continue;
    }
  } else if (owner !== (MOCK ? PROJECT_NAME : null)) {
    console.log(`• ${name}: пропуск — ${owner ? `снимается на моке «${owner}» (--project "${owner}")` : `на моке «${PROJECT_NAME}» этой сцены нет`}`);
    continue;
  }
  console.log(`• ${name}`);
  const before = blocked.length;
  const local = LOCAL.has(name);
  const { ctx, page } = await newPage(browser, local ? null : token, local ? null : scene.pid, shot.size[0], shot.size[1], name, shot.dsf);
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
for (const b of blocked) console.log(`  ⛔ ${b.shot}: ${b.method} ${b.path} (оборвано, в БД не дошло)`);
if (!results.length) console.log("  ✗ ни одного кадра: сцены не выбраны или все пропущены");
if (!results.length || blocked.length || results.some((r) => r.error)) process.exit(1);
