/// <reference types="node" />
// Node-типы точечно: golden-файл читается и пишется с диска (как в perf-тестах
// реплея) — app-tsconfig остаётся браузерным.
//
// ГЕЙТ «БАЙТ-В-БАЙТ» ФАЗЗ-ПОЛИГОНА (Ф0 эпика «глубокая оптимизация роутера»).
// Гоняет buildAutoRoutes на синтетических сценах по сидам (генератор — routerFuzz.ts)
// и сверяет хэши результатов с golden-файлом. Любая правка класса А, изменившая
// геометрию хоть одного маршрута хоть на одном сиде, роняет этот тест с номером сида.
//
// Режимы (из frontend/):
//   npx vitest run routerFuzz                          — сиды 1..60 (дефолт, гейт коммита)
//   ARCHMAP_FUZZ_FULL=1 npx vitest run routerFuzz      — сиды 1..500 (полный прогон фазы)
//   ARCHMAP_FUZZ_WRITE=1 npx vitest run routerFuzz     — ПЕРЕЗАПИСАТЬ golden (все 500)
//   ARCHMAP_FUZZ_SEED=7 npx vitest run routerFuzz      — дамп ОДНОГО сида в файл (разбор
//                                                        расхождения); ARCHMAP_FUZZ_OUT
//                                                        задаёт путь. Файл — валидный
//                                                        RouteDump для scripts/route-quality.ts
//
// Перезапись golden — ОСОЗНАННОЕ действие: она означает «маршруты изменились и это
// принято». Изменение golden обязано ехать в коммите вместе с правкой роутера и
// объяснением, ПОЧЕМУ геометрия поменялась.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  generateScene, runScene, runSeed, sceneDump, serializeResult, type FuzzScene,
} from "./routerFuzz";

// Путь к golden строим из import.meta.url ПО ЧАСТЯМ: литерал `new URL("./…",
// import.meta.url)` Vite переписывает в ассет-URL (схема http) — fileURLToPath на
// нём падает.
const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "golden", "routerFuzz.json");
const DEFAULT_SEEDS = 60;   // дефолтный гейт: укладывается в бюджет обычного прогона сьюта
const FULL_SEEDS = 500;     // полный полигон: env ARCHMAP_FUZZ_FULL / запись golden

const WRITE = process.env.ARCHMAP_FUZZ_WRITE === "1";
const FULL = process.env.ARCHMAP_FUZZ_FULL === "1";
const SEED = Number(process.env.ARCHMAP_FUZZ_SEED ?? "");
const DUMP_SEED = Number.isFinite(SEED) && SEED > 0;

interface GoldenFile {
  version: number;
  seeds: Record<string, string>;
}

const seedList = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

// Детерминированная сериализация сцены (Set/Map — в отсортированные массивы):
// сравнение двух генераций одного сида ловит любой недетерминизм генератора.
const stableScene = (scene: FuzzScene): string =>
  JSON.stringify(scene, (_key: string, value: unknown): unknown => {
    if (value instanceof Set) return [...value].map(String).sort();
    if (value instanceof Map) {
      return [...value.entries()]
        .map(([k, v]) => [String(k), v] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }
    return value;
  });

describe("фазз-полигон роутера — генератор сцен", () => {
  it("детерминирован и не кладёт тела узлов внахлёст", () => {
    for (const seed of seedList(DEFAULT_SEEDS)) {
      const a = generateScene(seed);
      const b = generateScene(seed);
      expect(stableScene(b), `сцена сида ${seed} не воспроизвелась`).toBe(stableScene(a));
      // наложение тел — НЕЛЕГАЛЬНЫЙ вход роутера (его чинят другие стадии конвейера):
      // полигон обязан подавать корректные сцены, иначе гейт ловит не то
      const bodies = a.displayIds.map((id) => {
        const p = a.positions.get(id);
        const s = a.sizes.get(id);
        return { id, x: p?.x ?? 0, y: p?.y ?? 0, w: s?.w ?? 0, h: s?.h ?? 0 };
      });
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const u = bodies[i], v = bodies[j];
          const hit = u.x < v.x + v.w && v.x < u.x + u.w && u.y < v.y + v.h && v.y < u.y + u.h;
          expect(hit, `сид ${seed}: тела ${u.id} и ${v.id} наложились`).toBe(false);
        }
      }
      // гарантированные паттерны сцены (веер out, веер in, встречная пара)
      const outFan = new Map<string, number>();
      const inFan = new Map<string, number>();
      const dirs = new Set(a.groups.map((g) => `${g.source}->${g.target}`));
      let counter = 0;
      for (const g of a.groups) {
        outFan.set(g.source, (outFan.get(g.source) ?? 0) + 1);
        inFan.set(g.target, (inFan.get(g.target) ?? 0) + 1);
        if (dirs.has(`${g.target}->${g.source}`)) counter++;
      }
      expect(Math.max(...outFan.values()), `сид ${seed}: нет веера out`).toBeGreaterThanOrEqual(3);
      expect(Math.max(...inFan.values()), `сид ${seed}: нет веера in`).toBeGreaterThanOrEqual(3);
      expect(counter, `сид ${seed}: нет встречной пары`).toBeGreaterThanOrEqual(2);
    }
  }, 120_000);
});

describe("фазз-полигон роутера — golden", () => {
  it.runIf(WRITE)(`ПЕРЕЗАПИСЬ golden (${FULL_SEEDS} сидов)`, () => {
    const seeds: Record<string, string> = {};
    for (const seed of seedList(FULL_SEEDS)) seeds[String(seed)] = runSeed(seed);
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    const body: GoldenFile = { version: 1, seeds };
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    expect(Object.keys(seeds)).toHaveLength(FULL_SEEDS);
  }, 1_800_000);

  it.skipIf(WRITE)(`хэши сидов совпадают с golden (${FULL ? FULL_SEEDS : DEFAULT_SEEDS})`, () => {
    expect(
      existsSync(GOLDEN_PATH),
      `golden-файла нет (${GOLDEN_PATH}). Сгенерировать: ` +
      "ARCHMAP_FUZZ_WRITE=1 npx vitest run routerFuzz (из frontend/)",
    ).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
    const bad: string[] = [];
    for (const seed of seedList(FULL ? FULL_SEEDS : DEFAULT_SEEDS)) {
      const want = golden.seeds[String(seed)];
      const got = runSeed(seed);
      if (want === undefined) bad.push(`сид ${seed}: в golden нет записи (перезапиши golden)`);
      else if (want !== got) bad.push(`сид ${seed}: golden ${want}, посчитано ${got}`);
    }
    const report = bad.length === 0 ? "" : [
      `РАСХОЖДЕНИЙ: ${bad.length}`,
      ...bad.slice(0, 10),
      bad.length > 10 ? `…и ещё ${bad.length - 10}` : "",
      "Разобрать один сид (из frontend/):",
      "  ARCHMAP_FUZZ_SEED=<сид> npx vitest run routerFuzz",
      "  → routerFuzz.seed<сид>.json (маршруты обоих проходов; читается",
      "    npx vite-node scripts/route-quality.ts routerFuzz.seed<сид>.json)",
      "Маршруты изменились ОСОЗНАННО? Перезапиши golden:",
      "  ARCHMAP_FUZZ_WRITE=1 npx vitest run routerFuzz",
    ].filter(Boolean).join("\n");
    expect(report, "фазз-полигон разошёлся с golden").toBe("");
  }, 900_000);

  // Разбор расхождения: дамп одного сида на диск. Файл — валидный RouteDump
  // (routes/rects/labels), поэтому его сразу читает scripts/route-quality.ts;
  // рядом лежат хэндлы, хэш и сериализация обоих проходов для глазного диффа.
  it.runIf(DUMP_SEED)(`дамп сида ${SEED}`, () => {
    const scene = generateScene(SEED);
    const { pass1, pass2 } = runScene(scene);
    const out = process.env.ARCHMAP_FUZZ_OUT ?? join(process.cwd(), `routerFuzz.seed${SEED}.json`);
    const dump = sceneDump(scene, pass1);
    writeFileSync(out, `${JSON.stringify({
      seed: SEED,
      hash: runSeed(SEED),
      nodes: scene.displayIds.length,
      edges: scene.groups.length,
      frames: scene.frames.map((f) => f.id),
      ...dump,
      handles: [...pass1.handles.entries()],
      pass2: sceneDump(scene, pass2),
      serialized: { pass1: serializeResult(pass1), pass2: serializeResult(pass2) },
    }, null, 1)}\n`, "utf8");
    console.log(`дамп сида ${SEED} → ${out}`);
    expect(dump.routes.length).toBeGreaterThan(0);
  }, 300_000);
});
