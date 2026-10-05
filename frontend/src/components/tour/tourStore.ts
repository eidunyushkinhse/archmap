// Хранение тура: состояние (пройден/пропущен, текущий шаг, имена созданных объектов)
// в localStorage по id гостя. Гость живёт, пока жива сессия браузера, — сервер для
// этого не нужен. Здесь же сигнал «пройти заново» от пилюли «Обучение» в шапке.
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
