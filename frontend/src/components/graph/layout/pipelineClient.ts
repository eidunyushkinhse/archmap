// Клиент воркера конвейера (Ф3 эпика плавности): computeViewLayoutOffThread —
// тот же контракт, что computeViewLayout, но счёт идёт в Web Worker: главный
// поток на время прогона свободен (elk-чанки и синхронные стадии больше не
// блокируют кадры). Дисциплина «последний выигрывает» остаётся у вызывающего
// (runIdRef в LevelGraph): результат перегнанного прогона он игнорирует.
//
// ОЧЕРЕДЬ — ЗДЕСЬ, А НЕ В ВОРКЕРЕ (эпик render-scale, шаг «быстрый ELK и один прогон»).
// Воркеру уходит одна задача за раз, остальные ждут в клиенте: отправленное сообщение из
// очереди воркера не отозвать, а ждать секунды расчёта, результат которого уже никому не
// нужен, — главная причина хвоста «Расставляем объекты» после быстрых действий. Правила
// действуют внутри ВЛАДЕЛЬЦА (холста, LayoutRunOptions.owner):
//  - СКЛЕЙКА: вход, структурно равный входу задачи того же холста в полёте или в
//    ожидании (inputKey: все поля, Map/Set в порядке вставки), не считается заново —
//    запрос получает результат той задачи (конвейер — детерминированная функция входа);
//  - ВЫТЕСНЕНИЕ: у холста ждёт не больше одной задачи; более свежий запрос вытесняет
//    ожидающую, её ждуны получают LayoutSupersededError («устарел»);
//  - ОБРЫВ: задача в полёте, перегнанная более свежим запросом своего холста (или холст
//    ушёл — releaseLayoutOwner), устарела. Если её результата ждать некому, а в очереди
//    кто-то ждёт и она считается дольше STALE_KILL_MS, воркер заменяется свежим,
//    засеянным памятью сцен (зеркало клиента, routeMemory) и прогретым, очередь уходит в
//    него (загрузка ELK заново дешевле секунд ненужного расчёта; кэш ELK воркера при этом
//    теряется). ЗАПАСНОЙ воркер создаётся, как только задача устарела при ждущей очереди,
//    — до порога: к обрыву он уже грузит ELK на соседнем ядре (замер: загрузка и холодный
//    первый прогон — основная цена обрыва). Досчиталась до порога — запасной гасится.
//    Пока ждущих нет, устаревшая задача досчитывается: обрыв ничего бы не выиграл. Обрывов подряд — не больше STALE_KILL_STREAK_MAX: поток запросов чаще длины
//    прогона иначе не дал бы досчитать ни одного;
//  - ФОНОВЫЙ прогон (уборка P14, background) не вытесняет прогон действия пользователя:
//    тот ждёт или считается — уборка отклоняется как устаревшая; прогон действия
//    вытесняет уборку, как любую свою задачу.
// Запросы разных холстов друг друга не вытесняют и не склеиваются; запрос без владельца
// не склеивается, не вытесняется и устаревшим не бывает.
//
// Деградации:
//  - Worker недоступен (jsdom, старое окружение) или не создался — счёт на
//    главном потоке (фолбэк = прямой вызов модуля, поведение до Ф3), без очереди;
//  - воркер УПАЛ (onerror / DataCloneError поста): все ожидающие прогоны
//    досчитываются на главном потоке (устаревшие — отклоняются), воркер помечается
//    сломанным и больше не используется до перезагрузки страницы;
//  - ok:false из воркера — законная ошибка самого конвейера: пробрасывается
//    как reject БЕЗ фолбэка (на главном потоке она повторилась бы);
//  - прогон не уложился в RUN_TIMEOUT_MS (аудит R-17): патологический вход держал
//    бы очередь до перезагрузки страницы — бейдж «Расставляем объекты» навсегда. Сторож
//    отклоняет зависший прогон (схема остаётся с прежней раскладкой), воркер
//    пересоздаётся, очередь уходит в новый. На главный поток её НЕ переносим: тот же
//    вход повесил бы весь интерфейс;
//  - onmessageerror (ответ не разобрать — чей он, неизвестно) — как падение воркера.
//
// ПРОГРЕВ (warmLayoutWorker): оболочка проекта зовёт его при открытии проекта, до прихода
// данных холста, — воркер грузит конвейер и ELK заранее, и первый прогон не платит их
// загрузку. Свежий воркер после сторожа или обрыва прогревается сам.
//
// Живой драг НЕ здесь: useLiveDragHandles остаётся синхронным на главном потоке
// (ему нужен кадр-в-кадр; он скоуплен и дёшев). Тесты и дамп-гейты импортируют
// чистый модуль pipeline напрямую.
import type { PipelineInput, PipelineOutput } from "./pipeline";
import { createRouteMemory, type RouteMemoryEntry } from "./routeMemory";
import { lazyOnce } from "../../../lib/lazyOnce";
import { diag } from "./diag";
// vite-канонический импорт воркера (?worker): и dev, и build дают конструктор.
// Синтаксис new Worker(new URL(...)) в dev у rolldown-vite падал «_Worker is not
// a constructor» МИМО try/catch — не использовать.
import PipelineWorker from "./pipeline.worker.ts?worker";

// Счёт на главном потоке — запасной путь (воркер недоступен или упал), поэтому сам
// конвейер грузится лениво: статический импорт держал его во входном чанке, который
// качается уже на экране входа (аудит R-18). Воркер везёт свою копию конвейера.
// Памяти сцен (routeMemory) у запасного пути нет: она живёт в воркере.
const loadPipeline = lazyOnce(() => import("./pipeline"));

function computeViewLayout(input: PipelineInput): Promise<PipelineOutput> {
  return loadPipeline().then((m) => m.computeViewLayout(input));
}

// Самые тяжёлые реальные сцены считаются до ~8 с (холодные корни, замеры эпика
// роутера) — сторож с большим запасом.
export const RUN_TIMEOUT_MS = 60_000;

// Устаревшая задача в полёте, считающаяся дольше этого порога, обрывается пересозданием
// воркера. Ниже порога она, скорее всего, вот-вот кончится: загрузка ELK в свежий воркер
// стоит 0,3–0,5 с, и обрывать короткий расчёт дороже, чем дождаться его.
export const STALE_KILL_MS = 400;
// Обрывов подряд (без единого досчитанного прогона между ними) — не больше этого.
export const STALE_KILL_STREAK_MAX = 2;

/** Исход запроса, перегнанного более свежим запросом того же холста: результата не будет. */
export class LayoutSupersededError extends Error {
  constructor() {
    super("Раскладка устарела: её перегнал более свежий запрос того же холста");
    this.name = "LayoutSupersededError";
  }
}

export interface LayoutRunOptions {
  /** владелец запроса — холст (любой объект с идентичностью); без него очередь прежняя */
  owner?: object;
  /** фоновый прогон (уборка P14): не вытесняет прогон действия пользователя */
  background?: boolean;
}

/** Сообщения воркеру (pipeline.worker.ts). */
export type WorkerRequest =
  | { kind: "run"; runId: number; input: PipelineInput }
  | { kind: "warm" }
  | { kind: "seed"; entries: [string, RouteMemoryEntry][] };

type WorkerReply =
  | { runId: number; ok: true; out: PipelineOutput }
  | { runId: number; ok: false; error: string };

interface Waiter {
  resolve: (out: PipelineOutput) => void;
  reject: (e: Error) => void;
}

interface Job {
  id: number;
  input: PipelineInput;
  owner: object | null;
  background: boolean;
  waiters: Waiter[];
  /** структурная сигнатура входа (считается лениво — только когда есть с чем склеивать) */
  key: string | null;
  /** момент отправки воркеру (performance.now) */
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
}

let worker: Worker | null | undefined; // undefined — ещё не пробовали, null — сломан
let spare: Worker | null = null; // запасной: засеян и прогрет, ждёт обрыва
let seq = 0;
let inFlight: Job | null = null;
const waiting: Job[] = [];
// Задача, результата которой ждёт холст (последний его запрос).
const latest = new Map<object, Job>();
// Воркеры, которым уже ушло сообщение прогрева (повтор ничего не даёт).
const warmed = new WeakSet<Worker>();
let killStreak = 0;
// Зеркало памяти сцен воркера (routeMemory): те же авторитетные результаты в том же порядке.
const memoryMirror = createRouteMemory();

/**
 * Структурная сигнатура входа конвейера: все поля, Map и Set — в порядке вставки (тот
 * порядок, в котором их обходит конвейер), бесконечности — отдельной меткой (JSON
 * превратил бы их в null). Одинаковая сигнатура ⇒ одинаковый результат.
 */
export function inputKey(input: PipelineInput): string {
  return JSON.stringify(input, (_k, v: unknown) => {
    if (v instanceof Map) return { __map: [...v.entries()] };
    if (v instanceof Set) return { __set: [...v.values()] };
    if (typeof v === "number" && !Number.isFinite(v)) return { __num: String(v) };
    return v;
  });
}

const keyOf = (job: Job): string => (job.key ??= inputKey(job.input));

// Результата задачи никто не ждёт: её холст ждёт другую или ушёл.
const isStale = (job: Job): boolean => job.owner !== null && latest.get(job.owner) !== job;

function clearTimers(job: Job): void {
  if (job.timer) clearTimeout(job.timer);
  if (job.staleTimer) clearTimeout(job.staleTimer);
  job.timer = null;
  job.staleTimer = null;
}

function settleAll(job: Job, fn: (w: Waiter) => void): void {
  if (job.owner && latest.get(job.owner) === job) latest.delete(job.owner);
  for (const w of job.waiters) fn(w);
  job.waiters = [];
}

const superseded = (job: Job): void => settleAll(job, (w) => w.reject(new LayoutSupersededError()));

function runOnMain(job: Job): void {
  computeViewLayout(job.input).then(
    (out) => settleAll(job, (w) => w.resolve(out)),
    (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      settleAll(job, (w) => w.reject(err));
    },
  );
}

// Воркер сломался: всё ожидающее досчитать на главном потоке (как до Ф3); устаревшее —
// отклонить, его никто не ждёт.
function failoverAll(): void {
  worker?.terminate();
  worker = null;
  dropSpare();
  const jobs = inFlight ? [inFlight, ...waiting] : [...waiting];
  inFlight = null;
  waiting.length = 0;
  for (const job of jobs) {
    clearTimers(job);
    if (isStale(job)) superseded(job);
    else runOnMain(job);
  }
}

function warm(w: Worker): void {
  if (warmed.has(w)) return;
  warmed.add(w);
  try {
    w.postMessage({ kind: "warm" } satisfies WorkerRequest);
  } catch {
    // прогрев — оптимизация: не ушёл — первый прогон загрузит всё сам
  }
}

// Свежий воркер в дело: засеять памятью сцен и прогреть.
function prime(w: Worker): void {
  const entries = memoryMirror.entries();
  if (entries.length > 0) {
    try {
      w.postMessage({ kind: "seed", entries } satisfies WorkerRequest);
    } catch {
      // засев — оптимизация: не ушёл — сцены посчитаются заново
    }
  }
  warm(w);
}

function prepareSpare(): void {
  if (spare || !worker) return;
  spare = createWorker();
  if (spare) prime(spare);
}

function dropSpare(): void {
  spare?.terminate();
  spare = null;
}

// Заменить воркер (сторож или обрыв устаревшей задачи): запасной, если он готовится, иначе
// свежий — засеянный и прогретый.
function restartWorker(): void {
  worker?.terminate();
  if (spare) {
    worker = spare;
    spare = null;
    return;
  }
  worker = undefined; // следующий getWorker создаст свежий
  const fresh = getWorker();
  if (fresh) prime(fresh);
}

// Следующую задачу — воркеру, если он свободен.
function pump(): void {
  while (!inFlight && waiting.length > 0) {
    const job = waiting.shift() as Job;
    const w = getWorker();
    if (!w) {
      runOnMain(job); // воркер сломался между постановкой и отправкой
      continue;
    }
    inFlight = job;
    job.startedAt = performance.now();
    job.timer = setTimeout(() => onTimeout(job), RUN_TIMEOUT_MS);
    try {
      w.postMessage({ kind: "run", runId: job.id, input: job.input } satisfies WorkerRequest);
    } catch {
      // вход не клонируется (неожиданное поле) — этот и будущие прогоны на главном
      failoverAll();
    }
  }
}

// Прогон завис: отклонить его, пересоздать воркер и отправить очередь в новый.
function onTimeout(job: Job): void {
  if (inFlight !== job) return;
  inFlight = null;
  clearTimers(job);
  settleAll(job, (w) => w.reject(new Error(`Раскладка не уложилась в ${RUN_TIMEOUT_MS / 1000} с`)));
  restartWorker();
  pump();
}

// Правило обрыва (шапка модуля): устаревшая задача в полёте, очередь не пуста, порог
// времени пройден, лимит обрывов подряд не исчерпан. Не дошло до порога — проверить, когда
// дойдёт.
function maybeKill(): void {
  const job = inFlight;
  if (!job || !isStale(job) || waiting.length === 0 || killStreak >= STALE_KILL_STREAK_MAX) return;
  const left = job.startedAt + STALE_KILL_MS - performance.now();
  if (left > 0) {
    prepareSpare();
    job.staleTimer ??= setTimeout(() => { job.staleTimer = null; maybeKill(); }, left);
    return;
  }
  inFlight = null;
  clearTimers(job);
  superseded(job);
  killStreak++;
  restartWorker();
  pump();
}

function onReply(from: Worker, msg: WorkerReply): void {
  if (from !== worker) return; // ответ оборванного воркера
  const job = inFlight;
  if (!job || job.id !== msg.runId) return; // задача уже разрешена сторожем
  inFlight = null;
  clearTimers(job);
  killStreak = 0;
  dropSpare(); // задача досчиталась — обрыва не будет, запасной не нужен
  if (msg.ok) {
    // зеркало памяти сцен: тот же гейт, что у записи в память воркера
    const { authoritative, routeSig, layout } = msg.out;
    if (authoritative && layout.autoRoutes && layout.labelPlacements) {
      memoryMirror.put(routeSig, { routes: layout.autoRoutes, handles: layout.edgeHandles, labels: layout.labelPlacements });
    }
    settleAll(job, (w) => w.resolve(msg.out));
  } else {
    const err = new Error(msg.error);
    settleAll(job, (w) => w.reject(err));
  }
  pump();
}

// Новый воркер с обработчиками; null — Worker недоступен или не создался. Ответы и сбои
// принимаются только от действующего воркера; сбой запасного его просто гасит.
function createWorker(): Worker | null {
  try {
    if (typeof Worker === "undefined") return null;
    const w: Worker = new PipelineWorker();
    const fail = () => {
      if (w === worker) failoverAll();
      else if (w === spare) dropSpare();
    };
    w.onmessage = (ev: MessageEvent<WorkerReply>) => onReply(w, ev.data);
    w.onerror = fail;
    w.onmessageerror = fail;
    return w;
  } catch {
    return null;
  }
}

function getWorker(): Worker | null {
  if (worker === undefined) worker = createWorker();
  return worker;
}

// Поставить запрос в очередь по правилам владельца (шапка модуля).
function submit(input: PipelineInput, opts: LayoutRunOptions, waiter: Waiter): void {
  const owner = opts.owner ?? null;
  const background = opts.background === true;
  const job: Job = {
    id: ++seq, input, owner, background, waiters: [waiter], key: null,
    startedAt: 0, timer: null, staleTimer: null,
  };
  if (owner) {
    const fly = inFlight && inFlight.owner === owner ? inFlight : null;
    const wait = waiting.find((j) => j.owner === owner) ?? null;
    // уборка не трогает прогон действия пользователя: тот ждёт или считается
    if (background && ((wait && !wait.background) || (fly && !fly.background && !isStale(fly)))) {
      waiter.reject(new LayoutSupersededError());
      return;
    }
    // склейка: тот же вход уже ждёт или считается — запрос получит его результат
    if (wait || fly) {
      const key = inputKey(input);
      if (wait && keyOf(wait) === key) {
        wait.waiters.push(waiter);
        latest.set(owner, wait);
        return;
      }
      if (fly && keyOf(fly) === key) {
        fly.waiters.push(waiter);
        latest.set(owner, fly);
        if (wait) {
          waiting.splice(waiting.indexOf(wait), 1);
          superseded(wait);
        }
        return;
      }
      job.key = key;
    }
    // свежий вход: ожидающая задача холста вытесняется, задача в полёте устаревает
    if (wait) {
      waiting.splice(waiting.indexOf(wait), 1);
      superseded(wait);
    }
    latest.set(owner, job);
  }
  waiting.push(job);
  pump();
  maybeKill();
}

/** Прогон конвейера вне главного потока (фолбэк — прямой вызов модуля). */
export function computeViewLayoutOffThread(
  input: PipelineInput,
  opts: LayoutRunOptions = {},
): Promise<PipelineOutput> {
  // ЗАХВАТ ВХОДА (перф-эпик 2026-08-20): __archmapCaptureInput = true (консоль/зонд) →
  // последний вход сохраняется для оффлайн-реплея профилирования
  // (__tests__/pipelineReplay.perf.test.ts; сериализация — perf-probe --capture).
  if (diag.__archmapCaptureInput) diag.__archmapLastPipelineInput = input;
  if (!getWorker()) return computeViewLayout(input);
  return new Promise<PipelineOutput>((resolve, reject) => submit(input, opts, { resolve, reject }));
}

/**
 * Холст ушёл (размонтирован): его задачи никому не нужны. Ожидающая вытесняется, задача в
 * полёте устаревает (и обрывается по правилу обрыва, когда очередь не пуста).
 */
export function releaseLayoutOwner(owner: object): void {
  latest.delete(owner);
  for (const job of waiting.filter((j) => j.owner === owner)) {
    waiting.splice(waiting.indexOf(job), 1);
    superseded(job);
  }
  maybeKill();
}

/**
 * Прогрев: воркер создаётся и грузит конвейер и ELK заранее (оболочка проекта, до прихода
 * данных холста). Повторный вызов ничего не делает; без воркера — тоже ничего.
 */
export function warmLayoutWorker(): void {
  const w = getWorker();
  if (w) warm(w);
}
