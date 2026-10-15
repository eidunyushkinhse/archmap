// Хранение тура (аудит F-38): состояние (пройден/пропущен, на паузе, текущий шаг, имена
// созданных объектов) в localStorage по id гостя. Гость живёт, пока жива сессия
// браузера, — сервер для этого не нужен. Машина шагов (tourMachine) о хранилище не знает.
import { sequenceOf, type TourState, type TourVars } from "./tourMachine";
import { STEPS, type StepId } from "./tourSteps";

const PREFIX = "archmap_tour:";

export function tourKey(userId: string): string {
  return PREFIX + userId;
}

/** Сохранённый тур гостя или null — тогда тур запускается сам (первый вход). */
export function loadTour(userId: string): TourState | null {
  try {
    return parseTourState(localStorage.getItem(tourKey(userId)));
  } catch {
    return null;
  }
}

export function saveTour(userId: string, state: TourState): void {
  try {
    localStorage.setItem(tourKey(userId), JSON.stringify(state));
  } catch {
    // хранилище недоступно (приватный режим) — тур живёт до перезагрузки
  }
}

/** Туры прежних гостей этого браузера: их песочниц уже нет. */
export function dropStaleTours(userId: string): void {
  try {
    const keep = tourKey(userId);
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX) && key !== keep) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // нечего чистить
  }
}

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
  if (o.status !== "running" && o.status !== "paused" && o.status !== "done") return null;
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
  const state: TourState = { status: o.status, step, variant: o.variant, dir: o.dir === -1 ? -1 : 1, vars };
  const p = o.pause;
  if (state.status === "paused" && p && typeof p === "object") {
    const at = p as Record<string, unknown>;
    if (typeof at.step === "string" && STEP_IDS.has(at.step) && typeof at.hash === "string") {
      state.pause = { step: at.step as StepId, hash: at.hash };
      if (typeof at.level === "string" || at.level === null) state.pause.level = at.level;
    }
  }
  return state;
}

