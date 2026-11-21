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
//   • точное правило отсева («носитель без дела») под самопроверкой не находит ни одной
//     пробы, которая была бы принята, и результата не меняет;
//   • тёплый старт от собственного итога не делает ни одной пробы и повторяет итог;
//   • механизмы действительно срабатывают на фазз-сценах (иначе тест ничего не ловит).
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { diag } from "../graph/layout/diag";
import { zRoutes } from "../graph/layout/zRoutes";
import { assignPorts } from "../graph/layout/ports";
import type { NodeRect } from "../graph/edgePath";
import { generateScene, runSeed } from "./routerFuzz";

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "golden", "routerFuzz.json");
const SEEDS = 30;

// Вход zRoutes по сцене фазз-полигона: порты от assignPorts; labels — плашка 64×18 у
// каждой второй связи.
function zParams(seed: number, labels: boolean): Parameters<typeof zRoutes>[0] {
  const scene = generateScene(seed);
  const rects = new Map<string, NodeRect>();
  for (const id of scene.displayIds) {
    const p = scene.positions.get(id), sz = scene.sizes.get(id);
    if (p && sz) rects.set(id, { x: p.x, y: p.y, w: sz.w, h: sz.h });
  }
  const withLabel = new Set(scene.groups.filter((_, k) => k % 2 === 0).map((g) => g.id));
  const labelBoxOf = labels ? (id: string) => (withLabel.has(id) ? { w: 64, h: 18 } : undefined) : undefined;
  const { ports, shares } = assignPorts({ groups: scene.groups, rects, labelBoxOf });
  return { groups: scene.groups, ports, shares, obstacles: [...rects.values()], rectOf: (id: string) => rects.get(id), labelBoxOf };
}

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

  it("подсказка от того же входа: тот же результат без единой пробы (тёплый старт)", () => {
    let warmEdges = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const params = zParams(seed, false);
      const cold = zRoutes(params);
      const stats: Record<string, number> = {};
      diag.__ARCHMAP_Z_STATS = stats;
      const warm = zRoutes({ ...params, hint: cold.choice });
      delete diag.__ARCHMAP_Z_STATS;
      warmEdges += cold.choice.size;
      expect(stats.tries ?? 0, `сид ${seed}: тёплый старт от собственного итога что-то пробовал`).toBe(0);
      expect(stats.accepted ?? 0, `сид ${seed}`).toBe(0);
      expect([...warm.routes].sort(), `сид ${seed}: маршруты разошлись`).toEqual([...cold.routes].sort());
      expect([...warm.choice].sort(), `сид ${seed}: итог выбора разошёлся`).toEqual([...cold.choice].sort());
    }
    expect(warmEdges, "на сценах нет ни одной Z-связи").toBeGreaterThan(0);
  }, 120_000);

  // Фазз-сцены — без подписей; здесь подпись у каждой второй связи, иначе проходу по
  // носителям нечего проверять. Самопроверка считает каждую отсеянную пробу носителя честно
  // и кидает исключение, если та была бы принята.
  it("точное правило «носитель без дела» не отсеивает принимаемых проб, результат прежний", () => {
    let idle = 0, hostTries = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const params = zParams(seed, true);
      const plain = zRoutes(params);
      const stats: Record<string, number> = {};
      diag.__ARCHMAP_Z_SELFCHECK = true;
      diag.__ARCHMAP_Z_STATS = stats;
      const checked = zRoutes(params);
      delete diag.__ARCHMAP_Z_SELFCHECK;
      delete diag.__ARCHMAP_Z_STATS;
      idle += stats["skip.hostIdle"] ?? 0;
      hostTries += stats.hostTries ?? 0;
      expect([...checked.routes].sort(), `сид ${seed}: самопроверка сдвинула маршруты`).toEqual([...plain.routes].sort());
    }
    expect(hostTries, "проход по носителям ни разу не пробовал").toBeGreaterThan(0);
    expect(idle, "правило «носитель без дела» ни разу не сработало").toBeGreaterThan(0);
  }, 120_000);
});
