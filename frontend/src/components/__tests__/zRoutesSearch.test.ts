/// <reference types="node" />
// Node-типы точечно: golden фазз-полигона читается с диска (как в routerFuzz.golden.test).
//
// ПЕРЕБОР Z-РОУТЕРА (эпик render-scale, шаг «меньше проб», спека edge.md E92 v20). Роутер
// пробует не все варианты всех связей, а только те, что могут уронить цену сцены: отсев до
// полной оценки, очередь повторных проб, тёплый старт кругов портов, бюджет. Критерий
// принятия прежний — строгое падение истинной цены сцены, — поэтому сторожа три:
//   • детерминизм: тот же вход — те же маршруты;
//   • честная проба отсеянного (diag.__ARCHMAP_Z_SKIPCHECK) считает отсеянные пробы на
//     восстанавливаемом состоянии и маршрутов не меняет (хэши — как в golden);
//   • механизмы действительно срабатывают на фазз-сценах (иначе тест ничего не ловит).
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { diag } from "../graph/layout/diag";
import { runSeed } from "./routerFuzz";

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "golden", "routerFuzz.json");
const SEEDS = 30;

afterEach(() => {
  delete diag.__ARCHMAP_Z_SKIPCHECK;
  delete diag.__ARCHMAP_Z_STATS;
});

describe("перебор Z-роутера — отсев, очередь, тёплый старт, бюджет", () => {
  it("детерминизм: повторный прогон сида даёт тот же хэш", () => {
    for (let seed = 1; seed <= 10; seed++) expect(runSeed(seed), `сид ${seed}`).toBe(runSeed(seed));
  }, 120_000);

  it(`честная проба отсеянного маршрутов не меняет, отсев срабатывает (${SEEDS} сидов)`, () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { seeds: Record<string, string> };
    const stats: Record<string, number> = {};
    diag.__ARCHMAP_Z_SKIPCHECK = true;
    diag.__ARCHMAP_Z_STATS = stats;
    const bad: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const got = runSeed(seed);
      if (got !== golden.seeds[String(seed)]) bad.push(`сид ${seed}: golden ${golden.seeds[String(seed)]}, посчитано ${got}`);
    }
    expect(bad, "честная проба отсеянного сдвинула маршруты").toEqual([]);
    expect(stats["skip.bound"] ?? 0, `отсев по границе вклада ни разу не сработал: ${JSON.stringify(stats)}`).toBeGreaterThan(0);
  }, 300_000);
});
