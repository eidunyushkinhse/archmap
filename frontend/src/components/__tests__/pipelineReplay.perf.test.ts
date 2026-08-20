/// <reference types="node" />
// Node-типы точечно: тест (и только он) читает файл входа и пишет тайминги —
// app-tsconfig остаётся браузерным, Node-глобалы в код приложения не протекают.
// Оффлайн-реплей конвейера для ПРОФИЛИРОВАНИЯ (перф-эпик 2026-08-20).
// Вход захватывается в живом браузере: __archmapCaptureInput = true →
// __archmapLastPipelineInput (pipelineClient); сериализует зонд
// scripts/perf-probe.mjs --capture <файл> (Set/Map кодируются {__set}/{__map}).
// Запуск (из frontend/):
//   ARCHMAP_REPLAY=<вход.json> npx vitest run pipelineReplay
// Пофазовые тайминги пишутся в <вход.json>.timings.json (vitest глотает stdout).
// Без ARCHMAP_REPLAY тест скипается — обычный прогон сьюта не задет.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { computeViewLayout, type PipelineInput } from "../graph/layout/pipeline";

const file = process.env.ARCHMAP_REPLAY;

// обратное преобразование сериализации зонда: {__set:[…]} → Set, {__map:[…]} → Map
function revive(_k: string, v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.__set)) return new Set(o.__set);
    if (Array.isArray(o.__map)) return new Map(o.__map as [unknown, unknown][]);
  }
  return v;
}

describe.skipIf(!file)("реплей конвейера (профилирование)", () => {
  it("гонит захваченный вход и пишет пофазовые тайминги", async () => {
    const input = JSON.parse(readFileSync(file!, "utf8"), revive) as PipelineInput;
    const rounds: Array<Array<{ stage: string; ms: number }>> = [];
    const g = globalThis as unknown as { __ARCHMAP_TRACE?: (stage: string, ms: number) => void };
    // два прогона: первый холодный (JIT), второй тёплый — смотреть оба
    for (let round = 0; round < 2; round++) {
      const marks: Array<{ stage: string; ms: number }> = [];
      g.__ARCHMAP_TRACE = (stage, ms) => marks.push({ stage, ms: Math.round(ms) });
      const t0 = performance.now();
      const out = await computeViewLayout(input);
      marks.push({ stage: "ИТОГО", ms: Math.round(performance.now() - t0) });
      rounds.push(marks);
      expect(out.layout).toBeTruthy();
    }
    delete g.__ARCHMAP_TRACE;
    writeFileSync(`${file}.timings.json`, JSON.stringify(rounds, null, 2));
  }, 600_000);
});
