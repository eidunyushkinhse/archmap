// Клиент воркера конвейера (Ф3 эпика плавности): computeViewLayoutOffThread —
// тот же контракт, что computeViewLayout, но счёт идёт в Web Worker: главный
// поток на время прогона свободен (elk-чанки и синхронные стадии больше не
// блокируют кадры). Дисциплина «последний выигрывает» остаётся у вызывающего
// (runIdRef в LevelGraph) — клиент не отменяет устаревшие задачи, их результат
// просто игнорируется наверху.
//
// Деградации:
//  - Worker недоступен (jsdom, старое окружение) или не создался — счёт на
//    главном потоке (фолбэк = прямой вызов модуля, поведение до Ф3);
//  - воркер УПАЛ (onerror / DataCloneError поста): все ожидающие прогоны
//    досчитываются на главном потоке, воркер помечается сломанным и больше
//    не используется до перезагрузки страницы;
//  - ok:false из воркера — законная ошибка самого конвейера: пробрасывается
//    как reject БЕЗ фолбэка (на главном потоке она повторилась бы).
//
// Живой драг НЕ здесь: useLiveDragHandles остаётся синхронным на главном потоке
// (ему нужен кадр-в-кадр; он скоуплен и дёшев). Тесты и дамп-гейты импортируют
// чистый модуль pipeline напрямую.
import { computeViewLayout, type PipelineInput, type PipelineOutput } from "./pipeline";
// vite-канонический импорт воркера (?worker): и dev, и build дают конструктор.
// Синтаксис new Worker(new URL(...)) в dev у rolldown-vite падал «_Worker is not
// a constructor» МИМО try/catch — не использовать.
import PipelineWorker from "./pipeline.worker.ts?worker";

type WorkerReply =
  | { runId: number; ok: true; out: PipelineOutput }
  | { runId: number; ok: false; error: string };

interface Pending {
  input: PipelineInput;
  resolve: (out: PipelineOutput) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null | undefined; // undefined — ещё не пробовали, null — сломан
let seq = 0;
const pending = new Map<number, Pending>();

// Воркер сломался: всё ожидающее досчитать на главном потоке (как до Ф3).
function failoverAll() {
  worker?.terminate();
  worker = null;
  const stuck = [...pending.values()];
  pending.clear();
  for (const p of stuck) {
    computeViewLayout(p.input).then(p.resolve, (e: unknown) =>
      p.reject(e instanceof Error ? e : new Error(String(e))),
    );
  }
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === "undefined") {
      worker = null;
      return worker;
    }
    worker = new PipelineWorker();
    worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
      const msg = ev.data;
      const p = pending.get(msg.runId);
      if (!p) return; // задача уже разрешена фолбэком
      pending.delete(msg.runId);
      if (msg.ok) p.resolve(msg.out);
      else p.reject(new Error(msg.error));
    };
    worker.onerror = failoverAll;
  } catch {
    worker = null;
  }
  return worker;
}

/** Прогон конвейера вне главного потока (фолбэк — прямой вызов модуля). */
export function computeViewLayoutOffThread(input: PipelineInput): Promise<PipelineOutput> {
  // ЗАХВАТ ВХОДА (перф-эпик 2026-08-20): __archmapCaptureInput = true (консоль/зонд) →
  // последний вход сохраняется для оффлайн-реплея профилирования
  // (__tests__/pipelineReplay.perf.test.ts; сериализация — perf-probe --capture).
  const cap = globalThis as unknown as {
    __archmapCaptureInput?: boolean; __archmapLastPipelineInput?: PipelineInput;
  };
  if (cap.__archmapCaptureInput) cap.__archmapLastPipelineInput = input;
  const w = getWorker();
  if (!w) return computeViewLayout(input);
  const runId = ++seq;
  return new Promise<PipelineOutput>((resolve, reject) => {
    pending.set(runId, { input, resolve, reject });
    try {
      w.postMessage({ runId, input });
    } catch {
      // вход не клонируется (неожиданное поле) — этот и будущие прогоны на главном
      pending.delete(runId);
      failoverAll();
      computeViewLayout(input).then(resolve, (e: unknown) =>
        reject(e instanceof Error ? e : new Error(String(e))),
      );
    }
  });
}
