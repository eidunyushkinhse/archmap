import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { nodesApi } from "../api/nodes";
import type { Node, NodeShape } from "../types";
import { canHaveChildren, compareByRank, withoutPersons } from "../types";
import { ShapeGlyph, Chevron } from "./nodeTree.shared";
import { ChevronIcon, CollapseIcon, TreeIcon, PlusIcon } from "../ui/icons";
import "./NodeTreePanel.css";

/**
 * Боковая панель слева. Состоит из сворачиваемых секций (аккордеон, каждая
 * открывается/закрывается независимо):
 *  1. «Дерево узлов» — навигатор по иерархии (как было, в духе дерева Confluence);
 *  2. «Добавить узел» — палитра из четырёх шаблонов-форм (сервис/БД/брокер/
 *     пользователь). Архитектор перетаскивает пустой шаблон на схему: при отпускании
 *     открывается модалка создания узла уже с выбранной формой (поэтому в самой
 *     модалке поля «Отображение» больше нет). Видна только архитектору;
 *  3. «Бизнес-процессы» — заглушка под будущий раздел.
 *
 * Вся панель целиком сворачивается в узкую полосу футером-кнопкой внизу.
 */

// MIME-тип данных перетаскивания шаблона узла. На схеме (LevelGraph) по нему
// читается выбранная форма из dataTransfer.
export const NODE_DRAG_MIME = "application/archmap-node-shape";

/**
 * Дерево узлов отражает иерархию по parent_id. По умолчанию видны только корни;
 * детей подгружаем лениво по клику на шеврон. Клик по строке:
 *  - промежуточный узел (has_children) → провалиться на его слой ОСНОВНОЙ схемы
 *    (onDrillTo получает полный путь от корня до узла);
 *  - лист (детей нет) → открыть контекстную схему узла (onNodeContext).
 * Узлы-«пользователи» (shape: person) отсеиваются только в legacy-аккордеоне
 * (withoutPersons в nodeTree.shared): то дерево — навигатор детализации,
 * «провалиться» внутрь пользователя нечего. В плоском дереве (страницы/редактор)
 * персоны стоят в общей иерархии наравне с прочими объектами.
 */

interface Props {
  // клик по промежуточному узлу (есть дети) → провалиться на его слой основной схемы;
  // path — полный путь от корня до узла включительно
  onDrillTo?: (path: Node[]) => void;
  // клик по листу (детей нет) → открыть контекстную схему узла
  onNodeContext?: (node: Node) => void;
  // pages_pivot: клик по ЛЮБОМУ узлу → его страница (перекрывает onDrillTo/onNodeContext)
  onNodePage?: (node: Node) => void;
  // редактор-карта: клик по листу → показать на холсте (прыжок на слой узла,
  // выделение, locate). Включает тот же плоский дизайн, что и страничный режим
  // (поиск, «+», персоны, подсветка текущего узла), но клик навигирует внутри
  // редактора: контейнер → onDrillTo(path), лист → onPickLeaf(node).
  onPickLeaf?: (node: Node) => void;
  // pages_pivot: «+» на строке → создать дочерний объект (модалка, авто-позиция)
  onCreateChild?: (parentId: string) => void;
  // секция «Добавить узел» показывается только архитектору
  isArchitect: boolean;
  // начало/конец перетаскивания шаблона из палитры: shape при старте, null при
  // завершении. По нему схема рисует превью-рамку будущего узла под курсором.
  onTemplateDrag?: (shape: NodeShape | null) => void;
  // сигнал внешней перезагрузки дерева (инкремент после создания/удаления узла в
  // TreePage): дерево перечитывает корни и раскрытые ветки, не сворачиваясь.
  reloadToken?: number;
  // pages_pivot: id узла, чья страница СЕЙЧАС открыта (из ProjectShell.nodeId;
  // null — домашняя страница проекта). Дерево подсвечивает его строку и при смене
  // автоматически раскрывает ветку до этого узла (переход двойным кликом со схемы).
  currentNodeId?: string | null;
}

// Прозрачная 1×1 картинка вместо стандартного drag-image: прячем «снимок» плитки —
// вместо него схема показывает свою рамку-превью будущего узла (масштаб под зум).
const EMPTY_DRAG_IMG =
  typeof Image !== "undefined" ? new Image() : null;
if (EMPTY_DRAG_IMG) {
  EMPTY_DRAG_IMG.src =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
}

// Шаблоны узлов в палитре «Добавить узел»
const NODE_TEMPLATES: Array<{ shape: NodeShape; label: string }> = [
  { shape: "service", label: "Сервис" },
  { shape: "database", label: "База данных" },
  { shape: "broker", label: "Брокер" },
  { shape: "person", label: "Пользователь" },
];

// Мини-иконка формы узла (C4) для палитры — упрощённые SVG в духе NodeShapeSvg
function ShapeIcon({ shape }: { shape: NodeShape }) {
  const W = 40, H = 30, stroke = "#475569", fill = "#f1f5f9", sw = 1.4;
  const common = { fill, stroke, strokeWidth: sw };
  if (shape === "database") {
    const rx = (W - 4) / 2, ry = 5, cx = W / 2;
    return (
      <svg width={W} height={H} style={iconSvg}>
        <path d={`M2,${ry + 1} L2,${H - ry - 1} A${rx},${ry} 0 0 0 ${W - 2},${H - ry - 1} L${W - 2},${ry + 1} Z`} {...common} />
        <ellipse cx={cx} cy={ry + 1} rx={rx} ry={ry} {...common} />
      </svg>
    );
  }
  if (shape === "broker") {
    const rxc = 6, ryc = (H - 4) / 2;
    return (
      <svg width={W} height={H} style={iconSvg}>
        <path d={`M${rxc + 2},2 L${W - rxc - 2},2 A${rxc},${ryc} 0 0 1 ${W - rxc - 2},${H - 2} L${rxc + 2},${H - 2} A${rxc},${ryc} 0 0 1 ${rxc + 2},2 Z`} {...common} />
        <path d={`M${rxc + 2},2 A${rxc},${ryc} 0 0 1 ${rxc + 2},${H - 2}`} fill="none" stroke={stroke} strokeWidth={sw} />
      </svg>
    );
  }
  if (shape === "person") {
    // Карточка как у сервиса + мини-человечок слева (в духе аватара на узле)
    return (
      <svg width={W} height={H} style={iconSvg}>
        <rect x={2} y={3} width={36} height={24} rx={4} {...common} />
        <circle cx={11} cy={11.5} r={2.8} fill="none" stroke="#475569" strokeWidth={1.4} />
        <path d="M6 18.5 a 5 4.5 0 0 1 10 0" fill="none" stroke="#475569" strokeWidth={1.4} strokeLinecap="round" />
      </svg>
    );
  }
  // service — прямоугольник со скруглением
  return (
    <svg width={W} height={H} style={iconSvg}>
      <rect x={2} y={3} width={W - 4} height={H - 6} rx={4} {...common} />
    </svg>
  );
}

// Иконка корзины для оверлея отмены драга. Темнеет при наведении (drop = отмена).
function TrashIcon({ active }: { active: boolean }) {
  const c = active ? "#475569" : "#94a3b8";
  return (
    <svg
      width="34" height="34" viewBox="0 0 24 24" fill="none"
      stroke={c} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: "stroke 0.12s ease" }}
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

// Сворачиваемая секция аккордеона. ВАЖНО: объявлена на уровне модуля, а не внутри
// NodeTreePanel. Если объявлять внутри, у компонента на каждый рендер новая
// идентичность функции → React размонтирует и заново монтирует всё поддерево
// секции. Для палитры «Добавить узел» это критично: remount во время нативного
// drag уничтожал перетаскиваемый <div> и браузер отменял драг (плавающий баг
// «шаблон не берётся», особенно при быстром старте). Стабильный тип = палитра
// переиспользуется на месте, источник драга не пропадает.
function Section({ open, grow, title, onToggle, children }: {
  open: boolean; grow?: boolean; title: string;
  onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="nt-section" style={{ ...section, flex: grow && open ? 1 : "none" }}>
      <button className="nt-sechead" onClick={onToggle} title={open ? "Свернуть" : "Развернуть"}>
        <span>{title}</span>
        {/* SVG-шеврон у правого края, поворачивается на 90° при раскрытии секции. */}
        <span className={open ? "nt-secchev nt-secchev--open" : "nt-secchev"}><ChevronIcon /></span>
      </button>
      {open && <div style={sectionBody}>{children}</div>}
    </div>
  );
}

export default function NodeTreePanel({ onDrillTo, onNodeContext, onNodePage, onPickLeaf, onCreateChild, isArchitect, onTemplateDrag, reloadToken, currentNodeId }: Props) {
  // pages_pivot: плоское дерево без секций/палитры, с поиском, «+» и персонами
  const pagesMode = !!onNodePage;
  // редактор-карта: тот же плоский дизайн, но клик — навигация внутри редактора
  const editorMode = !!onPickLeaf;
  const flatMode = pagesMode || editorMode;

  const [roots, setRoots] = useState<Node[]>([]);
  const [loadingRoots, setLoadingRoots] = useState(true);
  // загруженные дети по id родителя (отсутствие ключа = ещё не грузили)
  const [childrenById, setChildrenById] = useState<Record<string, Node[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingId, setLoadingId] = useState<Set<string>>(new Set());
  // узлы, у которых has_children=true, но после отсева персон детей не осталось —
  // показываем их как листья, чтобы шеврон не раскрывался в пустоту
  const [leaves, setLeaves] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false); // свёрнута ли вся панель
  // идёт ли перетаскивание шаблона из палитры → панель закрывается «корзиной»
  const [dragging, setDragging] = useState(false);
  // курсор над «корзиной» (drop здесь = отмена) → подсветка активного состояния
  const [trashActive, setTrashActive] = useState(false);
  // синхронный флаг «идёт драг» — оверлей показываем отложенно (см. onTemplateDragStart),
  // а ref нужен, чтобы не зажечь его уже после завершения короткого драга
  const draggingRef = useRef(false);
  // открытые секции аккордеона (по умолчанию: дерево + палитра добавления)
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(["tree", "add"]),
  );
  const toggleSection = (key: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // ── Поиск (pages_pivot) ──────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Node[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Все загруженные узлы по id (корни + подгруженные дети). Чтобы узел был виден и
  // кликабелен в дереве, все его предки раскрыты → их Node-объекты уже здесь.
  const allById = useMemo(() => {
    const m = new Map<string, Node>();
    for (const r of roots) m.set(r.id, r);
    for (const kids of Object.values(childrenById)) for (const k of kids) m.set(k.id, k);
    return m;
  }, [roots, childrenById]);

  // Путь от корня до узла включительно (по цепочке parent_id среди загруженных узлов).
  const pathTo = (node: Node): Node[] => {
    const path: Node[] = [];
    const seen = new Set<string>();
    let cur: Node | undefined = node;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.unshift(cur);
      cur = cur.parent_id ? allById.get(cur.parent_id) : undefined;
    }
    return path;
  };

  // Единый клик строки в плоском дизайне: страница → переход на страницу объекта;
  // редактор → контейнер дрилнится на свой слой, лист показывается на холсте.
  const navigateFlat = (node: Node) => {
    if (onNodePage) { onNodePage(node); return; }
    if (canHaveChildren(node.shape) && node.has_children) onDrillTo?.(pathTo(node));
    else onPickLeaf?.(node);
  };

  // Персоны отсеиваются только в legacy-аккордеоне (дерево про детализацию);
  // в плоском дереве (страницы/редактор) стоят в общей иерархии наравне с прочими.
  const fitNodes = (ns: Node[]): Node[] => (flatMode ? ns : withoutPersons(ns)).sort(compareByRank);

  useEffect(() => {
    let alive = true;
    nodesApi
      .list(null)
      .then((ns) => { if (alive) setRoots(fitNodes(ns)); })
      .finally(() => { if (alive) setLoadingRoots(false); });
    return () => { alive = false; };
    // flatMode стабилен на время жизни компонента (определяется колбэками вызывающей
    // стороны); смена режима = перемонтаж, эффект перечитывает корни под новый режим.
  }, [flatMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Перезагрузка по внешнему сигналу (создан/удалён узел): перечитываем корни и
  // детей УЖЕ раскрытых веток, чтобы новый узел появился без сворачивания дерева.
  // Путь к нему не разворачиваем — если его родитель свёрнут, у того лишь появится
  // шеврон. expanded читаем снимком на момент сигнала (в deps не включаем).
  const reloadSkipRef = useRef(false);
  useEffect(() => {
    // первый прогон — это монтирование; корни грузит эффект выше, повтор не нужен
    if (!reloadSkipRef.current) { reloadSkipRef.current = true; return; }
    let alive = true;
    (async () => {
      const ns = fitNodes(await nodesApi.list(null));
      if (!alive) return;
      setRoots(ns);
      const ids = [...expanded];
      const fetched = await Promise.all(
        ids.map((id) =>
          nodesApi.getChildren(id)
            .then((k) => [id, fitNodes(k)] as const)
            .catch(() => [id, [] as Node[]] as const),
        ),
      );
      if (!alive) return;
      setChildrenById((prev) => {
        const next = { ...prev };
        for (const [id, kids] of fetched) next[id] = kids;
        return next;
      });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  // Поиск (pages_pivot / редактор): debounce 250ms, результат — плоский список совпадений.
  useEffect(() => {
    if (!flatMode) return;
    const q = searchQuery.trim().toLowerCase();
    if (!q) { setSearchResults(null); return; }
    setSearching(true);
    const timer = window.setTimeout(() => {
      nodesApi.search(searchQuery.trim())
        .then((ns) => setSearchResults(ns))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery, flatMode]);

  // ── Авто-раскрытие до текущей страницы (п.2) + подсветка (п.1) ────
  // Контейнер дерева (pages_pivot) — для скролла к подсвеченной строке.
  const treeScrollRef = useRef<HTMLDivElement>(null);
  // id узла, к которому уже скроллили (не дёргаем скролл повторно при каждом
  // изменении expanded/childrenById в ходе автораскрытия).
  const scrolledToRef = useRef<string | null>(null);

  // При смене открытой страницы раскрываем ветку до этого узла: обход вверх через
  // nodesApi.get (parent_id) собирает цепочку предков, затем сверху вниз догружаем
  // детей каждого предка (тем же путём, что и toggle) и раскрываем их. Ленивая
  // загрузка дерева при этом сохраняется — тянем только нужную ветку.
  useEffect(() => {
    if (!flatMode || !currentNodeId) return;
    let alive = true;
    void (async () => {
      // 1. Цепочка id от корня до текущего узла (включительно).
      const chain: string[] = [];
      const guard = new Set<string>();
      let curId: string | null = currentNodeId;
      while (curId && !guard.has(curId)) {
        guard.add(curId);
        chain.unshift(curId);
        const n: Node = allById.get(curId) ?? (await nodesApi.get(curId));
        if (!alive) return;
        curId = n.parent_id;
      }
      // 2. Предки (все, кроме самого узла) — раскрыть сверху вниз.
      for (const id of chain.slice(0, -1)) {
        if (!alive) return;
        let kids = childrenById[id];
        if (kids === undefined) {
          kids = fitNodes(await nodesApi.getChildren(id));
          if (!alive) return;
          setChildrenById((p) => ({ ...p, [id]: kids! }));
        }
        if (kids.length > 0) setExpanded((p) => new Set(p).add(id));
        else setLeaves((p) => new Set(p).add(id));
      }
    })();
    return () => { alive = false; };
    // allById/childrenById читаются снимком на момент смены страницы (свежесть не
    // критична: промах по кэшу = лишний fetch, не некорректность) — как в reload-эффекте.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNodeId, flatMode]);

  // Скролл к подсвеченной строке — когда узел стал видим (после автораскрытия).
  // Повторяем на изменениях expanded/childrenById, пока строка не появится; скроллим
  // один раз на узел (scrolledToRef).
  useEffect(() => {
    if (!currentNodeId) { scrolledToRef.current = null; return; }
    if (scrolledToRef.current === currentNodeId) return;
    const raf = requestAnimationFrame(() => {
      const el = treeScrollRef.current?.querySelector(".nt-row--current");
      if (el) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        scrolledToRef.current = currentNodeId;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [currentNodeId, expanded, childrenById]);

  // Раскрыть ветку (дети подгружаются лениво). Идемпотентна: уже раскрытую ветку
  // не сворачивает (сворачивание — только шевроном).
  async function expandBranch(node: Node) {
    const id = node.id;
    if (expanded.has(id)) return;
    let kids = childrenById[id];
    if (kids === undefined) {
      setLoadingId((p) => new Set(p).add(id));
      try {
        kids = fitNodes(await nodesApi.getChildren(id));
        setChildrenById((p) => ({ ...p, [id]: kids! }));
      } finally {
        setLoadingId((p) => { const n = new Set(p); n.delete(id); return n; });
      }
    }
    // После отсева персон показывать нечего (legacy) — помечаем узел листом
    if (kids.length === 0) {
      setLeaves((p) => new Set(p).add(id));
      return;
    }
    setExpanded((p) => new Set(p).add(id));
  }

  // Клик по шеврону: раскрыть/свернуть.
  async function toggle(node: Node) {
    if (expanded.has(node.id)) {
      setExpanded((p) => { const n = new Set(p); n.delete(node.id); return n; });
      return;
    }
    await expandBranch(node);
  }

  function Row({ node }: { node: Node }) {
    const id = node.id;
    const isExpanded = expanded.has(id);
    const isLoading = loadingId.has(id);
    const kids = childrenById[id] ?? [];
    // Контейнером (drill внутрь) может быть только сервис: у БД/брокера детей нет,
    // в дереве они — листья (без шеврона, клик → контекст), хотя сами видны.
    const drillable = canHaveChildren(node.shape);
    // шеврон скрываем, если все дети узла оказались персонами (узел стал листом)
    const hasChildren = drillable && node.has_children && !leaves.has(id);
    // pages_pivot: клик по любому узлу → его страница (единообразно).
    // редактор: контейнер → дрилл на слой, лист → показать на холсте.
    // В обоих режимах выбор узла с детьми РАСКРЫВАЕТ его ветку (дети видны
    // сразу, без отдельного клика по шеврону).
    // Старое поведение: промежуточный → слой, лист → контекст.
    const isIntermediate = drillable && node.has_children;
    const handler = flatMode
      ? () => { navigateFlat(node); if (isIntermediate) void expandBranch(node); }
      : isIntermediate
        ? (onDrillTo ? () => onDrillTo(pathTo(node)) : undefined)
        : (onNodeContext ? () => onNodeContext(node) : undefined);
    const title = !handler
      ? node.name
      : pagesMode
        ? `Страница: ${node.name}`
        : isIntermediate
          ? `Открыть слой: ${node.name}`
          : editorMode ? `Показать на схеме: ${node.name}` : `Контекст: ${node.name}`;
    // Текущая открытая страница — подсветка строки (п.1).
    const isCurrent = node.id === currentNodeId;
    return (
      <>
        <div
          className={
            (handler ? "nt-row nt-row--clickable" : "nt-row") +
            (isCurrent ? " nt-row--current" : "")
          }
          onClick={handler}
          title={title}
        >
          {hasChildren ? (
            <button
              // клик по «бережной зоне» раскрывает/сворачивает, не пуская событие на
              // строку (иначе провалились бы на слой). Зона широкая (26px, вся высота
              // строки), глиф визуально остаётся на месте — см. .nt-chevzone/.nt-chevhit.
              className="nt-chevzone"
              onClick={(e) => { e.stopPropagation(); toggle(node); }}
              title={isExpanded ? "Свернуть" : "Развернуть"}
              aria-label={isExpanded ? "Свернуть ветку" : "Развернуть ветку"}
              aria-expanded={isExpanded}
            >
              <span className="nt-chevhit">
                <span style={{ ...chevIcon, transform: isExpanded ? "rotate(90deg)" : "none" }}>
                  {isLoading ? "⋯" : <Chevron />}
                </span>
              </span>
            </button>
          ) : (
            <span className="nt-chevspacer" />
          )}
          <ShapeGlyph container={isIntermediate} shape={node.shape} />
          <span className={isIntermediate ? "nt-name nt-name--container" : "nt-name"}>
            {node.name}
          </span>
          {/* «+» — создать дочерний объект (pages_pivot / редактор, архитектор, только сервисы) */}
          {flatMode && isArchitect && onCreateChild && node.shape === "service" && (
            <button
              className="nt-add-child"
              onClick={(e) => { e.stopPropagation(); onCreateChild(node.id); }}
              title={`Создать объект внутри «${node.name}»`}
            >
              <PlusIcon />
            </button>
          )}
        </div>
        {/* Дети раскрытого узла — с направляющей вложенности (border-left). */}
        {isExpanded && kids.length > 0 && (
          <div className="nt-children">
            {kids.map((k) => <Row key={k.id} node={k} />)}
          </div>
        )}
      </>
    );
  }

  function onTemplateDragStart(e: DragEvent, shape: NodeShape) {
    e.dataTransfer.setData(NODE_DRAG_MIME, shape);
    e.dataTransfer.effectAllowed = "copy";
    // Прячем стандартный drag-image (снимок плитки) — превью рисует схема.
    if (EMPTY_DRAG_IMG) e.dataTransfer.setDragImage(EMPTY_DRAG_IMG, 0, 0);
    onTemplateDrag?.(shape);
    // ВАЖНО: оверлей-корзину показываем НЕ синхронно. Если смонтировать плитку
    // поверх карточки-источника прямо в обработчике dragstart, браузер отменяет
    // нативный drag (источник под курсором исчезает/накрывается). Откладываем на
    // следующий кадр — драг к этому моменту уже «схвачен» и накрытие безопасно.
    draggingRef.current = true;
    requestAnimationFrame(() => {
      if (draggingRef.current) setDragging(true);
    });
  }
  function onTemplateDragEnd() {
    onTemplateDrag?.(null);
    draggingRef.current = false;
    setDragging(false);
    setTrashActive(false);
  }

  // «Корзина» поверх панели во время драга шаблона. preventDefault на dragover
  // делает панель валидной зоной дропа → курсор перестаёт быть «запретным» красным
  // кругом над панелью. Дроп здесь ничего не создаёт (onDropNode зовётся только из
  // LevelGraph) — узел просто не сохраняется.
  function onTrashDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes(NODE_DRAG_MIME)) return;
    e.preventDefault();
    // dropEffect должен быть совместим с effectAllowed="copy", иначе вернётся
    // «запретный» курсор; "copy" даёт обычный курсор-плюс, не красный круг.
    e.dataTransfer.dropEffect = "copy";
    if (!trashActive) setTrashActive(true);
  }
  function onTrashDragLeave() {
    setTrashActive(false);
  }
  function onTrashDrop(e: DragEvent) {
    e.preventDefault(); // гасим драг над панелью — узел не создаётся
    setTrashActive(false);
  }

  return (
    <aside style={{ ...panel, width: collapsed ? PANEL_COLLAPSED_W : PANEL_W }}>
      {/* Свёрнутая панель — рейл с иконками секций: клик разворачивает панель и
          открывает соответствующую секцию (а не пустая полоса). */}
      {collapsed ? (
        <div style={rail}>
          <button
            className="nt-railbtn"
            title="Дерево объектов"
            onClick={() => { setCollapsed(false); setOpenSections((p) => new Set(p).add("tree")); }}
          >
            <TreeIcon />
          </button>
          {isArchitect && (
            <button
              className="nt-railbtn"
              title="Добавить объект"
              onClick={() => { setCollapsed(false); setOpenSections((p) => new Set(p).add("add")); }}
            >
              <PlusIcon />
            </button>
          )}
        </div>
      ) : (
      <div style={content}>
        {flatMode ? (
          /* ── pages_pivot / редактор: поиск + плоское дерево + персоны ─── */
          <>
            {/* Поиск */}
            <div style={searchWrap}>
              <input
                style={searchInput}
                type="text"
                placeholder="Поиск по имени…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button style={searchClear} onClick={() => setSearchQuery("")} title="Очистить">×</button>
              )}
            </div>

            {/* Результаты поиска или дерево */}
            <div ref={treeScrollRef} style={{ ...treeList, flex: 1, minHeight: 0, overflowY: "auto" }}>
              {searchResults !== null ? (
                searching ? (
                  <div style={hint}>Поиск…</div>
                ) : searchResults.length === 0 ? (
                  <div style={hint}>Ничего не найдено</div>
                ) : (
                  searchResults.map((n) => (
                    <div
                      key={n.id}
                      className="nt-row nt-row--clickable"
                      onClick={() => navigateFlat(n)}
                      title={pagesMode ? `Страница: ${n.name}` : canHaveChildren(n.shape) && n.has_children ? `Открыть слой: ${n.name}` : `Показать на схеме: ${n.name}`}
                    >
                      <span className="nt-chevspacer" />
                      <ShapeGlyph container={canHaveChildren(n.shape) && n.has_children} shape={n.shape} />
                      <span className="nt-name">{n.name}</span>
                    </div>
                  ))
                )
              ) : loadingRoots ? (
                <div style={hint}>Загрузка…</div>
              ) : roots.length === 0 ? (
                <div style={hint}>Нет объектов</div>
              ) : (
                roots.map((n) => <Row key={n.id} node={n} />)
              )}
            </div>

            {/* Палитра «Добавить объект» — только в редакторе; ЕДИНСТВЕННОЕ
                отличие плоского дерева редактора от дерева страниц. */}
            {editorMode && isArchitect && (
              <Section
                title="Добавить объект"
                open={openSections.has("add")}
                onToggle={() => toggleSection("add")}
              >
                <div style={paletteHint}>Перетащите форму на схему</div>
                <div style={palette}>
                  {NODE_TEMPLATES.map((t) => (
                    <div
                      key={t.shape}
                      className="template-card"
                      draggable
                      onDragStart={(e) => onTemplateDragStart(e, t.shape)}
                      onDragEnd={onTemplateDragEnd}
                      style={templateCard}
                      title={`Перетащить «${t.label}» на схему`}
                    >
                      <ShapeIcon shape={t.shape} />
                      <span style={templateLabel}>{t.label}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        ) : (
          /* ── Старое поведение: секции + палитра ────────────────── */
          <>
            <Section
              title="Дерево объектов"
              grow
              open={openSections.has("tree")}
              onToggle={() => toggleSection("tree")}
            >
              <div style={treeList}>
                {loadingRoots ? (
                  <div style={hint}>Загрузка…</div>
                ) : roots.length === 0 ? (
                  <div style={hint}>Нет объектов</div>
                ) : (
                  roots.map((n) => <Row key={n.id} node={n} />)
                )}
              </div>
            </Section>

            {isArchitect && (
              <Section
                title="Добавить объект"
                open={openSections.has("add")}
                onToggle={() => toggleSection("add")}
              >
                <div style={paletteHint}>Перетащите форму на схему</div>
                <div style={palette}>
                  {NODE_TEMPLATES.map((t) => (
                    <div
                      key={t.shape}
                      className="template-card"
                      draggable
                      onDragStart={(e) => onTemplateDragStart(e, t.shape)}
                      onDragEnd={onTemplateDragEnd}
                      style={templateCard}
                      title={`Перетащить «${t.label}» на схему`}
                    >
                      <ShapeIcon shape={t.shape} />
                      <span style={templateLabel}>{t.label}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
      )}

      {/* «Корзина» — плитка поверх всей панели на время драга шаблона. Рисуется
          СВЕРХУ (а не заменой контента), чтобы источник драга остался смонтированным:
          размонтирование плитки-источника во время нативного drag отменяет драг. */}
      {dragging && (
        <div
          style={{ ...trashOverlay, ...(trashActive ? trashOverlayActive : null) }}
          onDragOver={onTrashDragOver}
          onDragLeave={onTrashDragLeave}
          onDrop={onTrashDrop}
        >
          {/* pointerEvents:none на содержимом — dragenter/leave ловит только сам
              оверлей, без дёрганья подсветки при наведении на иконку */}
          <div style={trashInner}>
            <TrashIcon active={trashActive} />
          </div>
        </div>
      )}

      {/* Футер сворачивания — вне скролла контента, виден и в свёрнутом состоянии. */}
      <button
        className="nt-collapse"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Развернуть панель" : "Свернуть панель"}
      >
        <CollapseIcon dir={collapsed ? "right" : "left"} />
        {!collapsed && <span>Свернуть панель</span>}
      </button>
    </aside>
  );
}

const PANEL_W = 320;          // ширина развёрнутой панели (симметрично правой панели схемы)
const PANEL_COLLAPSED_W = 48; // узкий рейл с иконками секций в свёрнутом виде

const panel: CSSProperties = {
  position: "relative",
  flexShrink: 0,
  borderRight: "1px solid #e2e8f0",
  background: "#fbfcfd",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  transition: "width 0.22s ease",
};
// Рейл свёрнутой панели: вертикальный ряд иконочных кнопок секций.
const rail: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  paddingTop: 12,
  flex: 1,
};
const content: CSSProperties = {
  width: PANEL_W,            // фиксированная ширина — без переноса текста при анимации
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  transition: "opacity 0.18s ease",
  overflowY: "auto",
};
// Секция аккордеона (разделители-границы — в .nt-section CSS)
const section: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
const sectionBody: CSSProperties = {
  minHeight: 0,
  overflowY: "auto",
};
const treeList: CSSProperties = {
  padding: "0 0 6px",
};
// Глиф шеврона: размер/поворот. Кликабельная зона и хит-бокс — в CSS
// (.nt-chevzone / .nt-chevhit), поворот зависит от состояния, поэтому остаётся inline.
const chevIcon: CSSProperties = {
  fontSize: 11,
  lineHeight: 1,
  transition: "transform 0.12s ease",
  display: "inline-block",
};
const hint: CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  color: "#9ca3af",
};
// Палитра шаблонов
const paletteHint: CSSProperties = {
  padding: "0 14px 8px",
  fontSize: 11,
  color: "#94a3b8",
};
const palette: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
  padding: "0 14px 12px",
};
const templateCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  padding: "11px 6px 9px",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  // cursor (grab/grabbing) и hover-подсветка — в .template-card (нужны :active/:hover)
  userSelect: "none",
};
const templateLabel: CSSProperties = {
  fontSize: 11.5,
  color: "#475569",
  fontWeight: 500,
  textAlign: "center",
};
const iconSvg: CSSProperties = {
  display: "block",
  pointerEvents: "none",
};
// Оверлей-«корзина» поверх панели на время драга шаблона. Не упирается в края
// панели (inset-отступ) → плитка «внутри» панели; пунктирная рамка, без подписи.
const trashOverlay: CSSProperties = {
  position: "absolute",
  inset: 10,
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(248,250,252,.92)",
  border: "1.5px dashed #cbd5e1",
  borderRadius: 10,
  transition: "background 0.12s ease, border-color 0.12s ease",
};
// Активное состояние (курсор над корзиной) — рамка темнее, фон плотнее
const trashOverlayActive: CSSProperties = {
  background: "#eef2f6",
  borderColor: "#94a3b8",
};
const trashInner: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};

// ── Стили pages_pivot (поиск, персоны, «+») ────────────────────────
const searchWrap: CSSProperties = {
  position: "relative",
  padding: "10px 12px 6px",
  flexShrink: 0,
};
const searchInput: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "7px 28px 7px 10px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 13,
  color: "#0f172a",
  background: "#fff",
  outline: "none",
  boxSizing: "border-box",
  fontFamily: "inherit",
};
const searchClear: CSSProperties = {
  position: "absolute",
  right: 18,
  top: "50%",
  transform: "translateY(-50%)",
  background: "none",
  border: "none",
  fontSize: 16,
  color: "#94a3b8",
  cursor: "pointer",
  padding: "2px 4px",
  lineHeight: 1,
};
