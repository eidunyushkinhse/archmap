// ПАМЯТЬ УЖЕ ПОСЧИТАННЫХ СЦЕН (эпик render-scale, шаг «быстрый ELK и один прогон»; спека
// perf.md P11, слой «память сцен»).
//
// ЗАЧЕМ. Конвейер умеет «входы роутинга совпали по битам с прошлым прогоном (routeSig) →
// маршруты, хэндлы и плашки целиком из prev», но prev один: свернул контейнер — prev уже
// свёрнутая сцена, и повторное раскрытие считало стрелки заново (живой замер: hub25 351 мс,
// Sentry 1,6 с, hub50 2,5 с). Кэш маршрутов вида (P11, localStorage) держит одну запись на
// вид, и её затирает следующая сцена того же вида. Память держит последние
// ROUTE_MEMORY_SIZE авторитетных результатов по ключу routeSig: прогон, у которого prev по
// сигнатуре не совпал, а сцена в памяти есть, берёт результат той же веткой кэш-хита.
//
// ГДЕ ЖИВЁТ. Не в модуле конвейера: computeViewLayout остаётся функцией своего входа, память
// ему передаёт вызывающий вторым параметром (воркер — свою, одну на страницу). Корпус и тесты
// гоняют конвейер без памяти — скрытого состояния между прогонами нет.
//
// ЧТО ПОПАДАЕТ. Только авторитетный результат (PipelineOutput.authoritative — не скоуплен, не
// деградировал по бюджету, полный состав). ROUTER_VERSION в ключе не нужен: память живёт не
// дольше страницы. Размер ограничен числом записей, вытеснение — давнее обращение первым.
//
// ЗЕРКАЛО В КЛИЕНТЕ. Клиент воркера (pipelineClient) ведёт копию по ответам воркера (те же
// авторитетные результаты в том же порядке) и засевает ею свежий воркер, когда старый
// оборван: обрыв устаревшего расчёта не стирает уже посчитанные сцены.
import type { EdgePoint } from "../../../types";
import type { LabelPlacement } from "./labelLayout";

/** Результат стадий качества стрелок одной сцены — то, что отдаёт ветка кэш-хита. */
export interface RouteMemoryEntry {
  routes: Map<string, EdgePoint[]>;
  handles: Map<string, { sourceHandle: string; targetHandle: string }>;
  labels: Map<string, LabelPlacement>;
}

export interface RouteMemory {
  /** запись сцены с этой сигнатурой (обращение освежает её в очереди вытеснения) */
  get(sig: string): RouteMemoryEntry | undefined;
  /** положить авторитетный результат сцены; сверх предела вытесняется давняя запись */
  put(sig: string, entry: RouteMemoryEntry): void;
  /** все записи от давней к свежей (засев свежего воркера) */
  entries(): [string, RouteMemoryEntry][];
}

/** Сколько сцен помнит воркер: раскрытие и сворачивание нескольких контейнеров, уровни туда и обратно. */
export const ROUTE_MEMORY_SIZE = 8;

export function createRouteMemory(limit: number = ROUTE_MEMORY_SIZE): RouteMemory {
  // Map хранит порядок вставки: первая запись — давнее всего тронутая
  const store = new Map<string, RouteMemoryEntry>();
  return {
    get(sig) {
      const e = store.get(sig);
      if (e) {
        store.delete(sig);
        store.set(sig, e);
      }
      return e;
    },
    put(sig, entry) {
      store.delete(sig);
      store.set(sig, entry);
      while (store.size > limit) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    entries: () => [...store.entries()],
  };
}
