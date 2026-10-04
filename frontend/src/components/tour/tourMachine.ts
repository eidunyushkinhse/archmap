// Чистая машина состояний обучающего тура (docs/tasks/demo-tour.md): переходы по
// кнопкам и сигналам продукта, пропуск шагов с ненайденными объектами, захват и
// подстановка имён созданных объектов. Без DOM и React — вся логика шагов здесь,
// под тестами (__tests__/tourMachine.test.ts).
import { routeProject, type TourRoute } from "./tourRoute";
import {
  FALLBACK_NAMES, FULL_SEQUENCE, SHORT_SEQUENCE, STEPS,
  YAR_ORDERS, YAR_SYSTEM,
  type Screen, type StepId, type TourStep,
} from "./tourSteps";

/** Что тур узнал о своём проекте пользователя по ходу шагов 15–20. */
export interface TourVars {
  ownProjectId?: string;
  systemId?: string;
  systemName?: string;
  peerId?: string;
  peerName?: string;
  childId?: string;
  childName?: string;
}

/** full — «Ярмарка» и свой проект; short — свой проект уже есть (повторный запуск). */
export type TourVariant = "full" | "short";

export interface TourState {
  status: "running" | "done";
  step: StepId;
  variant: TourVariant;
  /** направление последнего хода: туда же пропускаются недоступные шаги */
  dir: 1 | -1;
  vars: TourVars;
}

/** Сигналы продукта: маршрут, шина событий (projectId — проект маршрута в момент
 *  события), появление окна «Новый проект» в DOM. */
export type TourSignal =
  | { kind: "route"; route: TourRoute }
  | { kind: "level"; projectId: string; levelId: string | null }
  | { kind: "node-created"; projectId: string | null; id: string; name: string; shape: string; parentId: string | null }
  | { kind: "edge-created"; projectId: string | null; id: string; sourceId: string; targetId: string }
  | { kind: "edge-reconnected"; projectId: string | null; fromId: string; toId: string }
  | { kind: "node-expanded"; projectId: string | null; id: string }
  | { kind: "node-drag-end"; projectId: string | null; ids: string[] }
  | { kind: "dom"; key: "create-project" };

export type TourAction =
  | { type: "next" }
  | { type: "back" }
  /** «Пропустить» / «Пропустить обучение» */
  | { type: "skip" }
  /** «Завершить» на финале */
  | { type: "finish" }
  /** объекты текущего шага не нашлись (выяснилось после входа в шаг) */
  | { type: "unavailable" }
  /** «Новый проект» погашена: свой проект уже есть */
  | { type: "blocked" }
  | { type: "signal"; signal: TourSignal };

/** Что тур знает о «Ярмарке»: id проекта (null — проекта нет, undefined — ещё не
 *  выяснили) и её объекты по именам (undefined — ещё не загружены). */
export interface TourEnv {
  yarProjectId: string | null | undefined;
  yarObjects: ReadonlyMap<string, string> | undefined;
}

export type Availability = "yes" | "no" | "unknown";

export function sequenceOf(variant: TourVariant): readonly StepId[] {
  return variant === "short" ? SHORT_SEQUENCE : FULL_SEQUENCE;
}

/** M в «Шаг N из M»: шаги без приветствия и финала. */
export function stepTotal(variant: TourVariant): number {
  return sequenceOf(variant).filter((id) => STEPS[id].n !== undefined).length;
}

export function startState(variant: TourVariant): TourState {
  return { status: "running", step: "welcome", variant, dir: 1, vars: {} };
}

/** Кнопка «Назад» — со второго шага и до последнего (как в прототипе). */
export function canGoBack(step: StepId): boolean {
  const n = STEPS[step].n;
  return n !== undefined && n > 1;
}

const OWN_STEPS = new Set<StepId>([
  "create-system", "add-peer", "connect", "enter-system", "add-child",
  "rehang", "go-up", "context-edge", "expand-own",
]);

/** Нужна ли шагу «Ярмарка»: экран, цель или объекты из её проекта. */
function needsYar(step: TourStep): boolean {
  return step.screen.kind.startsWith("yar") || step.target?.kind === "yar-card" || !!step.needs;
}

/** Можно ли показать шаг: «no» — пропускаем, «unknown» — данные ещё грузятся. */
export function availability(id: StepId, state: TourState, env: TourEnv): Availability {
  const step = STEPS[id];
  // Свой проект уже создан: «Новый проект» погашена, шаги 14–15 не выполнить.
  if ((id === "new-project" || id === "create-blank") && state.vars.ownProjectId) return "no";
  if (OWN_STEPS.has(id) && !state.vars.ownProjectId) return "no";
  if (needsYar(step)) {
    if (env.yarProjectId === null) return "no";
    if (env.yarProjectId === undefined) return "unknown";
  }
  if (step.needs) {
    if (!env.yarObjects) return "unknown";
    if (step.needs.some((name) => !env.yarObjects?.has(name))) return "no";
  }
  return "yes";
}

/** Ход на соседний шаг в направлении dir с пропуском недоступных. */
function move(state: TourState, dir: 1 | -1, env: TourEnv): TourState {
  const seq = sequenceOf(state.variant);
  let i = seq.indexOf(state.step) + dir;
  while (i >= 0 && i < seq.length && availability(seq[i], state, env) === "no") i += dir;
  if (i < 0) return state;
  if (i >= seq.length) return { ...state, status: "done" };
  return { ...state, step: seq[i], dir };
}

const samePair = (a: string, b: string, x?: string, y?: string): boolean =>
  !!x && !!y && ((a === x && b === y) || (a === y && b === x));

/**
 * Выполнил ли пользователь действие шага. Возвращает захваченные переменные
 * (пустой объект — действие сделано, захватывать нечего) или null.
 */
function actDone(state: TourState, s: TourSignal, env: TourEnv): TourVars | null {
  const yar = env.yarProjectId ?? undefined;
  const own = state.vars.ownProjectId;
  const obj = (name: string) => env.yarObjects?.get(name);
  const ok = (cond: boolean): TourVars | null => (cond ? {} : null);
  switch (state.step) {
    case "open-yar":
      return ok(s.kind === "route" && !!yar && routeProject(s.route) === yar);
    case "open-editor":
      return ok(s.kind === "route" && s.route.name === "map" && s.route.projectId === yar);
    case "drag":
      return ok(s.kind === "node-drag-end" && s.projectId === yar);
    case "expand-system": {
      // Лупа раскрывает систему на месте; «Войти» на ней же ведёт внутрь — тоже
      // показывает её сервисы, и следующий шаг продолжается там.
      const sys = obj(YAR_SYSTEM);
      return ok(!!sys && ((s.kind === "node-expanded" && s.id === sys)
        || (s.kind === "level" && s.projectId === yar && s.levelId === sys)));
    }
    case "expand-service": {
      const svc = obj(YAR_ORDERS);
      return ok(!!svc && s.kind === "node-expanded" && s.id === svc);
    }
    case "leave-yar":
      return ok(s.kind === "route" && s.route.name === "projects");
    case "new-project":
      return ok(s.kind === "dom" && s.key === "create-project");
    case "create-blank": {
      // Проект создан — окно уводит в него. Любой проект, кроме «Ярмарки», — свой.
      if (s.kind !== "route") return null;
      const pid = routeProject(s.route);
      return pid && pid !== yar ? { ownProjectId: pid } : null;
    }
    case "create-system":
      return s.kind === "node-created" && s.projectId === own && s.parentId === null && s.shape === "service"
        ? { systemId: s.id, systemName: s.name }
        : null;
    case "add-peer":
      return s.kind === "node-created" && s.projectId === own && s.parentId === null && s.id !== state.vars.systemId
        ? { peerId: s.id, peerName: s.name }
        : null;
    case "connect":
      return ok(s.kind === "edge-created" && s.projectId === own
        && samePair(s.sourceId, s.targetId, state.vars.systemId, state.vars.peerId));
    case "enter-system":
      return ok(s.kind === "level" && s.projectId === own && !!state.vars.systemId && s.levelId === state.vars.systemId);
    case "add-child":
      return s.kind === "node-created" && s.projectId === own && !!state.vars.systemId
        && s.parentId === state.vars.systemId && s.shape === "service"
        ? { childId: s.id, childName: s.name }
        : null;
    case "rehang":
      // Холст сам проверил, что новый конец — член рамки: перевешенный с рамки
      // системы конец стал её ребёнком.
      return ok(s.kind === "edge-reconnected" && s.projectId === own
        && !!state.vars.systemId && s.fromId === state.vars.systemId);
    case "go-up":
      return ok(s.kind === "level" && s.projectId === own && s.levelId === null);
    case "expand-own":
      return ok(s.kind === "node-expanded" && s.projectId === own
        && !!state.vars.systemId && s.id === state.vars.systemId);
    default:
      return null;
  }
}

export function reduceTour(state: TourState, action: TourAction, env: TourEnv): TourState {
  if (state.status !== "running") return state;
  const kind = STEPS[state.step].kind;
  switch (action.type) {
    case "skip":
    case "finish":
      return { ...state, status: "done" };
    case "next":
      if (kind === "end") return { ...state, status: "done" };
      return kind === "start" || kind === "info" ? move(state, 1, env) : state;
    case "back":
      return kind === "start" || kind === "end" ? state : move(state, -1, env);
    case "unavailable":
      return availability(state.step, state, env) === "no" ? move(state, state.dir, env) : state;
    case "blocked":
      if (state.step !== "new-project") return state;
      // Свой проект завели в обход тура: создавать его заново нечем.
      return { ...state, variant: "short", step: "final-short", dir: 1 };
    case "signal": {
      if (kind !== "act") return state;
      const caught = actDone(state, action.signal, env);
      if (!caught) return state;
      return move({ ...state, vars: { ...state.vars, ...caught } }, 1, env);
    }
  }
}

/** Какой узел шаг просит раскрыть лупой (null — шаг не про раскрытие). Раскрытие
 *  хранится в виде: при повторном проходе узел может быть раскрыт с прошлого раза. */
export function expandTarget(state: TourState, env: TourEnv): string | null {
  switch (state.step) {
    case "expand-system":
      return env.yarObjects?.get(YAR_SYSTEM) ?? null;
    case "expand-service":
      return env.yarObjects?.get(YAR_ORDERS) ?? null;
    case "expand-own":
      return state.vars.systemId ?? null;
    default:
      return null;
  }
}

/** Тексты шага с подставленными именами созданных объектов. */
export function stepTexts(step: TourStep, vars: TourVars): { title: string; body: string; action?: string } {
  const sub = (s: string) => s
    .replaceAll("{system}", vars.systemName ?? FALLBACK_NAMES.system)
    .replaceAll("{peer}", vars.peerName ?? FALLBACK_NAMES.peer)
    .replaceAll("{child}", vars.childName ?? FALLBACK_NAMES.child);
  return {
    title: sub(step.title),
    body: sub(step.body),
    ...(step.action ? { action: sub(step.action) } : {}),
  };
}

/** На экране ли шага пользователь сейчас. */
export function onScreen(screen: Screen, route: TourRoute, state: TourState, env: TourEnv): boolean {
  const yar = env.yarProjectId;
  const pid = routeProject(route);
  switch (screen.kind) {
    case "any":
      return true;
    case "projects":
      return route.name === "projects";
    case "yar-home":
      return route.name === "project-home" && !!yar && pid === yar;
    case "yar-shell":
      return (route.name === "project-home" || route.name === "node") && !!yar && pid === yar;
    case "yar-any":
      return !!yar && pid === yar;
    case "yar-map":
      return route.name === "map" && !!yar && pid === yar;
    case "yar-node": {
      const id = env.yarObjects?.get(screen.name);
      return route.name === "node" && !!yar && pid === yar && !!id && route.nodeId === id;
    }
    case "own-map":
      return route.name === "map" && !!state.vars.ownProjectId && pid === state.vars.ownProjectId;
  }
}

/** Куда вести при входе в шаг, если пользователь не на его экране (null — некуда
 *  или незачем: экран «любой» или данных ещё нет). Формат — как у навигации App. */
export function screenHash(screen: Screen, state: TourState, env: TourEnv): string | null {
  const yar = env.yarProjectId;
  switch (screen.kind) {
    case "any":
      return null;
    case "projects":
      return "/projects";
    case "yar-home":
    case "yar-shell":
    case "yar-any":
      return yar ? `/p/${yar}` : null;
    case "yar-map":
      return yar ? `/p/${yar}/map` : null;
    case "yar-node": {
      const id = env.yarObjects?.get(screen.name);
      return yar && id ? `/p/${yar}/nodes/${id}` : null;
    }
    case "own-map":
      return state.vars.ownProjectId ? `/p/${state.vars.ownProjectId}/map` : null;
  }
}

// ── Хранение ────────────────────────────────────────────────────────────────

const STEP_IDS = new Set<string>(Object.keys(STEPS));
const VAR_KEYS: readonly (keyof TourVars)[] = [
  "ownProjectId", "systemId", "systemName", "peerId", "peerName", "childId", "childName",
];

/** Состояние из localStorage: всё, что не похоже на сохранённый тур, — null. */
export function parseTourState(raw: string | null): TourState | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.status !== "running" && o.status !== "done") return null;
  if (o.variant !== "full" && o.variant !== "short") return null;
  if (typeof o.step !== "string" || !STEP_IDS.has(o.step)) return null;
  const step = o.step as StepId;
  if (!sequenceOf(o.variant).includes(step)) return null;
  const vars: TourVars = {};
  if (o.vars && typeof o.vars === "object") {
    const v = o.vars as Record<string, unknown>;
    for (const key of VAR_KEYS) {
      const value = v[key];
      if (typeof value === "string") vars[key] = value;
    }
  }
  return { status: o.status, step, variant: o.variant, dir: o.dir === -1 ? -1 : 1, vars };
}

