// Хранение тура: состояние (пройден/пропущен, на паузе, текущий шаг, имена созданных
// объектов) в localStorage по id гостя. Гость живёт, пока жива сессия браузера, —
// сервер для этого не нужен. Здесь же связь с пилюлей «Обучение» в шапке: сигналы
// «пройти заново» и «продолжить», признак «тур на паузе».
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
const restartListeners = new Set<() => void>();

export function requestTourRestart(): void {
  for (const listener of restartListeners) listener();
}

export function onTourRestart(listener: () => void): () => void {
  restartListeners.add(listener);
  return () => { restartListeners.delete(listener); };
}

// ── Пауза: «Продолжить обучение» (пилюля, пока тур на паузе) ────────────────
const resumeListeners = new Set<() => void>();

export function requestTourResume(): void {
  for (const listener of resumeListeners) listener();
}

export function onTourResume(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => { resumeListeners.delete(listener); };
}

// Тур на паузе — внешний стор для пилюли (её шапки тур не рендерит).
let paused = false;
const pausedListeners = new Set<() => void>();

export function setTourPaused(value: boolean): void {
  if (paused === value) return;
  paused = value;
  for (const listener of pausedListeners) listener();
}

export function getTourPaused(): boolean {
  return paused;
}

export function subscribeTourPaused(listener: () => void): () => void {
  pausedListeners.add(listener);
  return () => { pausedListeners.delete(listener); };
}

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
