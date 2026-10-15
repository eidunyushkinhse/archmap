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
//    как reject БЕЗ фолбэка (на главном потоке она повторилась бы);
//  - прогон не уложился в RUN_TIMEOUT_MS (аудит R-17): воркер считает задачи по
//    очереди, и патологический вход держал бы очередь до перезагрузки страницы —
//    «Считаю раскладку…» навсегда. Сторож отклоняет зависший прогон (схема остаётся
//    с прежней раскладкой), воркер пересоздаётся, остальные задачи уходят в новый.
//    На главный поток их НЕ переносим: тот же вход повесил бы весь интерфейс;
//  - onmessageerror (ответ не разобрать — чей он, неизвестно) — как падение воркера.
//
// Живой драг НЕ здесь: useLiveDragHandles остаётся синхронным на главном потоке
// (ему нужен кадр-в-кадр; он скоуплен и дёшев). Тесты и дамп-гейты импортируют
// чистый модуль pipeline напрямую.
import type { PipelineInput, PipelineOutput } from "./pipeline";
import { lazyOnce } from "../../../lib/lazyOnce";
import { diag } from "./diag";
// vite-канонический импорт воркера (?worker): и dev, и build дают конструктор.
// Синтаксис new Worker(new URL(...)) в dev у rolldown-vite падал «_Worker is not
// a constructor» МИМО try/catch — не использовать.
import PipelineWorker from "./pipeline.worker.ts?worker";

// Счёт на главном потоке — запасной путь (воркер недоступен или упал), поэтому сам
// конвейер грузится лениво: статический импорт держал его во входном чанке, который
// качается уже на экране входа (аудит R-18). Воркер везёт свою копию конвейера.
const loadPipeline = lazyOnce(() => import("./pipeline"));

function computeViewLayout(input: PipelineInput): Promise<PipelineOutput> {
  return loadPipeline().then((m) => m.computeViewLayout(input));
}

// Самые тяжёлые реальные сцены считаются до ~8 с (холодные корни, замеры эпика
// роутера) — сторож с большим запасом.
export const RUN_TIMEOUT_MS = 60_000;

type WorkerReply =
  | { runId: number; ok: true; out: PipelineOutput }
  | { runId: number; ok: false; error: string };

interface Pending {
  input: PipelineInput;
  resolve: (out: PipelineOutput) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
    clearTimeout(p.timer);
    computeViewLayout(p.input).then(p.resolve, (e: unknown) =>
      p.reject(e instanceof Error ? e : new Error(String(e))),
    );
  }
}

// Отправить задачу воркеру со сторожем.
function post(w: Worker, runId: number, p: Omit<Pending, "timer">): void {
  const timer = setTimeout(() => onTimeout(runId), RUN_TIMEOUT_MS);
  pending.set(runId, { ...p, timer });
  w.postMessage({ runId, input: p.input });
}

// Прогон завис: отклонить его, пересоздать воркер и переотправить остальную очередь.
function onTimeout(runId: number): void {
  const stuck = pending.get(runId);
  if (!stuck) return;
  pending.delete(runId);
  stuck.reject(new Error(`Раскладка не уложилась в ${RUN_TIMEOUT_MS / 1000} с`));
  worker?.terminate();
  worker = undefined; // следующий getWorker создаст свежий
  const rest = [...pending.entries()];
  pending.clear();
  const fresh = getWorker();
  for (const [id, p] of rest) {
    clearTimeout(p.timer);
    if (fresh) post(fresh, id, p);
    else computeViewLayout(p.input).then(p.resolve, (e: unknown) =>
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
      if (!p) return; // задача уже разрешена фолбэком или сторожем
      pending.delete(msg.runId);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.out);
      else p.reject(new Error(msg.error));
    };
    worker.onerror = failoverAll;
    worker.onmessageerror = failoverAll;
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
  if (diag.__archmapCaptureInput) diag.__archmapLastPipelineInput = input;
  const w = getWorker();
  if (!w) return computeViewLayout(input);
  const runId = ++seq;
  return new Promise<PipelineOutput>((resolve, reject) => {
    try {
      post(w, runId, { input, resolve, reject });
    } catch {
      // вход не клонируется (неожиданное поле) — этот и будущие прогоны на главном
      const p = pending.get(runId);
      if (p) clearTimeout(p.timer);
      pending.delete(runId);
      failoverAll();
      computeViewLayout(input).then(resolve, (e: unknown) =>
        reject(e instanceof Error ? e : new Error(String(e))),
      );
    }
  });
}
