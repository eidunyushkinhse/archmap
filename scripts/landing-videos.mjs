// Ролики РЕАЛЬНОГО интерфейса ArchMap для лендинга: vid-hero (первый экран) и vid-status
// (раздел статусов). Всё в кадре — настоящий интерфейс: состояние наводится щелчками и URL,
// анимации продукта идут в реальном времени. Подмешиваются только курсор съёмки (Playwright
// курсор не рисует), плавная прокрутка области страницы (одна, в сцене «Логика») и скрытие
// артефактов (тосты холста, оверлей Vite).
//
// УСТРОЙСТВО. Ролик собирается из дублей (TAKES): у дубля своя подготовка в свежем контексте
// браузера (вне кадра) и свой записанный отрезок. Стык дублей стоит на щелчке, после которого
// продукт показывает «Загрузка», пустой холст, недоразложенную диаграмму или дольше 0,25 с
// готовит окно, и эти кадры из ролика уходят. Дубль кончается кадром нажатия (до отпускания
// кнопки, пока экран прежний), этот кадр держится CROSS секунд и растворяется в первый кадр
// следующего дубля. Следующий дубль начинается с курсора в той же точке окна, где щёлкнул
// предыдущий: курсор в растворении один, наведение под ним настоящее.
//   hero (копия «Ярмарки», окно 1280×800): «Архитектура» (страница системы «Заказы», раскрытие
//   лупой на схеме страницы, двойной щелчок по Order API) → «Логика» (страница Order API,
//   прокрутка до «Логики», окно схемы «Создание заказа», ссылка «Оформление заказа») →
//   «Процессы» (шаг «создать заказ» и его панель, вкладка «Развёртывание») → «Развёртывание»
//   (весь проект, «Заказы» в дереве, уровень одной системы). Петля: последний кадр за LOOP
//   секунд растворяется в первый кадр ролика, последний кадр файла совпадает с первым.
//   Скрипт печатает времена начала сцен в готовом файле (подписи сцен под роликом на лендинге).
//   status (мок «Уведомления заказов», окно 1260×540, 21:9): один дубль, петля действием:
//   «Как есть» → «Переход» → «Как будет» → «Как есть», последний кадр совпадает с первым.
//
// Данные стенда (готовятся один раз через интерфейс, сцены только читают; что именно —
// в комментариях дублей): копия эталона «Маркетплейс «Ярмарка»» (сам эталон «… v2» не
// трогаем) и мок «Уведомления заказов» (scripts/fixtures/landing-status.yaml). Пересоздание
// моков и расстановка — docs/plan-landing-docs-2026-11.md §2.4.
//
// Захват (--capture; по умолчанию первый доступный):
//   x11 — headed Chromium на виртуальном экране Xvfb, ffmpeg пишет прямоугольник окна
//         x11grab на 60 к/с без потерь. Xvfb скрипт поднимает сам (:97 или --display :N;
//         уже запущенный дисплей берёт как есть).
//   cdp — скринкаст CDP из headless: JPEG-кадры по мере отрисовки (~25 к/с), запасной путь.
//   pw  — recordVideo Playwright, только без ffmpeg: сырой WebM одного дубля
//         (vid-<name>.raw.webm) и data-start/data-end. Ролик из нескольких дублей так не
//         собрать: hero в этом режиме отказывается.
//
// Запуск (стек поднят через ./dev.sh; другой стенд — ARCHMAP_FRONTEND и ARCHMAP_BACKEND):
//   XVFB=<обёртка Xvfb> node scripts/landing-videos.mjs                # оба ролика → landing-shots/
//   node scripts/landing-videos.mjs --only hero --out DIR --trace
//   --capture x11|cdp|pw   режим захвата
//   --project "Имя"  проект ролика hero (по умолчанию копия «Маркетплейс «Ярмарка»»)
//   --scale N        масштаб окна (DSF): 1,5 — файл hero 1920×1200, status 1890×810
//   --fps N          частота файла: 60 в x11, 30 в cdp
//   --crf-mp4 / --crf-webm  качество x264 / VP9: 20 / 31
//   --display :N     дисплей Xvfb для x11 (по умолчанию :97)
//   --trace          хронометраж: отметки дублей во времени готового файла (подгонка пауз)
//   --keep-raw       оставить сырой захват и мастер без потерь во временном каталоге
// ffmpeg ищется в FFMPEG, PATH и ~/.cache/archmap-ffmpeg/ffmpeg (статическая сборка с x264,
// VP9 и x11grab); Xvfb — в XVFB и PATH.
//
// Сторож БД: любой не-GET запрос к API, кроме сухого превью пометок схемы логики, обрывается,
// и дубль бракуется. Дубли подобраны так, что интерфейс ничего не пишет (раскрытие на схеме
// страницы гасится дедупом сохранённого раскрытия, раскладки уровней сохранены заранее).
//
// Курсор — оверлей в странице: системная стрелка с белой обводкой и мягкой тенью, щелчок —
// сжатие стрелки и мягкий круг акцентного цвета. Движение — слабая дуга с профилем
// минимального рывка, длительность от расстояния (glide); перелёт рисует сама страница
// анимацией композитора, настоящая мышь идёт следом. Тайминги только по монотонным часам
// (настенные в WSL2 шагают назад, дубль с таким шагом переснимается).
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

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
const ONLY = argOf("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const FFMPEG = [process.env.FFMPEG, "ffmpeg", join(homedir(), ".cache/archmap-ffmpeg/ffmpeg")]
  .filter(Boolean)
  .find((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
const HAS_FFMPEG = Boolean(FFMPEG);
const HAS_X11GRAB = HAS_FFMPEG && /x11grab/.test(spawnSync(FFMPEG, ["-hide_banner", "-devices"]).stdout?.toString() ?? "");
const XVFB = process.env.XVFB ?? "Xvfb";
const DISPLAY = argOf("--display") ?? ":97";
// Дисплей жив: x11grab берёт с него кадр (xdpyinfo из x11-utils не обязателен)
const displayAlive = () => HAS_X11GRAB && spawnSync(FFMPEG, ["-loglevel", "quiet", "-f", "x11grab",
  "-video_size", "16x16", "-i", DISPLAY, "-frames:v", "1", "-f", "null", "-"], { stdio: "ignore" }).status === 0;
const HAS_XVFB = spawnSync(XVFB, ["-help"], { stdio: "ignore" }).status !== null || displayAlive();
const CAPTURE = (() => {
  const want = argOf("--capture");
  const can = { x11: HAS_XVFB && HAS_X11GRAB, cdp: HAS_FFMPEG, pw: true };
  if (want && !can[want]) {
    console.log(`! захват ${want} недоступен (${!HAS_FFMPEG ? "нет ffmpeg" : !HAS_X11GRAB ? "в ffmpeg нет x11grab" : "нет Xvfb"}), беру следующий доступный`);
  }
  if (want && can[want]) return want;
  return ["x11", "cdp", "pw"].find((m) => can[m]);
})();
// Рамка ролика на лендинге — колонка страницы 1200 px. Окно hero 1280 px: текст интерфейса на
// странице почти в натуральную величину (1200/1280). Масштаб 1,5 даёт файл 1920×1200 (на
// ретине рамка 2400 px, кадр растягивается на четверть и остаётся резким); 2× Chromium в Xvfb
// рисует программно лишь на 20–30 к/с.
const FRAME_W = 1200;
const SCALE = Number(argOf("--scale") ?? 1.5);
// cdp снимает с DSF 2 (скринкаст ~25 к/с, зато с запасом резкости) и ужимает кадр до того же
// размера файла, что x11
const CAP_DSF = CAPTURE === "cdp" ? 2 : SCALE;
const KEEP_RAW = args.includes("--keep-raw");
const FPS = Number(argOf("--fps") ?? (CAPTURE === "x11" ? 60 : 30));
// crf 20 / 31: на 26 / 36 мелкий текст схем заметно мылится. Не влезет в бюджет (hero 2,5 МБ,
// status 0,6 МБ на файл) — сначала сказать, качество текста молча не жертвовать.
const CRF_MP4 = Number(argOf("--crf-mp4") ?? 20);
const CRF_WEBM = Number(argOf("--crf-webm") ?? 31);
const TMP = join(tmpdir(), "archmap-landing-videos");

// ── Сцена: проекты и имена (резолвятся по именам через API) ──────────────────
const HERO_PROJECT = argOf("--project") ?? "Маркетплейс «Ярмарка»";
const STATUS_PROJECT = "Уведомления заказов";
const N = { orders: "Заказы", orderApi: "Order API" };
const DOC_LOGIC = "Создание заказа";
const PROCESS = "Оформление заказа";
const STATUS_FRAME = ["Заказы", "SMS-рассыльщик", "Центр уведомлений", "SMS-провайдер"];

const HIDE_CSS = `
vite-error-overlay, .lg-overload-toast, .lg-budget-toast, .lg-dirty-toast { display: none !important; }
`;
const DRY_RUN = [/\/api\/v1\/data-refs\/preview$/];

// ── Курсор съёмки ────────────────────────────────────────────────────────────
// Оверлей в странице: системная стрелка (чёрная, белая обводка, мягкая тень), остриё — в
// точке наведения. Размеры — в пикселях лендинга: контейнер масштабируется на K = ширина
// окна / ширина рамки, и на странице стрелка выходит около 20 px высотой при любом окне.
// Щелчок: стрелка за 90 мс сжимается до 0,9 и за 90 мс возвращается (нажатие и отпускание
// разнесены на 80 мс, дно сжатия приходится на отпускание), под остриём расходится мягкий
// круг акцентного цвета интерфейса (#2563eb, непрозрачность 0,22 → 0, диаметр 14 → 34 px,
// 300 мс). popover="manual" держит курсор в top-layer; при открытии <dialog> он поднимается
// заново, чтобы оставаться поверх окон. Правая кнопка (пан холста) круга не даёт.
// Положение в покое — из pointermove (дробные координаты). Перелёт рисует сама страница:
// __lpFly(точки, мс) — анимация transform по кадрам перелёта (Web Animations идут в потоке
// композитора, не ждут ни CDP, ни занятого главного потока), pointermove на это время
// стрелку не двигает, __lpLand() отдаёт её обратно мыши. Покадровый mouse.move из Node
// попадал в сетку кадров неровно: то два шага в кадр, то ни одного (кадры-дубли).
const ARROW = 0.85; // 20 px высоты стрелки на лендинге (путь стрелки 23,6 единицы)
const cursorJs = (k) => `(() => {
  const K = ${k.toFixed(4)}, A = ${ARROW};
  const css = '#lp-cur{position:fixed;left:0;top:0;right:auto;bottom:auto;width:0;height:0;margin:0;padding:0;border:0;background:none;overflow:visible;pointer-events:none;transform-origin:0 0;transform:translate(-9999px,-9999px);will-change:transform}'
    + '#lp-cur .arw{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform;filter:drop-shadow(0 1px 1.6px rgba(15,23,42,.32))}'
    + '#lp-cur .arw svg{position:absolute;left:' + (-2 * A) + 'px;top:' + (-2 * A) + 'px;display:block}'
    + '#lp-cur .rip{position:absolute;left:-17px;top:-17px;width:34px;height:34px;border-radius:50%;background:#2563eb;opacity:0;transform:scale(.4118);will-change:transform,opacity}'
    + '#lp-cur.clk .rip{animation:lprip .3s cubic-bezier(.2,.6,.35,1)}'
    + '@keyframes lprip{0%{opacity:.22;transform:scale(.4118)}100%{opacity:0;transform:scale(1)}}';
  const mount = () => {
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement('div'); c.id = 'lp-cur'; c.setAttribute('popover', 'manual');
    c.innerHTML = '<span class="rip"></span><span class="arw"><svg width="' + 20 * A + '" height="' + 28 * A + '" viewBox="0 0 20 28">'
      + '<path d="M2 2V22.5L7.2 17.8L10.6 25.6L13.6 24.3L10.3 16.6H17.2Z" fill="#14171f" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"></path></svg></span>';
    document.body.appendChild(c);
    const arw = c.querySelector('.arw');
    const raise = () => { try { c.hidePopover(); } catch {} try { c.showPopover(); } catch {} };
    raise();
    const at = (x, y) => 'translate(' + x + 'px,' + y + 'px) scale(' + K + ')';
    let fly = false;
    window.addEventListener('pointermove', (e) => { if (!fly) c.style.transform = at(e.clientX, e.clientY); }, true);
    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.classList.remove('clk'); void c.offsetWidth; c.classList.add('clk');
      // сжатие без полки: ровный спуск и подъём, кадр на дне не стоит
      arw.getAnimations().forEach((a) => a.cancel());
      arw.animate([{ transform: 'scale(1)' }, { transform: 'scale(.9)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'linear' });
    }, true);
    window.__lpFly = (pts, ms) => new Promise((done) => {
      fly = true;
      const kf = pts.map(([x, y]) => ({ transform: at(x, y) }));
      c.style.transform = kf[kf.length - 1].transform; // по окончании анимации стрелка остаётся в цели
      const a = c.animate(kf, { duration: ms, easing: 'linear' });
      a.onfinish = () => done(); a.oncancel = () => done();
    });
    window.__lpLand = () => { fly = false; };
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

// Проект по имени: ровно один, иначе неясно, что снимаем
async function projectByName(token, name) {
  const hits = (await api(token, "/projects")).filter((p) => p.name === name);
  if (hits.length !== 1) throw new Error(`Проект «${name}»: найдено ${hits.length}`);
  return hits[0].id;
}
async function nodeIds(token, pid, names) {
  const nodes = await api(token, "/nodes/all", pid);
  return Object.fromEntries(Object.entries(names).map(([key, name]) => {
    const hits = nodes.filter((n) => n.name === name);
    if (hits.length !== 1) throw new Error(`Объект «${name}»: найдено ${hits.length}`);
    return [key, hits[0].id];
  }));
}
// Сверка сцены: всё, что снимаем, обязано существовать — иначе падаем ДО браузера.
const RESOLVE = {
  async hero(token) {
    const pid = await projectByName(token, HERO_PROJECT);
    const ids = await nodeIds(token, pid, N);
    const proc = (await api(token, "/processes", pid)).find((p) => p.name === PROCESS);
    if (!proc) throw new Error(`Процесс «${PROCESS}» не найден`);
    const detail = await api(token, `/processes/${proc.id}`, pid);
    // Шаг сцены «Процессы»: первый по порядку, чья схема логики — «Создание заказа»
    const step = [...detail.messages].sort((a, b) => a.order - b.order).find((m) => m.doc_name === DOC_LOGIC);
    if (!step) throw new Error(`В процессе нет шага со схемой «${DOC_LOGIC}»`);
    return { pid, ids, stepCaption: step.caption };
  },
  async status(token) {
    const pid = await projectByName(token, STATUS_PROJECT);
    const ids = await nodeIds(token, pid, Object.fromEntries(STATUS_FRAME.map((n) => [n, n])));
    return { pid, frame: Object.values(ids) };
  },
};

// ── Браузер ──────────────────────────────────────────────────────────────────
const blocked = [];
const warnings = [];
const results = [];
// Лупа «🔍» на узлах и рамках — эмодзи: без шрифта с ним (fonts-noto-color-emoji или
// NotoColorEmoji.ttf в ~/.local/share/fonts) Chromium рисует вместо неё квадрат.
if (!spawnSync("fc-list", [":charset=1f50d", "family"]).stdout?.toString().trim()) {
  warnings.push("нет шрифта с эмодзи 🔍: лупа на узлах и рамках выйдет квадратом (fonts-noto-color-emoji)");
}

async function newPage(browser, token, pid, [w, h], name) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    // В x11 масштаб задаёт флаг браузера (окно растёт целиком), DSF контекста не нужен
    ...(CAPTURE === "x11" ? {} : { deviceScaleFactor: CAP_DSF }),
    colorScheme: "light",
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    // Встроенная запись Playwright — только запасной путь без ffmpeg (см. «Захват»)
    ...(CAPTURE === "pw" ? { recordVideo: { dir: TMP, size: { width: Math.round(w * SCALE), height: Math.round(h * SCALE) } } } : {}),
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
  const writes = [];
  await ctx.route("**/api/v1/**", (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;
    const dry = method === "POST" && DRY_RUN.some((re) => re.test(path));
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || dry) return route.continue();
    writes.push({ name, method, path });
    return route.abort("blockedbyclient");
  });
  const page = await ctx.newPage();
  const videoStart = now(); // запасной путь: запись стартует вместе со страницей
  page.on("pageerror", (e) => warnings.push(`${name}: ошибка страницы: ${e.message}`));
  return { ctx, page, videoStart, writes };
}

async function go(page, hash) {
  await page.goto(`${FRONTEND}/#${hash}`);
  await settle(page);
}

// Оседание (подготовка, вне кадра): сеть затихла, конвейер раскладки не в полёте,
// сигнатура узлов/рёбер/вьюпорта стабильна два замера подряд, затем пауза.
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

// Раздел страницы объекта по заголовку: «Схема», «Логика», «Конфигурация»…
const section = (page, title) => page.locator(`.ds-sec:has(h3.ds-sec-title:text-is("${title}"))`).first();

// Блок страницы объекта — верхом на offset px от верха окна (скролл-контейнер .np-page).
// Подгонка повторяется: блоки выше дорастают до своей высоты уже после первого сдвига.
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
    await page.waitForTimeout(400);
    if (moved < 1) break;
  }
}

// Точка прицела в тексте элемента (а не во всей строке-кнопке): остриё у нижней части
// слова, левее середины — стрелка висит под словом и его не закрывает
async function textPoint(locator) {
  await locator.waitFor();
  const p = await locator.evaluate((el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      if (!n.textContent.trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      const r = rg.getBoundingClientRect();
      if (r.width && r.height) return { x: r.left + r.width * 0.42, y: r.top + r.height * 0.78 };
    }
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * 0.42, y: r.top + r.height * 0.78 };
  });
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
async function boxCenter(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("цель вне экрана");
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

// Вьюпорт холста по виду: масштаб k колесом (d3-zoom: множитель 2^(−deltaY/500)) у центра
// узлов, затем сдвиг пустым местом холста (правой кнопкой, если узлы таскаются, иначе левой).
const RF_TRANSFORM = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/;
async function frameNodes(page, ids, k) {
  const measure = () => page.evaluate((list) => {
    const rs = list.map((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect()).filter(Boolean);
    const p = document.querySelector(".react-flow").getBoundingClientRect();
    const v = document.querySelector(".react-flow__viewport").style.transform;
    return {
      n: rs.length, v,
      x0: Math.min(...rs.map((r) => r.left)), y0: Math.min(...rs.map((r) => r.top)),
      x1: Math.max(...rs.map((r) => r.right)), y1: Math.max(...rs.map((r) => r.bottom)),
      px0: p.left, py0: p.top, px1: p.right, py1: p.bottom,
    };
  }, ids);
  let m = await measure();
  if (m.n !== ids.length) throw new Error(`на холсте ${m.n} из ${ids.length} целевых узлов`);
  for (let i = 0; i < 12; i++) {
    const cur = Number(RF_TRANSFORM.exec(m.v)[3]);
    if (Math.abs(cur / k - 1) < 0.004) break;
    await page.mouse.move((m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2);
    await page.mouse.wheel(0, -500 * Math.log2(k / cur));
    await page.waitForTimeout(350);
    m = await measure();
  }
  for (let i = 0; i < 6; i++) {
    const dx = (m.px0 + m.px1) / 2 - (m.x0 + m.x1) / 2;
    const dy = (m.py0 + m.py1) / 2 - (m.y0 + m.y1) / 2;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
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
    await page.waitForTimeout(300);
    m = await measure();
  }
  await settle(page, 300);
  return Number(RF_TRANSFORM.exec((await measure()).v)[3]);
}

// ── Режиссура: курсор, щелчки, паузы ─────────────────────────────────────────
// Текущая позиция курсора — своя, Playwright её не отдаёт.
const pos = { x: 0, y: 0 };
const TRACE = args.includes("--trace");
// Все тайминги — по монотонным часам. Настенные в WSL2 шагают при синхронизации с
// хостом (откат на 1–2 с): по ним окно записи съезжало, а шаги анимации шли назад.
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Отметки хронометража дубля: секунды от начала записанного отрезка
let take = null;
const mark = (label) => { if (take) take.marks.push({ t: (now() - take.t0) / 1000, label }); };

// Профиль скорости перелёта: минимальный рывок 10t³ − 15t⁴ + 6t⁵ на чуть сжатом начале
// (t^0,85): старт быстрее, посадка мягче, перелёта цели нет.
const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
const travel = (t) => minJerk(t ** 0.85);
const TICK = 1000 / 60;
// Длительность перелёта от расстояния d (px окна): 200 + 26·√d мс в пределах 320–900 —
// соседние кнопки переключателя за 0,35–0,45 с, через пол-экрана за 0,7–0,85 с.
const flightMs = (d) => Math.max(320, Math.min(900, 200 + 26 * Math.sqrt(d)));
// Перелёт в точку: слабая дуга (квадратичная Безье, прогиб 6 % длины; знак прогиба —
// по направлению: вправо дуга выгибается вверх, влево — вниз, как у кисти), короче 80 px —
// по прямой. Стрелку ведёт страница (__lpFly, точки дуги на каждый кадр 60 Гц), а
// настоящая мышь идёт следом раз в 33 мс: ховеры по пути настоящие. Посадка — настоящим
// mouse.move в цель, после него стрелка снова слушает мышь.
async function glide(page, x, y) {
  const from = { ...pos };
  const dx = x - from.x, dy = y - from.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.5) return;
  const bend = d < 80 ? 0 : 0.06 * d;
  const cx = (from.x + x) / 2 + (dy / d) * bend, cy = (from.y + y) / 2 - (dx / d) * bend;
  const along = (k) => {
    const s = travel(k), u = 1 - s;
    return [u * u * from.x + 2 * u * s * cx + s * s * x, u * u * from.y + 2 * u * s * cy + s * s * y];
  };
  const ms = Math.round(flightMs(d));
  const n = Math.max(2, Math.ceil(ms / TICK));
  const pts = Array.from({ length: n + 1 }, (_, i) => along(i / n).map((v) => Math.round(v * 100) / 100));
  const t0 = now();
  let landed = false;
  const flight = page.evaluate(([p, t]) => window.__lpFly(p, t), [pts, ms]).finally(() => { landed = true; });
  while (!landed) {
    const k = Math.min(1, (now() - t0) / ms);
    if (k >= 1) break;
    await page.mouse.move(...along(k));
    await sleep(33);
  }
  await flight;
  await page.mouse.move(x, y);
  await page.evaluate(() => window.__lpLand());
  pos.x = x; pos.y = y;
}
// Курсор ставится в точку без движения (подготовка дубля, вне кадра)
async function place(page, p) {
  pos.x = p.x; pos.y = p.y;
  await page.mouse.move(p.x, p.y);
}
const hold = (ms) => sleep(ms);
// Перед щелчком курсор стоит 120 мс; нажатие и отпускание разнесены на 80 мс, чтобы
// интерфейс успел показать нажатое состояние.
const AIM_MS = 120, PRESS_MS = 80;
async function clickAt(page, p, label) {
  await glide(page, p.x, p.y);
  await hold(AIM_MS);
  await page.mouse.down();
  mark(label);
  await hold(PRESS_MS);
  await page.mouse.up();
}
// Щелчок-стык: дубль кончается кадром нажатия — отметка cut ставится до отпускания, пока
// экран прежний; переход продукта (загрузка, пустой холст) остаётся за стыком.
async function cutAt(page, p, label, { double = false } = {}) {
  await glide(page, p.x, p.y);
  await hold(AIM_MS);
  if (double) {
    await page.mouse.down({ clickCount: 1 });
    mark(label);
    await hold(PRESS_MS);
    await page.mouse.up({ clickCount: 1 });
    await hold(90);
    await page.mouse.down({ clickCount: 2 });
  } else {
    await page.mouse.down();
    mark(label);
  }
  await hold(PRESS_MS);
  take.cut = now();
  take.point = { ...p };
  await page.mouse.up(double ? { clickCount: 2 } : undefined);
}
// Плавная прокрутка области страницы: одна на сцену, не дольше 1,1 с, по кривой минимального
// рывка. Шаги делает страница в requestAnimationFrame, по шагу на кадр: колесо из Node
// (mouse.wheel по таймеру) ложилось в сетку кадров неровно и давало кадры-дубли посреди
// прокрутки. Курсор при этом стоит в поле страницы, как при прокрутке колесом.
async function scrollSmooth(scroller, dy, ms) {
  await scroller.evaluate((el, [dy, ms]) => new Promise((done) => {
    const y0 = el.scrollTop;
    let t0 = null;
    const step = (t) => {
      if (t0 === null) t0 = t;
      const k = Math.min(1, (t - t0) / ms);
      el.scrollTop = y0 + dy * k * k * k * (10 - 15 * k + 6 * k * k);
      if (k < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  }), [dy, ms]);
}
// Готовность без «мёртвой» паузы: конвейер раскладки не в полёте, индикатор занятости снят.
async function ready(page, timeout = 8000) {
  const t = now();
  while (now() - t < timeout) {
    const busy = await page.evaluate(() => (window.__archmapLayoutInflight ?? 0) + document.querySelectorAll(".lg-busy").length);
    if (!busy) return;
    await page.waitForTimeout(50);
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
    await locator.page().waitForTimeout(50);
  }
}
// Вьюпорт холста ушёл от прежнего и замер на 250 мс: доиграло вписывание продукта после
// раскрытия (оно стартует по оседании раскладки, а не сразу). Без сдвига — по таймауту.
async function viewportSettled(canvas, before, timeout = 4000) {
  const t = now();
  let prev = before, since = now(), moved = false;
  while (now() - t < timeout) {
    const v = await canvas.evaluate((c) => c.querySelector(".react-flow__viewport").style.transform);
    if (v !== prev) { prev = v; since = now(); moved = true; } else if (moved && now() - since >= 250) return true;
    await sleep(40);
  }
  return false;
}

// ── Дубли ────────────────────────────────────────────────────────────────────
// setup(page, s) — подготовка в свежем контексте (в ролик не входит): экран в состоянии, в
// котором его оставил щелчок предыдущего дубля; в конце курсор ставится в точку этого
// щелчка (prev — она же). run(page, s, state) — записанный отрезок; если он кончается
// щелчком-стыком (cutAt), отрезок обрывается кадром нажатия. Паузы hold — время прочитать
// появившееся (0,8–2,0 с), считаются от готовности результата, а не от щелчка.
const P = {}; // точки щелчков-стыков: дубль-наследник начинает из них
const treeRow = (page, name) => page.locator(".nt-row").filter({ has: page.locator(".nt-name", { hasText: new RegExp(`^${name}$`) }) }).first();
const HERO_TAKES = [
  // «Архитектура». Страница системы «Заказы», раздел «Схема» у верха области страницы, схема
  // включена (щелчок активации — в подготовке), подписи связей скрыты тумблером холста
  // (настройка вида в браузере, в БД не пишет): на масштабе ролика они мельче 8 px и только
  // шумят. Курсор с первого кадра на «Заказах» в дереве (там же щёлкает конец петли).
  // ⚠ Копия подготовлена через интерфейс: на схеме страницы «Заказов» узлы расставлены
  // плотно (API Gateway, «Сервис оплаты», Kafka рядом сверху; Order API, «БД заказов»,
  // «Оркестратор заказа» рядом внутри рамки; «Служба доставки» справа снаружи; свёрнутые
  // «Заказы» — в середине будущей рамки), раскрытие «Заказов» сохранено в виде. Продукт после
  // раскрытия сам вписывает всю схему в окно (fitView, padding 0,1): при прежней, широкой
  // расстановке масштаб был 0,43, при плотной — 0,80. Схемы страниц стартуют свёрнутыми, и
  // щелчок лупой по сохранённому раскрытию гасится дедупом, в БД не пишет.
  { scene: "Архитектура", async setup(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orders}`);
    const sec = section(page, "Схема");
    await scrollToTop(page, sec, 75);
    await sec.locator(".esb-activate").click(); // схема страницы инертна до щелчка
    const labels = sec.getByRole("button", { name: "Подписи связей" });
    if ((await labels.getAttribute("aria-pressed")) !== "true") await labels.click();
    await settle(page, 400);
    P.loop = await textPoint(treeRow(page, N.orders).locator(".nt-name"));
    await place(page, P.loop);
    await page.waitForTimeout(400);
    return { sec };
  }, async run(page, s, { sec }) {
    await hold(800);                                           // осмотр: «Заказы» среди соседей (и растворение петли перед ним)
    const node = sec.locator(`.react-flow__node[data-id="${s.ids.orders}"]`);
    const canvas = sec.locator(".react-flow").first();
    const v0 = await canvas.evaluate((c) => c.querySelector(".react-flow__viewport").style.transform);
    await clickAt(page, await boxCenter(node.locator('button[title="Раскрыть содержимое"]')), "лупа «Заказов»");
    // Раскрытие на месте (анимация продукта), затем продукт вписывает схему: курсор стоит
    const oa = sec.locator(`.react-flow__node[data-id="${s.ids.orderApi}"]`);
    await oa.waitFor();
    mark("рамка раскрывается");
    if (!(await viewportSettled(canvas, v0))) warnings.push("hero: вписывание после раскрытия не замечено");
    await ready(page);
    mark("раскрыто и вписано");
    await hold(1000);                                          // внутри рамки три объекта, стрелки соседей вошли в рамку (плюс 0,25 с оседания)
    // Схема страницы только для чтения: двойной щелчок по блоку — переход на его страницу
    await cutAt(page, await boxCenter(oa), "двойной щелчок по Order API", { double: true });
    P.oa = take.point;
  } },

  // «Логика». Страница Order API сверху: название, описание, свойства. Одна прокрутка
  // колесом до раздела «Логика»; курсор перед ней уходит в левое поле страницы: под ним не
  // проплывает схема страницы (на инертной схеме под курсором всплывает подсказка).
  // ⚠ Окно схемы логики в подготовке открывается и закрывается один раз: первое открытие в
  // свежем контексте грузит модуль mermaid. Но и после этого окно появляется через 0,6 с
  // после щелчка (mermaid раскладывает блок-схему): щелчок по строке — стык, окно входит
  // растворением уже готовым (дубль «Логика, окно»).
  { scene: "Логика", async setup(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orderApi}`);
    await page.getByText("github.com/yarmarka/orders / services/order-api").first().waitFor();
    await page.locator(`button[title="Открыть схему «${DOC_LOGIC}»"]`).click();
    await page.locator("dialog[open] svg[aria-roledescription]").first().waitFor();
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "detached" });
    await page.evaluate(() => { document.activeElement?.blur(); document.querySelector(".np-page").scrollTop = 0; });
    await settle(page, 300);
    await place(page, P.oa);
    await page.waitForTimeout(400);
  }, async run(page) {
    await hold(1150);                                          // название, описание, свойства (с растворением)
    const sc = page.locator(".np-page");
    const col = await page.locator(".np-header").boundingBox();
    const gutter = { x: Math.round(col.x - 24), y: pos.y };
    await glide(page, gutter.x, gutter.y);
    const row = page.locator(`button[title="Открыть схему «${DOC_LOGIC}»"]`);
    // Строка «Создание заказа» — в верхнюю половину окна (около 330 px от верха)
    P.scroll = await row.evaluate((el, off) => {
      const s = el.closest(".np-page");
      return Math.max(0, Math.min(el.getBoundingClientRect().top - off, s.scrollHeight - s.clientHeight - s.scrollTop));
    }, 312);
    await hold(60);
    mark(`прокрутка ${Math.round(P.scroll)} px`);
    await scrollSmooth(sc, P.scroll, 1000);
    await hold(150);
    await cutAt(page, await textPoint(row), "строка «Создание заказа»");
    P.row = take.point;
  } },

  // «Логика», окно схемы «Создание заказа» поверх той же страницы, прокрученной так же
  // (P.scroll): блок-схема крупно, в шапке «Order API · Создание заказа · POST /orders», в
  // подвале «В процессах: Оформление заказа». Курсор стоит там, где щёлкнул по строке
  // (левее схемы), и идёт к ссылке.
  { scene: "Логика", async setup(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orderApi}`);
    await page.getByText("github.com/yarmarka/orders / services/order-api").first().waitFor();
    await page.evaluate((y) => { document.querySelector(".np-page").scrollTop = y; }, P.scroll);
    await page.waitForTimeout(300);
    await page.locator(`button[title="Открыть схему «${DOC_LOGIC}»"]`).click();
    await stableBox(page.locator("dialog[open] svg[aria-roledescription]").first());
    await settle(page, 300);
    await place(page, P.row);
    await page.waitForTimeout(400);
  }, async run(page) {
    mark("окно схемы логики");
    await hold(1000 * CROSS / 2 + 1500);                       // блок-схема, шапка окна (с половиной растворения)
    await cutAt(page, await textPoint(page.locator("dialog[open] .doc-proclink").first()), "ссылка «Оформление заказа»");
    P.link = take.point;
  } },

  // «Процессы». Экран процесса «Оформление заказа» в чтении, как его открывает ссылка из
  // окна схемы логики (подготовка повторяет те же щелчки): участники сверху, шаги.
  { scene: "Процессы", async setup(page, s) {
    await go(page, `/p/${s.pid}/nodes/${s.ids.orderApi}`);
    await page.locator(`button[title="Открыть схему «${DOC_LOGIC}»"]`).click();
    await page.locator("dialog[open] svg[aria-roledescription]").first().waitFor();
    await settle(page, 300);
    await page.locator("dialog[open] .doc-proclink").first().click();
    await page.locator(".seq-label").filter({ hasText: s.stepCaption }).first().waitFor();
    await settle(page, 400);
    await place(page, P.link);
    await page.waitForTimeout(400);
  }, async run(page, s) {
    await hold(950);                                           // участники и шаги (с растворением)
    const step = page.locator(".seq-label").filter({ hasText: s.stepCaption }).first();
    await clickAt(page, await textPoint(step.locator(".seq-text")), `шаг «${s.stepCaption}»`);
    await stableBox(page.getByText("Откуда", { exact: true }).first());
    mark("панель шага");
    await hold(1300);                                          // откуда, куда, тип, схема логики (плюс оседание панели)
    await cutAt(page, await textPoint(page.getByRole("button", { name: "Развёртывание", exact: true }).first()), "вкладка «Развёртывание»");
    P.tab = take.point;
  } },

  // «Развёртывание», весь проект: вся платформа по площадкам (впечатление масштаба). Корень
  // дерева раскрыт: в настоящей сессии это один щелчок по шеврону, он остаётся за стыком.
  // ⚠ Уровень «Весь проект» на копии открыт заранее (первый показ уровня пишет раскладку).
  { scene: "Развёртывание", async setup(page, s) {
    await go(page, `/p/${s.pid}/deploy`);
    const chev = page.locator(".nt-chevzone").first();
    if ((await chev.getAttribute("aria-expanded")) !== "true") await chev.click();
    await treeRow(page, N.orders).waitFor();
    await settle(page, 400);
    await place(page, P.tab);
    await page.waitForTimeout(400);
  }, async run(page) {
    await hold(950);                                           // вся платформа по площадкам (с растворением)
    const p = await textPoint(treeRow(page, N.orders).locator(".nt-name"));
    if (P.loop && Math.hypot(p.x - P.loop.x, p.y - P.loop.y) > 2) warnings.push(`hero: «Заказы» в дереве «Развёртывания» (${p.x},${p.y}) не там, где в дереве объектов (${P.loop.x},${P.loop.y}): курсор на шве петли прыгнет`);
    await cutAt(page, p, "«Заказы» в дереве");
    P.tree = take.point;
  } },

  // «Развёртывание», уровень «Заказы»: «Облако» с «Кластером prod» (Оркестратор заказа,
  // Order API 1/2), Managed PostgreSQL («БД заказов») и «Кластером резерв» (Order API 2/2);
  // пустые площадки справа. Курсор стоит на «Заказах» в дереве; конец — растворение в первый
  // кадр ролика (последняя пауза покрывает и чтение, и растворение LOOP).
  // ⚠ Уровень на копии открыт заранее, карточки расставлены перетаскиванием: «Кластер prod»
  // слева (Оркестратор над Order API 1/2), в середине Managed PostgreSQL над «Кластером
  // резерв», справа столбцом «ВМ поиска» и «ВМ брокера», под «Облаком» справа «Серверная офиса».
  { scene: "Развёртывание", async setup(page, s) {
    await go(page, `/p/${s.pid}/deploy`);
    const chev = page.locator(".nt-chevzone").first();
    if ((await chev.getAttribute("aria-expanded")) !== "true") await chev.click();
    await treeRow(page, N.orders).click();
    await page.getByText("Кластер prod", { exact: false }).first().waitFor();
    await settle(page, 400);
    await place(page, P.tree);
    await page.waitForTimeout(400);
  }, async run() {
    mark("уровень «Заказы»");
    await hold(1000 * CROSS / 2 + 1800 + 1000 * LOOP);       // чтение (с половиной растворения стыка) и растворение петли
  } },
];

// Статусы — на моке «Уведомления заказов»: корень карты, дерево свёрнуто, четыре объекта в
// кадре в масштабе 1 (расстановка ручная, сохранена в виде корня мока: ромб «Заказы» →
// «Центр уведомлений» / «SMS-рассыльщик» → «SMS-провайдер»). Окно 1260×540 (21:9, как рамка
// раздела). Бесшовная петля действием: курсор с первого кадра стоит на «Как есть» (нынешний
// путь через SMS-рассыльщик), «Переход» (проектируемый «Центр уведомлений», рассыльщик
// выводится — самый богатый кадр), «Как будет», и обратно на «Как есть»: последний кадр
// совпадает с первым (та же точка курсора, тот же вид, круг щелчка погас). Смена вида в
// продукте мгновенная, ритм задают паузы.
const viewTab = (page, name) => page.getByRole("radio", { name, exact: true }).first();
const STATUS_TAKES = [
  { async setup(page, s) {
    await go(page, `/p/${s.pid}/map`);
    await page.getByRole("button", { name: "Свернуть панель" }).first().click();
    await settle(page, 300);
    await viewTab(page, "Как есть").click();
    await settle(page, 300);
    const k = await frameNodes(page, s.frame, 1);
    console.log(`  масштаб холста ${k.toFixed(2)}`);
    await place(page, await textPoint(viewTab(page, "Как есть")));
    await page.waitForTimeout(500);
  }, async run(page) {
    await hold(1500);                                          // как есть: путь через SMS-рассыльщик
    await clickAt(page, await textPoint(viewTab(page, "Переход")), "Переход");
    await hold(2300);                                          // центр уведомлений проектируется, рассыльщик выводится
    await clickAt(page, await textPoint(viewTab(page, "Как будет")), "Как будет");
    await hold(1900);
    await clickAt(page, await textPoint(viewTab(page, "Как есть")), "Как есть");
    await hold(420);                                           // круг щелчка погас: кадр как первый
  } },
];

// CROSS — растворение на стыке дублей, LOOP — растворение конца hero в первый кадр (с).
const CROSS = 0.3;
const LOOP = 0.5;
const VIDEOS = {
  hero: { size: [1280, 800], takes: HERO_TAKES, loop: LOOP },
  status: { size: [1260, 540], takes: STATUS_TAKES, loop: 0 },
};

// ── Захват: x11 ──────────────────────────────────────────────────────────────
// Виртуальный экран один на прогон. Окно Playwright подгоняет под вьюпорт сам (плюс
// полоса вкладок и адреса сверху), а ffmpeg пишет только прямоугольник вьюпорта —
// его находит калибровка по маркерам.
let xvfb = null;
async function startXvfb(w, h) {
  if (displayAlive()) { console.log(`Xvfb: беру уже запущенный ${DISPLAY}`); return; }
  xvfb = spawn(XVFB, [DISPLAY, "-screen", "0", `${w}x${h}x24`, "-nolisten", "tcp", "-noreset"], { stdio: "ignore" });
  process.on("exit", () => xvfb?.kill("SIGTERM"));
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (displayAlive()) return;
  }
  throw new Error(`Xvfb на ${DISPLAY} не поднялся за 5 с`);
}
function stopXvfb() { xvfb?.kill("SIGTERM"); xvfb = null; }

// Калибровка: в углах вьюпорта — магентовые квадраты, кадр экрана одним снимком
// x11grab, по квадратам — точный прямоугольник страницы, независимо от высоты хрома.
async function calibrate(page, screen, [vw, vh]) {
  // Playwright подгоняет окно под вьюпорт, но полосу вкладок и адреса считает на 2 px
  // ниже настоящей — нижние ряды страницы обрезались. Окно — с запасом: вьюпорт
  // эмулирован, раскладка страницы от этого не меняется.
  const cdp = await page.context().newCDPSession(page);
  const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: bounds.width + Math.round(32 * SCALE), height: bounds.height + Math.round(32 * SCALE) } });
  await cdp.detach();
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    // маркеры — в top-layer (popover): окно <dialog>, открытое в подготовке, их не закрывает
    const mk = (x, y) => {
      const d = document.createElement("div");
      d.className = "lp-cal";
      d.setAttribute("popover", "manual");
      d.style.cssText = `position:fixed;inset:auto;${x}:0;${y}:0;margin:0;padding:0;border:0;width:8px;height:8px;background:#ff00ff;pointer-events:none`;
      document.body.appendChild(d);
      d.showPopover();
    };
    mk("left", "top"); mk("right", "bottom");
  });
  await page.waitForTimeout(250);
  const [W, H] = screen;
  const r = spawnSync(FFMPEG, ["-loglevel", "error", "-f", "x11grab", "-video_size", `${W}x${H}`, "-i", DISPLAY,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: W * H * 3 + 4096 });
  await page.evaluate(() => document.querySelectorAll(".lp-cal").forEach((d) => d.remove()));
  await page.waitForTimeout(100);
  if (r.status !== 0 || r.stdout.length < W * H * 3) throw new Error("калибровка: x11grab не снял экран");
  const buf = r.stdout;
  const isM = (x, y) => { const i = (y * W + x) * 3; return buf[i] > 200 && buf[i + 1] < 60 && buf[i + 2] > 200; };
  let x0 = -1, y0 = -1, x1 = -1, y1 = -1;
  top: for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isM(x, y)) { x0 = x; y0 = y; break top; }
  bottom: for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) if (isM(x, y)) { x1 = x; y1 = y; break bottom; }
  if (x0 < 0 || x1 < 0) throw new Error("калибровка: маркеры вьюпорта не найдены (окно не влезло в экран?)");
  // При дробном масштабе край маркера гуляет на пиксель — берём ожидаемый размер
  const want = { w: Math.round(vw * SCALE), h: Math.round(vh * SCALE) };
  const found = { w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const ok = Math.abs(found.w - want.w) <= 2 && Math.abs(found.h - want.h) <= 2;
  const rect = { x: x0, y: y0, ...(ok ? want : found) };
  if (!ok) warnings.push(`калибровка: вьюпорт ${found.w}×${found.h}, ожидался ${want.w}×${want.h}`);
  return rect;
}

// Запись экрана: сырой поток без потерь (x264rgb qp 0, ultrafast, zerolatency — кадр
// уходит в файл сразу, без очереди кодера); сжатие — отдельным проходом.
// x11grab ставит кадрам метки по НАСТЕННЫМ часам и по ним же ждёт следующий кадр.
// Поэтому: -copyts сохраняет в mkv абсолютное время первого кадра, и окно дубля
// выставляется по настенным меткам. А шаг часов WSL2 посреди записи ломает и метки, и
// расписание захвата — его ловит сдвиг «настенные минус монотонные» между началом и
// концом записи, и такой дубль переснимается.
function startGrab(rect, raw) {
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-stats_period", "0.05",
    "-f", "x11grab", "-framerate", String(FPS), "-draw_mouse", "0",
    "-video_size", `${rect.w}x${rect.h}`, "-i", `${DISPLAY}+${rect.x},${rect.y}`,
    "-copyts", "-c:v", "libx264rgb", "-preset", "ultrafast", "-tune", "zerolatency", "-qp", "0", raw], { stdio: ["pipe", "pipe", "pipe"] });
  const g = { frames: 0, err: "", wall0: 0, wall1: 0 };
  ff.stdout.on("data", (chunk) => {
    const m = /frame=(\d+)/.exec(chunk.toString());
    if (m) g.frames = Number(m[1]);
  });
  ff.stderr.on("data", (c) => { g.err += c; });
  const wallShift = () => Date.now() - now();
  g.started = async () => {
    for (let i = 0; i < 100 && g.frames === 0 && ff.exitCode === null; i++) await sleep(20);
    if (g.frames === 0) throw new Error(`x11grab не пишет: ${g.err.trim().split("\n").pop() || "нет кадров"}`);
    g.wall0 = wallShift();
  };
  g.stop = () => new Promise((res) => {
    ff.on("close", () => { g.wall1 = wallShift(); res(); });
    ff.stdin.write("q"); ff.stdin.end();
  });
  return g;
}
// Настенное время первого кадра сырого mkv, мс (поле start: у -copyts-файла)
function rawStartMs(raw) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", raw]);
  const m = /start: (\d+(?:\.\d+)?)/.exec(r.stderr?.toString() ?? "");
  if (!m) throw new Error("у сырого захвата нет метки начала");
  return Number(m[1]) * 1000;
}
// Плавность захвата в окне дубля: сколько кадров реально пришло и самый длинный
// промежуток (метки пакетов сырого mkv, без декодирования).
function grabStats(raw, start, end) {
  const r = spawnSync(FFMPEG, ["-loglevel", "error", "-i", raw, "-map", "0:v", "-c", "copy", "-f", "framecrc", "-"], { maxBuffer: 64 << 20 });
  const out = r.stdout?.toString() ?? "";
  const tb = /#tb 0: (\d+)\/(\d+)/.exec(out);
  const k = tb ? Number(tb[1]) / Number(tb[2]) : 0.001;
  const pts = out.split("\n").filter((l) => /^0,/.test(l)).map((l) => Number(l.split(",")[2]) * k);
  const t0 = pts[0] ?? 0;
  const win = pts.map((t) => t - t0).filter((t) => t >= start && t <= end);
  const gaps = win.slice(1).map((t, i) => t - win[i]);
  return { fps: win.length / Math.max(0.001, end - start), maxGap: gaps.length ? Math.max(...gaps) : 0 };
}

// ── Захват: cdp ──────────────────────────────────────────────────────────────
// Скринкаст CDP: кадры JPEG ложатся на диск как есть. Время кадра — момент прибытия по
// монотонным часам: метка metadata.timestamp у Chromium настенная.
async function startScreencast(page, dir) {
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
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: vp.width * CAP_DSF, maxHeight: vp.height * CAP_DSF });
  // Первый кадр Chromium присылает сразу — с него начинается дубль
  while (!frames.length) await page.waitForTimeout(20);
  return { frames, stop: () => cdp.send("Page.stopScreencast").catch(() => {}) };
}

// ── Сборка ───────────────────────────────────────────────────────────────────
const ff = (argv, what) => {
  const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", ...argv], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg (${what}): ${(r.stderr?.toString().trim().split("\n").pop()) || `код ${r.status ?? r.signal}`}`);
};
// Клип дубля без потерь (RGB, x264rgb qp 0), кадр — размер файла [w, h]. Возвращает число
// кадров клипа. x11: n кадров сырого захвата от start ПО ПОРЯДКУ (x11grab снимает ровно на
// 60 к/с, а пересчёт по его меткам времени, у которых шаг 16 или 17 мс, сам рождал повторы
// и пропуски), без кадров-повторов внутри движения (job.drops, см. smoothness). cdp: кадр
// держится до следующего (concat с duration), первым идёт кадр, что был на экране в момент t0.
function takeClip(job, file, [w, h]) {
  const n = Math.max(1, Math.round((job.end - job.start) * FPS));
  const enc = ["-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", file];
  if (job.kind === "x11") {
    const drops = job.drops ?? [];
    const pick = drops.length ? `,select='not(${drops.map((k) => `eq(n,${k})`).join("+")})',setpts=N` : "";
    ff(["-ss", job.start.toFixed(3), "-i", job.raw, "-vf", `${SEQ},trim=end_frame=${n}${pick},scale=${w}:${h}:flags=lanczos,format=gbrp`, ...enc], "клип дубля");
    return n - drops.length;
  }
  let i0 = 0;
  job.frames.forEach((f, i) => { if (f.t <= job.start) i0 = i; });
  const seq = job.frames.slice(i0).filter((f, k) => k === 0 || f.t < job.end);
  const lines = ["ffconcat version 1.0"];
  seq.forEach((f, k) => {
    const to = k + 1 < seq.length ? seq[k + 1].t : job.end + 1;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, to - Math.max(f.t, job.start)).toFixed(4)}`);
  });
  lines.push(`file '${seq[seq.length - 1].file}'`); // без повтора concat теряет длительность последнего
  const list = join(job.dir, "frames.ffconcat");
  writeFileSync(list, lines.join("\n") + "\n");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=${FPS},scale=${w}:${h}:flags=lanczos,format=gbrp`, "-frames:v", String(n), ...enc], "клип дубля");
  return n;
}
// Мастер ролика без потерь: клипы дублей встык через растворение CROSS на кадре-стыке
// (кадр нажатия держится CROSS секунд и растворяется в первый кадр следующего дубля), у
// hero ещё растворение конца в первый кадр ролика (последний кадр файла = первому).
// Растворение начинается на последнем настоящем кадре клипа (его вес там ещё 1), а не на
// первой копии: иначе на стыке стоял лишний кадр-повтор. Возвращает мастер и время начала
// каждого клипа в готовом файле.
function assemble(name, clips, loop) {
  const inputs = clips.flatMap((c) => ["-i", c.file]);
  const d = (n) => (n / FPS).toFixed(6);
  // входы — к одной сетке кадров и базе времени: xfade требует одинаковых
  const parts = clips.map((c, i) => `[${i}:v]fps=${FPS},settb=AVTB,format=gbrp[v${i}]`);
  const starts = [0];
  let acc = clips[0].n, cur = "[v0]";
  for (let i = 1; i < clips.length; i++) {
    parts.push(`${cur}tpad=stop_mode=clone:stop_duration=${CROSS}[p${i}]`);
    parts.push(`[p${i}][v${i}]xfade=transition=fade:duration=${CROSS}:offset=${d(acc - 1)}[x${i}]`);
    starts.push((acc - 1) / FPS);
    acc += clips[i].n - 1;
    cur = `[x${i}]`;
  }
  if (loop) {
    // первый кадр ролика — отдельным входом, растянут на растворение плюс кадр
    inputs.push("-i", clips[0].file);
    const k = clips.length;
    parts.push(`[${k}:v]fps=${FPS},settb=AVTB,format=gbrp,trim=end_frame=1,tpad=stop_mode=clone:stop_duration=${loop + 1 / FPS}[still]`);
    parts.push(`${cur}[still]xfade=transition=fade:duration=${loop}:offset=${d(acc - Math.round(loop * FPS))}[xl]`);
    cur = "[xl]";
    acc += 1;
  }
  parts.push(`${cur}format=gbrp[out]`);
  const master = join(TMP, `master-${name}-${process.pid}.mkv`);
  ff([...inputs, "-filter_complex", parts.join(";"), "-map", "[out]", "-r", String(FPS), "-frames:v", String(acc),
    "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", master], "сборка");
  return { master, starts, frames: acc };
}
// Готовые файлы из мастера: цвет — в BT.709 ТВ-диапазона с явной разметкой (без неё
// браузеры гадают о матрице, и синий уезжает); ключевой кадр один, в начале: петлю не
// перематывают, а каждый лишний ключевой кадр схемы — около 100 КБ. VP9 — в два прохода:
// опорные alt-ref кадры libvpx строит только во втором. Постер — первый кадр (JPEG).
// Петля растворением (hero): три последних кадра H.264 — с постоянным квантователем 16.
// Первый кадр — ключевой и выходит чище соседей, а последний, P-кадр после растворения, на
// crf 20 отличался от него на 38 дБ (шов петли мигал); 45 дБ стоят около 70 КБ.
function encode(name, master, frames, loop) {
  const vf = "scale=out_color_matrix=bt709:out_range=tv:flags=lanczos,setsar=1,format=yuv420p";
  const common = ["-i", master, "-an", "-vf", vf,
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-g", "9999"];
  const base = join(OUT, `vid-${name}`);
  const passlog = join(TMP, `vp9-${name}`);
  const vp9 = [...common, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(CRF_WEBM), "-deadline", "good",
    "-row-mt", "1", "-threads", "4", "-passlogfile", passlog];
  try {
    const zones = loop ? ["-x264-params", `zones=${frames - 3},${frames - 1},q=16`] : [];
    ff([...common, "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", String(CRF_MP4), ...zones, "-threads", "4",
      "-movflags", "+faststart", `${base}.mp4`], "mp4");
    ff([...vp9, "-cpu-used", "4", "-pass", "1", "-f", "null", "-"], "webm, проход 1");
    ff([...vp9, "-cpu-used", "2", "-pass", "2", `${base}.webm`], "webm, проход 2");
  } finally {
    rmSync(`${passlog}-0.log`, { force: true });
  }
  ff(["-i", master, "-frames:v", "1", "-q:v", "3", `${base}-poster.jpg`], "постер");
  // Браузеры играют только 4:2:0: H.264 High 4:4:4 и VP9 profile 1 у них не идут
  for (const ext of ["mp4", "webm"]) {
    const info = spawnSync(FFMPEG, ["-hide_banner", "-i", `${base}.${ext}`]).stderr?.toString() ?? "";
    if (!/Video: .*yuv420p\(tv/.test(info)) throw new Error(`vid-${name}.${ext}: кадр не yuv420p, браузеры его не сыграют`);
  }
  return { files: [`vid-${name}.mp4`, `vid-${name}.webm`, `vid-${name}-poster.jpg`], sizes: [statSync(`${base}.mp4`).size, statSync(`${base}.webm`).size] };
}
const mb = (n) => `${(n / 1048576).toFixed(2)} МБ`;

// ── Прогон ───────────────────────────────────────────────────────────────────
const picked = Object.entries(VIDEOS).filter(([name]) => !ONLY || ONLY.includes(name));
if (!picked.length) {
  console.log("✗ снимать нечего: ролики не выбраны");
  process.exit(1);
}
if (CAPTURE === "pw" && picked.some(([, v]) => v.takes.length > 1)) {
  console.log("✗ захват pw (нет ffmpeg): ролик hero собирается из нескольких дублей со стыками, без ffmpeg его не собрать; снимите с ffmpeg (x11 или cdp) или --only status");
  process.exit(1);
}
const pw = await import(PW_MODULE);
const { chromium } = pw.default;
const token = await login();
const scenes = {};
for (const [name] of picked) scenes[name] = await RESOLVE[name](token);
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
// Экран Xvfb: самое большое окно из выбранных роликов плюс полоса вкладок и адреса
const SCREEN = [
  Math.ceil(Math.max(...picked.map(([, v]) => v.size[0])) * SCALE) + 64,
  Math.ceil((Math.max(...picked.map(([, v]) => v.size[1])) + 160) * SCALE),
];
if (CAPTURE === "x11") await startXvfb(...SCREEN);
const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}`, ...(CAPTURE === "x11" ? { DISPLAY, LANGUAGE: "ru" } : {}) },
  headless: CAPTURE !== "x11",
  // x11: окно в углу экрана без первого запуска, инфобаров и полос прокрутки; фоновые
  // окна не притормаживаются. Без --enable-automation нет полосы «браузером управляет ПО».
  // Язык интерфейса — русский, как у страницы: иначе headed-Chromium предлагает перевод,
  // и пузырь «Russian | English» ложится на шапку. Своего --disable-features не
  // передавать: из нескольких Chromium берёт последний и теряет список Playwright.
  // GPU-растр через SwiftShader не включать: программная композиция по умолчанию быстрее.
  args: CAPTURE === "x11" ? [
    "--window-position=0,0", `--window-size=${SCREEN[0]},${SCREEN[1]}`, `--force-device-scale-factor=${SCALE}`,
    "--lang=ru-RU", "--no-first-run", "--disable-infobars", "--hide-scrollbars",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  ] : CAP_DSF !== 1 ? [`--force-device-scale-factor=${CAP_DSF}`] : [],
  ignoreDefaultArgs: CAPTURE === "x11" ? ["--enable-automation"] : [],
});
console.log(`→ ${OUT}  захват: ${CAPTURE}${CAPTURE === "x11" ? ` ${FPS} к/с на ${DISPLAY}` : ""}, масштаб ${SCALE}×`);

// Один дубль: свежий контекст, подготовка, захват, записанный отрезок. Возвращает задание
// на клип, ошибку или причину пересъёмки.
let attemptSeq = 0;
async function record(name, v, i, s) {
  const t = v.takes[i];
  const { ctx, page, videoStart, writes } = await newPage(browser, token, s.pid, v.size, `${name}#${i + 1}`);
  const video = page.video(); // только в режиме pw
  // у каждой попытки свой файл: из пересъёмок берётся лучшая, остальные удаляются
  const seq = ++attemptSeq;
  const dir = join(TMP, `${name}-${i + 1}-${seq}-${process.pid}`);
  const raw = join(TMP, `${name}-${i + 1}-${seq}-${process.pid}.mkv`);
  let cap = null, grab = null, error = null, end = null;
  take = { t0: 0, marks: [], cut: null, point: null };
  try {
    const state = await t.setup(page, s);
    if (CAPTURE === "x11") {
      const rect = await calibrate(page, SCREEN, v.size);
      grab = startGrab(rect, raw);
      await grab.started();
      await page.waitForTimeout(150); // запас: начало окна — не первый кадр файла
    } else if (CAPTURE === "cdp") cap = await startScreencast(page, dir);
    take.t0 = now();
    await t.run(page, s, state ?? {});
    end = take.cut ?? now();
    await page.waitForTimeout(150); // кадр нажатия должен лечь в запись целиком
  } catch (e) {
    error = e.message.split("\n")[0];
  }
  const wrote = writes.length > 0;
  for (const w of writes) blocked.push(w);
  await cap?.stop();
  if (grab) await grab.stop();
  await ctx.close();
  if (!error && wrote) error = "интерфейс пытался писать в БД (запросы оборваны сторожем)";
  const t0 = take.t0, marks = take.marks;
  if (video) {
    const rawPw = await video.path();
    if (!error) {
      const start = (t0 - videoStart) / 1000, stop = (end - videoStart) / 1000;
      const file = `vid-${name}.raw.webm`;
      copyFileSync(rawPw, join(OUT, file));
      results.push({ name, files: [file], dur: stop - start });
      console.log(`  ✓ ${file}  data-start="${start.toFixed(2)}" data-end="${stop.toFixed(2)}"`);
    }
    unlinkSync(rawPw);
    return { error, pwDone: true };
  }
  if (error) {
    rmSync(raw, { force: true }); rmSync(dir, { recursive: true, force: true });
    return { error };
  }
  if (grab) {
    const step = grab.wall1 - grab.wall0;
    if (Math.abs(step) > 40) {
      rmSync(raw, { force: true });
      return { retry: `шаг настенных часов ${step > 0 ? "+" : ""}${Math.round(step)} мс во время записи` };
    }
    const first = rawStartMs(raw);
    const start = (t0 + grab.wall0 - first) / 1000, stop = (end + grab.wall0 - first) / 1000;
    const st = grabStats(raw, start, stop);
    return { job: { kind: "x11", raw, start, end: stop, marks, note: `захват ${st.fps.toFixed(1)} к/с, макс. промежуток ${(st.maxGap * 1000).toFixed(0)} мс` } };
  }
  return { job: { kind: "cdp", frames: cap.frames, dir, start: t0 / 1000, end: end / 1000, marks, note: `кадров ${cap.frames.length}` } };
}

// Плавность дубля по сырому захвату: одиночные кадры-повторы внутри движения (кадр не
// изменился, а по два соседних с каждой стороны меняются), то же правило и та же мера, что
// у проверки роликов: mse соседних кадров (фильтр psnr) на кадре 960 px в серых тонах,
// порог EPS. Повтор рождается на стыке двух часов: Chromium выдаёт кадры по своим, x11grab
// снимает по настенным, и когда снимок приходится на самый край кадра страницы, тот же
// кадр снимается дважды, а следующий теряется; ещё бывает, что страница пропускает кадр,
// пока главный поток занят откликом на щелчок. Одиночный повтор из клипа выбрасывается
// (движение делает шаг на кадр крупнее, не замирая); дубль, где повторов больше
// MAX_STUTTER (в такие отрезки кадры идут на 40 к/с), переснимается.
const SEQ = `settb=1/${FPS},setpts=N`; // кадры захвата по порядку, по кадру на тик FPS
const EPS = 0.01;
const MAX_STUTTER = 4;
function smoothness(job) {
  const stats = join(TMP, `mse-${process.pid}.txt`);
  const n = Math.max(1, Math.round((job.end - job.start) * FPS));
  try {
    ff(["-ss", job.start.toFixed(3), "-i", job.raw, "-filter_complex",
      `[0:v]${SEQ},trim=end_frame=${n},scale=960:-2,format=gray,split[a][b];[b]trim=start_frame=1,setpts=PTS-STARTPTS[b1];[a][b1]psnr=stats_file=${stats}:shortest=1`,
      "-f", "null", "-"], "плавность дубля");
    const dif = [0, ...readFileSync(stats, "utf8").split("\n").filter(Boolean).map((l) => Number(/mse_avg:([\d.]+)/.exec(l)?.[1] ?? 0))];
    const mv = dif.map((x) => x > EPS);
    const drops = [];
    for (let k = 2; k < dif.length - 2; k++) if (!mv[k] && mv[k - 1] && mv[k - 2] && mv[k + 1] && mv[k + 2]) drops.push(k);
    return { stutter: drops.length, drops, moving: mv.filter(Boolean).length };
  } finally {
    rmSync(stats, { force: true });
  }
}
function dropJob(j) {
  if (j.raw) rmSync(j.raw, { force: true });
  if (j.dir) rmSync(j.dir, { recursive: true, force: true });
}

const jobs = []; // записанные ролики: клипы кодируются после закрытия браузера
for (const [name, v] of picked) {
  console.log(`• ${name}`);
  const takes = [];
  let failed = null;
  for (let i = 0; i < v.takes.length && !failed; i++) {
    // Повтор — счётный, не больше пяти попыток на дубль: после шага часов и после дубля с
    // кадрами-повторами в движении (берётся лучший из снятых)
    let best = null, why = null;
    for (let attempt = 1; attempt <= 5 && !failed; attempt++) {
      const r = await record(name, v, i, scenes[name]);
      if (r.pwDone) { failed = r.error ?? "pw"; break; }
      if (r.error) { failed = `дубль ${i + 1}: ${r.error}`; break; }
      if (r.retry) {
        why = r.retry;
        if (attempt < 5) console.log(`  ↻ дубль ${i + 1}: ${r.retry}, переснимаю`);
        continue;
      }
      const sm = r.job.kind === "x11" ? smoothness(r.job) : null;
      if (sm) { r.job.note += `, кадров-повторов в движении ${sm.stutter} из ${sm.moving} (выброшены)`; r.job.drops = sm.drops; }
      r.job.attempt = attempt;
      if (!best || (sm && sm.stutter < best.sm.stutter)) { if (best) dropJob(best.job); best = { job: r.job, sm }; } else dropJob(r.job);
      if (!sm || sm.stutter <= MAX_STUTTER) break;
      if (attempt < 5) console.log(`  ↻ дубль ${i + 1}: кадров-повторов в движении ${sm.stutter}, переснимаю`);
    }
    if (failed) { if (best) dropJob(best.job); break; }
    if (!best) { failed = `дубль ${i + 1}: ${why}`; break; }
    const { job } = best;
    console.log(`  дубль ${i + 1}${v.takes[i].scene ? ` («${v.takes[i].scene}»)` : ""}: ${(job.end - job.start).toFixed(2)} с, ${job.note}${job.attempt > 1 ? `, попытка ${job.attempt}` : ""}`);
    takes.push(job);
  }
  if (failed && failed !== "pw") { results.push({ name, error: failed }); console.log(`  ✗ ${name}: ${failed}`); }
  if (!failed) jobs.push({ name, v, takes });
  else for (const j of takes) dropJob(j);
}
await browser.close();
stopXvfb();

// Кодирование — после закрытия браузера: x264 на большом кадре берёт гигабайты, и рядом
// с живым Chromium его снимал OOM-киллер.
for (const { name, v, takes } of jobs) {
  const size = v.size.map((x) => Math.round(x * SCALE / 2) * 2);
  const tmpFiles = [];
  try {
    const clips = takes.map((j, i) => {
      const file = join(TMP, `clip-${name}-${i + 1}-${process.pid}.mkv`);
      tmpFiles.push(file);
      return { file, n: takeClip(j, file, size), marks: j.marks, drops: j.drops ?? [] };
    });
    const { master, starts, frames } = assemble(name, clips, v.loop);
    tmpFiles.push(master);
    const r = encode(name, master, frames, v.loop);
    const dur = frames / FPS;
    results.push({ name, files: r.files, dur, sizes: r.sizes });
    console.log(`  ✓ ${r.files.join(", ")}  ${dur.toFixed(2)} с, ${mb(r.sizes[0])} / ${mb(r.sizes[1])}, ${size.join("×")}`);
    // Начала сцен в готовом файле (подписи сцен под роликом): сцена начинается растворением
    // в первый кадр её первого дубля (в starts[i] — первый кадр растворения)
    const named = v.takes.map((t, i) => ({ scene: t.scene, at: starts[i] })).filter((x, i, a) => x.scene && (i === 0 || a[i - 1].scene !== x.scene));
    if (named.length) console.log(`  сцены: ${named.map((x) => `${x.scene} ${x.at.toFixed(2)}`).join(" · ")}  data-scenes="${named.map((x) => x.at.toFixed(2)).join(",")}"`);
    if (TRACE) {
      console.log("  хронометраж (с от начала файла):");
      clips.forEach((c, i) => {
        const base = starts[i];
        if (i) console.log(`    ${base.toFixed(2)}  растворение ${CROSS} с в дубль ${i + 1}`);
        // выброшенные кадры-повторы сдвигают всё, что после них, на кадр раньше
        const at = (t) => t - c.drops.filter((k) => k <= t * FPS).length / FPS;
        for (const m of c.marks) console.log(`    ${(base + at(m.t)).toFixed(2)}  ${m.label}`);
      });
      if (v.loop) console.log(`    ${(dur - v.loop - 1 / FPS).toFixed(2)}  растворение ${v.loop} с в первый кадр`);
    }
    if (KEEP_RAW) console.log(`    мастер: ${master}; сырой захват: ${takes.map((j) => j.raw ?? j.dir).join(", ")}`);
  } catch (e) {
    results.push({ name, error: e.message }); console.log(`  ✗ ${name}: ${e.message}`);
  }
  if (!KEEP_RAW) {
    for (const f of tmpFiles) rmSync(f, { force: true });
    for (const j of takes) { if (j.raw) rmSync(j.raw, { force: true }); if (j.dir) rmSync(j.dir, { recursive: true, force: true }); }
  }
}

console.log("\nИтог:");
for (const r of results) console.log(r.error ? `  ✗ ${r.name}: ${r.error}` : `  ${r.files.join(", ")}  ${r.dur.toFixed(2)} с${r.sizes ? `  (${r.sizes.map(mb).join(" / ")})` : ""}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
for (const b of blocked) console.log(`  ⛔ ${b.name}: ${b.method} ${b.path} (оборвано, в БД не дошло)`);
if (blocked.length || results.some((r) => r.error) || !results.length) process.exit(1);
