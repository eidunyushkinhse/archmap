// Шина событий тура (docs/tasks/demo-tour.md). Продукт сообщает сюда об успешных
// действиях пользователя — одной строкой из уже существующих обработчиков успеха,
// без знания о шагах. Слушает только тур демо-стенда; вне демо слушателей нет и
// вызов ничего не делает. Что с событием делать — решает машина тура (tourMachine.ts).

import { createEmitter } from "../../lib/emitter";

export type TourBusEvent =
  /** создан объект (окно «Новый объект») */
  | { type: "node-created"; id: string; name: string; shape: string; parentId: string | null }
  /** создана связь (окна создания связи в редакторе) */
  | { type: "edge-created"; id: string; sourceId: string; targetId: string }
  /** конец связи перевешен с рамки на узел внутри неё и сохранён */
  | { type: "edge-reconnected"; fromId: string; toId: string }
  /** узел раскрыт лупой прямо на схеме */
  | { type: "node-expanded"; id: string }
  /** драг узлов закончен с записью новых позиций */
  | { type: "node-drag-end"; ids: string[] }
  /** редактор показал слой (null — корень проекта): вход на слой и возврат наверх */
  | { type: "level"; levelId: string | null };

const events = createEmitter<TourBusEvent>();
export const emitTourEvent = events.emit;
export const onTourEvent = events.on;

// ── Обратная команда: тур просит редактор открыть слой ──────────────────────
// «Продолжить обучение» возвращает на слой схемы, где взяли паузу
// (docs/tasks/demo-tour-pause.md). Слой в хэше бывает только при открытии редактора,
// дальше его знает сам редактор — поэтому просьба идёт через шину.
const levelRequests = createEmitter<string | null>();
export const requestTourLevel = levelRequests.emit;
export const onTourLevelRequest = levelRequests.on;

// ── Обратная команда: тур ведёт камеру холста ───────────────────────────────
// Лупа на объекте мелкая, когда слой отдалён (тачпадом в неё трудно попасть) — на входе
// в шаг тур просит показать объект крупно; после раскрытия лупой — отвести камеру ко
// всему слою, чтобы было видно, к чему привело нажатие. Редактор исполняет это тем же
// locate, что и «Показать на схеме», без вспышки.
export type TourFocus = { kind: "node"; id: string } | { kind: "level" };
const focusRequests = createEmitter<TourFocus>();
export const requestTourFocus = focusRequests.emit;
export const onTourFocusRequest = focusRequests.on;

// ── Признак «тур идёт» ──────────────────────────────────────────────────────
// Окно первого вложенного объекта (components/element) во время тура не показывается:
// сюжет тура — «Моя система», в которую бросают сервис, становится системой, и элемент
// пишется явно, без вопроса. Признак ставит эффект DemoTour; читают его в момент
// действия, поэтому пропсы через все страницы не нужны.
let tourRunning = false;
export function setTourRunning(running: boolean): void {
  tourRunning = running;
}
export function isTourRunning(): boolean {
  return tourRunning;
}
