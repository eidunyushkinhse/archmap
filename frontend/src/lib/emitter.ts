// Событие вне React: подписка возвращает отписку, emit будит всех подписчиков.
// Одна реализация вместо девяти ручных Set слушателей (аудит F-23: шина и сторы тура,
// «кто я», сигналы 401 общего клиента, признак «нет связи»). Подписчик, отписавшийся
// посреди emit, больше не вызывается; добавленный посреди emit — вызывается (порядок
// обхода Set).

export interface Emitter<T> {
  emit: (value: T) => void;
  on: (listener: (value: T) => void) => () => void;
}

export function createEmitter<T = void>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    emit: (value) => {
      for (const listener of listeners) listener(value);
    },
    on: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
