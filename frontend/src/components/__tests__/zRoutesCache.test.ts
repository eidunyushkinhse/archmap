/// <reference types="node" />
// Node-типы точечно: golden фазз-полигона читается с диска (как в routerFuzz.golden.test).
//
// САМОПРОВЕРКА КЭШЕЙ Z-РОУТЕРА (эпик render-scale, фаза 1). Z-роутер и buildAutoRoutes
// берут готовые результаты из памяти по точным входам: повторный круг портов, раздача
// ориентации и компоненты, маршрут связи, пара маршрутов, слот подписи, отсев далёких пар и
// слотов, разреженная цена сцены. С флагом diag.__ARCHMAP_Z_SELFCHECK каждое попадание
// дополнительно считается честно и сверяется; расхождение — исключение с названием кэша.
// Тест гоняет сцены фазз-полигона (routerFuzz.ts) с флагом и проверяет три вещи: ни одна
// сверка не разошлась, хэши результатов прежние (golden фазз-полигона), и каждый кэш из
// списка на этих сценах действительно сверялся — иначе тест ничего бы не ловил.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { diag } from "../graph/layout/diag";
import { runSeed } from "./routerFuzz";

// Путь к golden — из import.meta.url по частям (см. routerFuzz.golden.test).
const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "golden", "routerFuzz.json");
const SEEDS = 60;
// Кэши, которые обязаны сверяться на этих сценах (названия — как в самопроверке). На
// фазз-сценах нет подписей связей, поэтому «слот подписи» и «отсев далёких слотов» здесь
// не встречаются, а «раздачу компоненты (полный ключ)» включает лишь узкий кусок полосы при
// разрешении препятствий; эти три сверяет corpus-check --selfcheck на сценах корпуса.
const MUST = [
  "повторный круг портов",
  "раздача ориентации",
  "раздача компоненты (ближние препятствия)",
  "маршрут связи",
  "пара маршрутов",
  "отсев далёких пар",
  "цена сцены (разреженная сумма)",
];

afterEach(() => {
  delete diag.__ARCHMAP_Z_SELFCHECK;
  delete diag.__ARCHMAP_Z_SELFCHECK_COUNT;
});

describe("кэши Z-роутера — самопроверка на фазз-полигоне", () => {
  it(`сверки сходятся, маршруты прежние, каждый кэш сверялся (${SEEDS} сидов)`, () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { seeds: Record<string, string> };
    const count: Record<string, number> = {};
    diag.__ARCHMAP_Z_SELFCHECK = true;
    diag.__ARCHMAP_Z_SELFCHECK_COUNT = count;
    const bad: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      // расхождение сверки бросает исключение с названием кэша — тест падает на нём
      const got = runSeed(seed);
      const want = golden.seeds[String(seed)];
      if (got !== want) bad.push(`сид ${seed}: golden ${want}, посчитано ${got}`);
    }
    expect(bad, "с самопроверкой маршруты разошлись с golden фазз-полигона").toEqual([]);
    const silent = MUST.filter((name) => (count[name] ?? 0) === 0);
    expect(silent, `кэши ни разу не сверялись: ${JSON.stringify(count)}`).toEqual([]);
  }, 180_000);
});
