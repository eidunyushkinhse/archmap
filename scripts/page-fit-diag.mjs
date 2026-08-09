// ДИАГНОСТИЧЕСКИЙ ЗОНД (не продукт): FPS анимации раскрытия+центрирования на
// странице объекта («Ярмарка») и число прогонов конвейера. Бисекция: замер
// «как есть» и с выключенной анимацией плашек/поводков (AN28б) — разделяет
// вклад mount-анимаций и дополнительных прогонов (зеркало засева, V22 v2).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const pw = await import(join(homedir(), ".npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.js"));
const { chromium } = pw.default;

const FRONTEND = process.env.ARCHMAP_FRONTEND ?? "http://localhost:5173";
const PROJECT_ID = "0d51a652-bb1d-4a7e-9629-c7f4b06c0ef6";
const NODE_ID = "a07da196-f332-4e70-b00a-17949e1e894b";
const CHROME = join(homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome");
const CHROME_LIBS = join(homedir(), ".cache/archmap-chrome-libs/usr/lib/x86_64-linux-gnu");
const token = readFileSync("/tmp/archmap-diag-token.txt", "utf8").trim();

const browser = await chromium.launch({
  executablePath: CHROME,
  env: { ...process.env, LD_LIBRARY_PATH: `${CHROME_LIBS}:${process.env.LD_LIBRARY_PATH ?? ""}` },
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// FPS-счётчик на rAF внутри страницы
await page.addInitScript(() => {
  window.__fpsOn = false;
  window.__fpsFrames = 0;
  const loop = () => { if (window.__fpsOn) window.__fpsFrames++; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
});

async function openPage() {
  await page.goto(FRONTEND);
  await page.evaluate(([tok, pid]) => {
    localStorage.setItem("access_token", tok);
    localStorage.setItem("archmap.lastProjectId", pid);
  }, [token, PROJECT_ID]);
  await page.goto(`${FRONTEND}/#/p/${PROJECT_ID}/nodes/${NODE_ID}`);
  await page.reload(); // хэш-роутер + auth-стейт читаются на маунте
  await page.waitForSelector(".react-flow", { timeout: 20000 });
  await page.waitForTimeout(3000); // оседание раскладки/замеров
  // блок инертен до клика-активации
  await page.locator(".esb-activate").click().catch(() => {});
  await page.waitForTimeout(500);
}

async function measureExpand(label) {
  const runsBefore = await page.evaluate(() => window.__archmapLayoutRuns ?? 0);
  // кнопка раскрытия фокус-узла (Ярмарка)
  const node = page.locator(".react-flow__node", { hasText: "Ярмарка" }).first();
  await node.hover();
  const btn = node.locator('button[title="Раскрыть содержимое"]');
  await page.evaluate(() => { window.__fpsFrames = 0; window.__fpsOn = true; });
  await btn.click({ force: true });
  await page.waitForTimeout(1800); // раскрытие (420) + фит (420) + запас
  const stat = await page.evaluate(() => {
    window.__fpsOn = false;
    return {
      frames: window.__fpsFrames,
      runs: (window.__archmapLayoutRuns ?? 0),
      sizesVer: window.__archmapSizesVersion ?? 0,
    };
  });
  const fps = (stat.frames / 1.8).toFixed(1);
  console.log(`[${label}] FPS за окно раскрытия: ${fps} (${stat.frames} кадров / 1.8с); прогонов конвейера: ${stat.runs - runsBefore}; sizesVersion: ${stat.sizesVer}`);
}

// Сброс строк вида → следующее раскрытие будет ПЕРВЫМ (засев + зеркало + лишний прогон)
async function relayoutApi() {
  const r = await fetch(`http://localhost:8000/api/v1/nodes/${NODE_ID}/context-relayout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Project-Id": PROJECT_ID, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok && r.status !== 204) throw new Error(`relayout -> ${r.status}`);
}

// Фаза 1: ПЕРВОЕ раскрытие после сброса (засев локалов детей, V22 v2)
await relayoutApi();
await openPage();
await measureExpand("ПЕРВОЕ РАСКРЫТИЕ (засев)");

// Фаза 2: сворачиваем и раскрываем снова в той же сессии (строки уже есть — steady)
await page.locator(".react-flow__node", { hasText: "Ярмарка" }).first().hover();
await page.locator('button[title="Свернуть"]').first().click({ force: true });
await page.waitForTimeout(1500); // оседание сворачивания
await measureExpand("ПОВТОРНОЕ (steady)");

// Фаза 3: ещё раз первое после сброса — подтверждение воспроизводимости
await relayoutApi();
await openPage();
await measureExpand("ПЕРВОЕ РАСКРЫТИЕ (засев, повтор)");

await browser.close();
