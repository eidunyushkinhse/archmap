// Шина событий тура (docs/tasks/demo-tour.md). Продукт сообщает сюда об успешных
// действиях пользователя — одной строкой из уже существующих обработчиков успеха,
// без знания о шагах. Слушает только тур демо-стенда; вне демо слушателей нет и
// вызов ничего не делает. Что с событием делать — решает машина тура (tourMachine.ts).

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

type Listener = (e: TourBusEvent) => void;
const listeners = new Set<Listener>();

export function emitTourEvent(e: TourBusEvent): void {
  for (const listener of listeners) listener(e);
}

export function onTourEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
