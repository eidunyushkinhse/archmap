// Ленивая загрузка «один раз на приложение» с повтором после отказа: тяжёлые чанки
// (mermaid, swagger-ui) грузятся при первом обращении, а удачный результат кэшируется.
// Отказ НЕ кэшируется (аудит R-7): иначе после выката, когда старый чанк пропал с
// сервера, вкладка до F5 считала бы рендерер сломанным навсегда; следующее обращение
// пробует снова. О самом выкате скажет плашка UpdateNotice.

export interface LazyOnce<T> {
  (): Promise<T>;
  // Был ли успешный результат (для статуса «загрузка…» первого рендера).
  readonly ready: () => boolean;
  // Шёл ли или идёт хотя бы один запрос, ещё не отказавший.
  readonly started: () => boolean;
}

export function lazyOnce<T>(load: () => Promise<T>): LazyOnce<T> {
  let pending: Promise<T> | null = null;
  let done = false;
  const get = (): Promise<T> => {
    pending ??= load().then(
      (value) => {
        done = true;
        return value;
      },
      (err: unknown) => {
        pending = null;
        throw err;
      },
    );
    return pending;
  };
  return Object.assign(get, { ready: () => done, started: () => pending !== null });
}
