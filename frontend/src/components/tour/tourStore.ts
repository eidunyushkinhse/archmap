// Связь тура с пилюлей «Обучение» в шапке: сигналы «пройти заново» и «продолжить»,
// признак «тур на паузе», уход карточки в пилюлю. Хранение тура — tourPersist.
import { createEmitter } from "../../lib/emitter";

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
