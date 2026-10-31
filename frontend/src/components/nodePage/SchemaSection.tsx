// Секция «Схема» страницы объекта (аудит F-5: вынесена из NodePage без изменений).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AncestorRef, GraphResponse, Node, ViewLayoutPayload } from "../../types";
import { canHaveChildren } from "../../types";
import { nodesApi } from "../../api/nodes";
import { childIsComponent } from "../element/elementView";
import { usePersistenceHost } from "../../pages/usePersistenceHost";
import LoadError from "../../ui/LoadError";
import { useRemoteSync } from "../../pages/useRemoteSync";
import { useToast } from "../../pages/useToast";
import EmbeddedSchemaBlock from "../EmbeddedSchemaBlock";
import { readSchemaView, showStatusControls, writeSchemaView, type SchemaView } from "../schemaView";
import type { LevelPersistenceProps, NavigateMap, ViewMetaRef } from "../graph/types";
import { hasNoNeighbors, mergeViewLayout, schemaSectionHeight, toLevelEdges, visibleEntityGuess, withOwnEdits } from "../pageSchema";
import "../../ui/smallButton.css";
import { remoteToastStyle } from "../../ui/remoteToast";

// ── Секция «Схема» (single-schema) ──────────────────────────────────
// Контекст объекта как ВИРТУАЛЬНЫЙ КОРНЕВОЙ УРОВЕНЬ. Бэкенд (context-graph)
// отдаёт его в формате СЫРОГО графа уровня: локалы = фокус + представители
// соседей (связанные сиблинги), рёбра сырые, реестр концов с цепочками предков.
// Раскладка — СОХРАНЁННЫЙ вид фокуса (context-graph отдаёт layout вида node.id +
// его версию; первый вход без записей → свежий ELK). Рендерит штатный level-
// конвейер без единой контекстной ветки; отличия от «отдельного проекта» — только
// рамки реальных предков (ancestorIds) и цвета по реальной глубине (depth).
// Архитектору доступна расстановка (драг + персист в вид фокуса, arrangeOnly);
// структурная правка (создание/удаление) и наблюдатель — read-only, создание
// связей — в редакторе-карте; мета существующих связей (концы, направление,
// описание, технология) правится со страницы модалкой-редактором (EdgeEditModal).
export default function SchemaSection({
  node,
  ancestors,
  isArchitect,
  onNavigateNode,
  onNavigateMap,
  onNodeChanged,
  viewMeta,
  mutationToken,
}: {
  node: Node;
  ancestors: AncestorRef[];
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onNavigateMap?: NavigateMap;
  // Узел изменён в другой сессии — страница освежает свои данные и показывает
  // тост «Данные обновлены в другой сессии». Зовётся ОБОИМИ курсорами: meta_rev
  // (атрибуты/доки/спеки) и graph_rev (структурные имя/форма, V48).
  onNodeChanged?: () => void;
  // Общий с страницей курсор конкурентности (страница тихо обновляет его после
  // СВОИХ записей — echo-suppression, V53).
  viewMeta: ViewMetaRef;
  // Токен мутации страницы (правка связи в EdgeEditModal): изменившиеся стрелки
  // перерисовываются анимированно (окно мутаций, AN28а).
  mutationToken: number;
}) {
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { writeSchemaView(schemaView); }, [schemaView]);

  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Последний отказ чтения схемы. Показывается, только пока схемы на экране нет
  // (первичная загрузка, аудит R-2): раньше секция молча пропадала.
  const [failure, setFailure] = useState<unknown>(null);
  // Курсоры изменений для remote-sync И fence персиста: context-graph несёт
  // version (вид фокуса) / graph_rev / meta_rev; рефетч обновляет курсоры. Свои
  // записи раскладки (архитектор) обновляют курсор из ответа PUT — поллинг не даёт
  // ложного тоста; чужие правки узла давятся сверкой содержимого в onNodeChanged.
  const metaCursorRef = viewMeta; // алиас: eslint разрешает писать только в *Ref
  // Флаг «идёт жест драга» для поллинга (рефетч не врывается в жест): его же
  // ставит/снимает канвас через бандл персиста (архитектор).
  const gestureActiveRef = useRef(false);
  const [remoteToast, showRemoteToast] = useToast();

  const refetch = useCallback((): Promise<void> => {
    return nodesApi.getContextGraph(node.id)
      .then((g) => {
        metaCursorRef.current = { version: g.version, graphRev: g.graph_rev, metaRev: g.meta_rev };
        setGraph(g);
        setFailure(null);
        setLoading(false);
      })
      .catch((e: unknown) => { setFailure(e); setLoading(false); });
  }, [node.id, metaCursorRef]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка данных схемы
    setLoading(true);
    refetch();
  }, [refetch]);

  // Поллинг удалённых изменений (как в редакторе-карте): graph_rev вырос →
  // тихий рефетч контекста + тост «Схема обновлена в другой сессии»; meta_rev
  // вырос → освежение узла (тост «Данные обновлены» — хозяин страница).
  useRemoteSync({
    currentParentId: null,
    viewMeta: metaCursorRef,
    gestureActiveRef,
    onRemoteChange: () => {
      refetch();
      showRemoteToast();
      // Структурные поля узла (имя/форма) двигают graph_rev, а НЕ meta_rev (V48):
      // без этого зова чужая смена имени/типа перерисовывала схему, а «Свойства»
      // страницы оставались старыми до перезахода. Канал тот же (сверка свежего
      // узла по version+сигнатуре), поэтому лишнего тоста своя правка не даёт.
      onNodeChanged?.();
    },
    onMetaChange: onNodeChanged
      ? (rev) => {
          metaCursorRef.current = { ...metaCursorRef.current, metaRev: rev };
          onNodeChanged();
        }
      : undefined,
  });

  // ── Персист раскладки вида фокуса (архитектор) ────────────────────
  // Зеркало записанных значений: канвас шлёт сохранённые батчи, кладём их в
  // graph.layout — база дедупа/merge остаётся истиной (иначе «драг назад в исходную»
  // гасился бы дедупом о протухшее зеркало). Спред меняет только layout — ссылки
  // nodes/endpoints/edges те же, конвейер раскладки не перезапускается.
  const handleLayoutChanged = useCallback(
    (items: Record<string, ViewLayoutPayload | null>) => {
      setGraph((g) => (g ? { ...g, layout: mergeViewLayout(g.layout, items) } : g));
    },
    [],
  );

  // Ресинк при ошибке персиста и переигровка 409 (вид фокуса изменён другой
  // сессией): перечитать контекст — курсоры и раскладка к истине.
  const host = usePersistenceHost(refetch);

  // Бандл персиста — только архитектору; наблюдателю undefined → блок read-only
  // (без драга), раскрытия стартуют свёрнутыми (ignorePersistedExpanded).
  const persistence = useMemo<LevelPersistenceProps | undefined>(() => {
    if (!isArchitect) return undefined;
    return {
      onLayoutChanged: handleLayoutChanged,
      onPersistError: host.resync,
      onPersistConflict: host.onConflict,
      retryPatch: host.retryPatch,
      viewMeta: metaCursorRef,
      gestureActiveRef,
    };
  }, [isArchitect, handleLayoutChanged, host.resync, host.onConflict, host.retryPatch, metaCursorRef]);

  // «Переразложить»: сброс раскладки вида фокуса → рефетч (свежий ELK). Реф-замок
  // от повторных кликов (relayout идемпотентен, но незачем спамить ресинками).
  const relayoutInflight = useRef(false);
  // Токен свершившегося сброса: блок схемы анимирует переезд на авто-позиции.
  const [relayoutToken, setRelayoutToken] = useState(0);
  const handleRelayout = useCallback(() => {
    if (relayoutInflight.current) return;
    relayoutInflight.current = true;
    nodesApi.relayoutContext(node.id)
      .then(() => { setRelayoutToken((t) => t + 1); refetch(); })
      .finally(() => { relayoutInflight.current = false; });
  }, [node.id, refetch]);

  // ДАННЫЕ СХЕМЫ = ответ сервера + СВОИ правки меты, влитые точечно (withOwnEdits,
  // context.md X20): страница уже держит свежий узел (patch.node — ответ PATCH), и
  // схема показывает новые форму/имя/статус/принадлежность СРАЗУ, без перезагрузки и без
  // ремаунта холста. Производное — в рендере (useMemo), не эффектом: зеркалирование
  // пропа в стейт разъезжается. Идентичность меняется ровно тогда, когда меняется
  // граф или сам узел (тот же профиль, что у edges ниже).
  const view = useMemo<GraphResponse | null>(
    () => (graph ? withOwnEdits(graph, node) : null),
    [graph, node],
  );

  // Рёбра уровня из GraphResponse (тот же маппинг, что у остальных потребителей
  // графа уровня — pageSchema.toLevelEdges). Мемоизация: toLevelEdges создаёт новый
  // массив при каждом вызове; без мемоизации проп edges менялся бы на каждый рендер
  // (зеркало раскладки меняет только graph.layout, не nodes/endpoints/edges) и
  // пересоздавал computeNow в LevelGraph — конвейер стартовал бы в промежуточном
  // рендере со старым viewLayout, вызывая визуальный откат узла при отпускании драга.
  const edges = useMemo(() => (view ? toLevelEdges(view) : []), [view]);

  if (loading) return <p className="np-empty">Загрузка схемы…</p>;
  if (!view) {
    if (failure === null) return null;
    return (
      <LoadError what="схему" error={failure}
        onRetry={() => { setLoading(true); void refetch(); }} />
    );
  }

  // «Внешних связей нет»: кроме фокуса нет ни локалов-представителей, ни гостей
  // вне его поддерева (глубокие концы внутренних рёбер несут фокус в предках).
  if (hasNoNeighbors(view, node.id) && !node.has_children) {
    // Пустое состояние: секцию не прячем; архитектору — CTA в редактор-карту
    // (наполнить состав / создать связи — правка живёт только там).
    return (
      <div className="np-empty" style={{ textAlign: "center" }}>
        Внешних связей нет — объект пока не взаимодействует с соседями.
        <br />
        <span style={{ fontSize: 12, color: "#b0bec5" }}>Связи создаются в редакторе-карте</span>
        {isArchitect && onNavigateMap && (
          <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "center" }}>
            {/* Подпись называет, кем станет новый объект: компонентом — у контейнера и
                внутри контейнера, иначе вложенным объектом (системой или контейнером он
                станет по ответу в окне первого вложенного объекта). */}
            {canHaveChildren(node.shape) && (
              <button className="btn-sm-primary" onClick={() => onNavigateMap(node.id)}>
                {childIsComponent(node) ? "Добавить компонент" : "Добавить вложенный объект"}
              </button>
            )}
            <button
              className="btn-sm-primary"
              onClick={() => onNavigateMap(node.parent_id ?? null, { locate: node.id, ret: `node:${node.id}` })}
            >
              Открыть в карте
            </button>
          </div>
        )}
      </div>
    );
  }

  // Высота до замера ширины: по числу видимых сущностей (локалы + внешние гости).
  const height = schemaSectionHeight(visibleEntityGuess(view));
  // Признак проектный, с сервера: на схеме одного объекта статусов может не быть,
  // а в проекте переход идёт — переключатель вида нужен и здесь. Статусы читаем из
  // view: свежепоставленный «планируется» обязан включить фильтр сразу.
  const hasStatusInfo = showStatusControls(view.has_status_info, view.nodes, view.endpoints);

  // «Редактировать» / «Открыть в карте» → родительский слой + подсветка + возврат (Ф11/Ф12).
  const onEdit = onNavigateMap
    ? () => onNavigateMap(node.parent_id ?? null, { locate: node.id, ret: `node:${node.id}` })
    : undefined;

  return (
    <div style={{ position: "relative" }}>
      {remoteToast && <div style={remoteToastStyle}>Схема обновлена в другой сессии</div>}
      <EmbeddedSchemaBlock
        nodes={view.nodes}
        endpoints={view.endpoints}
        edges={edges}
        viewLayout={view.layout}
        containerId={node.parent_id ?? null}
        layoutViewId={node.id}
        persistence={persistence}
        ancestorNames={ancestors.map((a) => a.name)}
        ancestorIds={ancestors.map((a) => a.id)}
        ancestorElements={ancestors.map((a) => a.element_effective)}
        ancestorExternals={ancestors.map((a) => a.is_external)}
        depth={ancestors.length}
        isArchitect={isArchitect}
        schemaView={schemaView}
        onSchemaViewChange={setSchemaView}
        onNavigateNode={onNavigateNode}
        onEdit={onEdit}
        onRelayout={handleRelayout}
        relayoutToken={relayoutToken}
        mutationToken={mutationToken}
        height={height}
        showViewFilter={hasStatusInfo}
      />
    </div>
  );
}

// Тост «схема обновлена в другой сессии» (remote-sync) — поверх окна схемы.
