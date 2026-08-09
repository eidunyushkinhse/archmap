// ЕДИНЫЙ канал записи раскладки вида (R3) для канваса уровня. Вынесено из
// LevelGraph.tsx (Фаза 3в-А): тела commitLayout/persistFenced и их latest-ref/
// очередные паттерны живут здесь, LevelGraphInner продолжает оркестровать хук.
//
// commitLayout: merge-патч поверх зеркала viewLayout → батч-PUT view_layout +
// зеркало родителю (onLayoutChanged). Сервер заменяет payload строки ЦЕЛИКОМ,
// поэтому частичный патч мержится здесь; null-патч — удалить строку (сброс в
// авто); null-ПОЛЕ в патче попадает в merged, сервер выкидывает его как None
// (exclude_none) — сброс отдельного поля.
// Возвращает, была ли запись: false — весь батч погашен дедупом/гардами, смены
// viewLayout (и пересчёта раскладки) НЕ будет — по этому сигналу dragStop
// откатывает живое превью рёбер (liveDragHandles.restore).
//
// Фенсированный персист (этап 0 конкурентности): запись несёт base_version
// вида; устаревшая (вид изменён другой сессией) → 409 → политика
// planPersistFailure: user-интент после ресинка переигрывается ОДИН раз
// исходным патчем (merge заново, уже от свежего зеркала), derived-интент
// выбрасывается — пересчёт конвейера от свежих данных сам родит актуальное.
// Переигровку исполняет канал MapEditorPage (onPersistConflict → проп retryPatch,
// см. комментарий к пропу LevelGraph); без канала (не передан) — деградация до ресинка.
// ОЧЕРЕДЬ фенсированных записей: батчи одной сессии идут СТРОГО по одному —
// base_version читается в момент СТАРТА задачи (после ответа предыдущей), а не
// постановки. Без очереди параллельные свои же батчи делили одну версию и
// ловили самоконфликт 409 → ресинк («вспышка» исходной картинки посреди
// анимации раскрытия; репро: spawn-probe --relayout-first --slow-layout —
// после «Переразложить» массовый derived-засев уровня висит в полёте, а клик
// раскрытия уезжает с той же версией). Fence остаётся против ЧУЖИХ сессий.
import { useCallback, useEffect, useRef } from "react";
import { viewsApi } from "../../../api/nodes";
import { isConflict } from "../../../api/client";
import type { ViewLayout, ViewLayoutPayload } from "../../../types";
import type { ViewMetaState } from "../types";
import { planPersistFailure, type CommitOrigin } from "./persistGuard";

interface UseLevelPersistenceArgs {
  containerId: string | null;
  isArchitect: boolean;
  // персист раскладки разрешён (arrangeOnly || !readOnly); структурная правка — отдельно
  canArrange: boolean;
  // зеркало раскладки вида (единое хранилище view_layout) — база дедупа и merge
  viewLayout: ViewLayout;
  // фоновый персист упал — родитель возвращает зеркало к истине (ресинк уровня)
  onPersistError?: (e: unknown) => void | Promise<void>;
  // канал переигровки 409 user-батча: исходный патч уходит НАВЕРХ, ресинк + возврат
  // пропом retryPatch (см. комментарий к пропу LevelGraph)
  onPersistConflict?: (patch: Record<string, Partial<ViewLayoutPayload> | null>) => void;
  // зеркало записанных значений родителю (ЕДИНСТВЕННЫЙ канал зеркалирования раскладки)
  onLayoutChanged?: (items: Record<string, ViewLayoutPayload | null>) => void;
  // живой снимок версий (fence записей): читается при каждой записи, обновляется из PUT
  viewMeta?: { current: ViewMetaState };
  // запрос переигровки 409 user-батча (одноразов по token)
  retryPatch?: { patch: Record<string, Partial<ViewLayoutPayload> | null>; token: number } | null;
}

export interface LevelPersistence {
  // Единая запись раскладки: дедуп+merge поверх зеркала → PUT + зеркало родителю.
  // origin "derived" при 409 НЕ переигрывается (конвейер пересчитает сам).
  commitLayout: (
    patch: Record<string, Partial<ViewLayoutPayload> | null>,
    origin?: CommitOrigin,
    isRetry?: boolean,
  ) => boolean;
  // Стабильная обёртка для долгоживущих замыканий (команды undo/redo): всегда зовёт
  // СВЕЖИЙ commitLayout (дедуп сравнивает с актуальным зеркалом, а не со снимком).
  commitLayoutStable: (patch: Record<string, Partial<ViewLayoutPayload> | null>) => boolean;
}

export function useLevelPersistence({
  containerId,
  isArchitect,
  canArrange,
  viewLayout,
  onPersistError,
  onPersistConflict,
  onLayoutChanged,
  viewMeta,
  retryPatch,
}: UseLevelPersistenceArgs): LevelPersistence {
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const persistFenced = useCallback(
    (
      items: Record<string, ViewLayoutPayload | null>,
      patch: Record<string, Partial<ViewLayoutPayload> | null>,
      origin: CommitOrigin,
      isRetry: boolean,
    ): void => {
      persistChainRef.current = persistChainRef.current.then(() =>
        viewsApi
          .saveLayout(containerId, items, viewMeta?.current.version)
          .then((res) => {
            if (viewMeta) viewMeta.current = { version: res.version, graphRev: res.graph_rev };
          })
          .catch((e: unknown) => {
            console.error("Запись раскладки не прошла — ресинхронизирую уровень из БД", e);
            if (
              planPersistFailure(isConflict(e), origin, isRetry) === "retry-after-resync" &&
              onPersistConflict
            ) {
              onPersistConflict(patch); // ресинк + возврат патча пропом — наверху
              return;
            }
            void onPersistError?.(e);
          }),
      );
    },
    [containerId, onPersistError, onPersistConflict, viewMeta],
  );
  const commitLayout = useCallback(
    (
      patch: Record<string, Partial<ViewLayoutPayload> | null>,
      origin: CommitOrigin = "user",
      isRetry = false,
    ): boolean => {
      if (!isArchitect || !canArrange) return false;
      // Нормализация payload для сравнения с зеркалом: null-поля эквивалентны
      // отсутствию (сервер выкидывает их exclude_none).
      const norm = (v: ViewLayoutPayload | null | undefined): string => {
        if (v == null) return "null";
        const entries = Object.entries(v).filter(([, x]) => x != null);
        entries.sort(([a], [b]) => (a < b ? -1 : 1));
        return JSON.stringify(entries);
      };
      const items: Record<string, ViewLayoutPayload | null> = {};
      for (const [k, p] of Object.entries(patch)) {
        const merged = p === null ? null : { ...(viewLayout[k] ?? {}), ...p };
        // ДЕДУП: значение не отличается от зеркала → не пишем и не дёргаем
        // родителя. Это рубильник петель самоподдержки: повторяющийся интент
        // (тот же сид/миграция каждый прогон) не перезапускает раскладку.
        if (norm(merged) === norm(viewLayout[k])) continue;
        items[k] = merged;
      }
      if (Object.keys(items).length === 0) return false;
      persistFenced(items, patch, origin, isRetry);
      onLayoutChanged?.(items);
      return true;
    },
    [isArchitect, canArrange, viewLayout, persistFenced, onLayoutChanged],
  );
  // Исполнитель переигровки 409 (проп retryPatch из MapEditorPage): одноразово (token)
  // коммитит исходный патч заново — commitLayout здесь из deps, т.е. замкнут на
  // СВЕЖЕЕ зеркало после ресинка (типично это уже НОВЫЙ маунт холста — ресинк
  // показывает «Загрузка…»); isRetry=true — второй 409 уже не переигрывается.
  const retryDoneRef = useRef(0);
  useEffect(() => {
    if (!retryPatch || retryPatch.token === retryDoneRef.current) return;
    retryDoneRef.current = retryPatch.token;
    commitLayout(retryPatch.patch, "user", true);
  }, [retryPatch, commitLayout]);
  // СТАБИЛЬНАЯ обёртка коммита для долгоживущих замыканий (команды undo/redo в
  // истории живут произвольно долго): всегда зовёт СВЕЖИЙ commitLayout. Иначе
  // дедуп выше сравнивал бы патч со СНИМКОМ viewLayout из момента создания
  // команды и гасил бы законную запись: Ctrl+Z перемещения молча не работал
  // (undo-патч «вернуть старую позицию» совпадает со старым зеркалом; сломано
  // дедупом cb2faad 2026-07-07, вскрыто смоуком Ф2 эпика плавности).
  const commitLayoutRef = useRef(commitLayout);
  useEffect(() => { commitLayoutRef.current = commitLayout; });
  const commitLayoutStable = useCallback(
    (patch: Record<string, Partial<ViewLayoutPayload> | null>) => commitLayoutRef.current(patch),
    [],
  );

  return { commitLayout, commitLayoutStable };
}
