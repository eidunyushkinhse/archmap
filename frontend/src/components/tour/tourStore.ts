// Хранение тура: состояние (пройден/пропущен, на паузе, текущий шаг, имена созданных
// объектов) в localStorage по id гостя. Гость живёт, пока жива сессия браузера, —
// сервер для этого не нужен. Здесь же связь с пилюлей «Обучение» в шапке: сигналы
// «пройти заново» и «продолжить», признак «тур на паузе».
import { createEmitter } from "../../lib/emitter";
import { parseTourState, type TourState } from "./tourMachine";

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

// ── «Пройти обучение заново» (пилюля «Обучение») ────────────────────────────
const restart = createEmitter();
export const requestTourRestart = (): void => { restart.emit(); };
export const onTourRestart = restart.on;

// ── Пауза: «Продолжить обучение» (пилюля, пока тур на паузе) ────────────────
const resume = createEmitter();
export const requestTourResume = (): void => { resume.emit(); };
export const onTourResume = resume.on;

// Тур на паузе — внешний стор для пилюли (её шапки тур не рендерит).
let paused = false;
const pausedChanged = createEmitter();

export function setTourPaused(value: boolean): void {
  if (paused === value) return;
  paused = value;
  pausedChanged.emit();
}

export function getTourPaused(): boolean {
  return paused;
}

export const subscribeTourPaused = pausedChanged.on;

// Клик по затемнению: карточка шага уходит не угасанием, а сворачивается в пилюлю —
// видно, куда нажать, чтобы продолжить. Признак забирает уходящая карточка (TourLayer).
let exitToPill = false;

export function markExitToPill(): void {
  exitToPill = true;
}

export function takeExitToPill(): boolean {
  const value = exitToPill;
  exitToPill = false;
  return value;
}
