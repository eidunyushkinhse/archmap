import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { nodesApi } from "../api/nodes";
import type { Node, NodeShape } from "../types";
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
 * Вся панель целиком сворачивается в узкую полосу кнопкой-шевроном внизу справа.
 */

// MIME-тип данных перетаскивания шаблона узла. На схеме (LevelGraph) по нему
// читается выбранная форма из dataTransfer.
export const NODE_DRAG_MIME = "application/archmap-node-shape";

/**
 * Дерево узлов отражает иерархию по parent_id. По умолчанию видны только корни;
 * детей подгружаем лениво по клику на шеврон. Клик по имени:
 *  - промежуточный узел (has_children) → провалиться на его слой ОСНОВНОЙ схемы
 *    (onDrillTo получает полный путь от корня до узла);
 *  - лист (детей нет) → открыть контекстную схему узла (onNodeContext).
 * Узлы-«пользователи» (shape: person) в дереве не показываем: дерево — навигатор
 * детализации, «провалиться» внутрь пользователя нечего.
 */
const withoutPersons = (nodes: Node[]): Node[] =>
  nodes.filter((n) => n.shape !== "person");

interface Props {
  // клик по промежуточному узлу (есть дети) → провалиться на его слой основной схемы;
  // path — полный путь от корня до узла включительно
  onDrillTo?: (path: Node[]) => void;
  // клик по листу (детей нет) → открыть контекстную схему узла
  onNodeContext?: (node: Node) => void;
  // секция «Добавить узел» показывается только архитектору
  isArchitect: boolean;
  // начало/конец перетаскивания шаблона из палитры: shape при старте, null при
  // завершении. По нему схема рисует превью-рамку будущего узла под курсором.
  onTemplateDrag?: (shape: NodeShape | null) => void;
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
  const W = 40, H = 30, stroke = "#475569", fill = "#e2e8f0", sw = 1.5;
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
    return (
      <svg width={W} height={H} style={iconSvg}>
        <circle cx={W / 2} cy={8} r={6} {...common} />
        <rect x={8} y={15} width={W - 16} height={H - 16} rx={4} {...common} />
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
      width="56" height="56" viewBox="0 0 24 24" fill="none"
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
    <div style={{ ...section, flex: grow && open ? 1 : "none" }}>
      <button onClick={onToggle} style={sectionHeader} title={open ? "Свернуть" : "Развернуть"}>
        {/* Крупный шеврон секции с эффектом вдавленности (гравировки), чтобы явно
            отличался от мелких шевронов промежуточных узлов в дереве. */}
        <span style={{ ...sectionChev, transform: open ? "rotate(90deg)" : "none" }}>▸</span>
        <span>{title}</span>
      </button>
      {open && <div style={sectionBody}>{children}</div>}
    </div>
  );
}

export default function NodeTreePanel({ onDrillTo, onNodeContext, isArchitect, onTemplateDrag }: Props) {
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

  useEffect(() => {
    let alive = true;
    nodesApi
      .list(null)
      .then((ns) => { if (alive) setRoots(withoutPersons(ns)); })
      .finally(() => { if (alive) setLoadingRoots(false); });
    return () => { alive = false; };
  }, []);

  async function toggle(node: Node) {
    const id = node.id;
    if (expanded.has(id)) {
      setExpanded((p) => { const n = new Set(p); n.delete(id); return n; });
      return;
    }
    // Дети ещё не загружены — тянем с бэка и сразу отсеиваем персон
    let kids = childrenById[id];
    if (kids === undefined) {
      setLoadingId((p) => new Set(p).add(id));
      try {
        kids = withoutPersons(await nodesApi.getChildren(id));
        setChildrenById((p) => ({ ...p, [id]: kids! }));
      } finally {
        setLoadingId((p) => { const n = new Set(p); n.delete(id); return n; });
      }
    }
    // После отсева персон показывать нечего — помечаем узел как лист, не раскрываем
    if (kids.length === 0) {
      setLeaves((p) => new Set(p).add(id));
      return;
    }
    setExpanded((p) => new Set(p).add(id));
  }

  function Row({ node, depth }: { node: Node; depth: number }) {
    const id = node.id;
    const isExpanded = expanded.has(id);
    const isLoading = loadingId.has(id);
    const kids = childrenById[id] ?? [];
    // шеврон скрываем, если все дети узла оказались персонами (узел стал листом)
    const hasChildren = node.has_children && !leaves.has(id);
    // промежуточный узел (есть дети в системе) → редирект на его слой; иначе → контекст.
    // Опираемся на has_children, а не на скрытие шеврона: узел с детьми-персонами в дереве
    // выглядит листом, но на основной схеме его дети (персоны) есть — туда и проваливаемся.
    const isIntermediate = node.has_children;
    const handler = isIntermediate
      ? (onDrillTo ? () => onDrillTo(pathTo(node)) : undefined)
      : (onNodeContext ? () => onNodeContext(node) : undefined);
    return (
      <>
        <div style={{ ...row, paddingLeft: 6 + depth * 16 }}>
          {hasChildren ? (
            <button
              onClick={() => toggle(node)}
              style={chevBtn}
              title={isExpanded ? "Свернуть" : "Развернуть"}
            >
              <span style={{ ...chevIcon, transform: isExpanded ? "rotate(90deg)" : "none" }}>
                {isLoading ? "⋯" : "▸"}
              </span>
            </button>
          ) : (
            <span style={leafMark}>●</span>
          )}
          <span
            className={handler ? (isIntermediate ? "tree-link" : "tree-leaf-btn") : undefined}
            style={handler ? undefined : nodeName}
            title={
              !handler ? node.name
                : isIntermediate ? `Открыть слой: ${node.name}`
                : `Контекст: ${node.name}`
            }
            onClick={handler}
          >
            {node.name}
          </span>
        </div>
        {isExpanded && kids.map((k) => <Row key={k.id} node={k} depth={depth + 1} />)}
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
      {/* Контент фиксированной ширины: при сворачивании панель сужается и клиппит
          его (плюс лёгкое затухание), поэтому текст не переносится и не дёргается. */}
      <div
        style={{
          ...content,
          opacity: collapsed ? 0 : 1,
          pointerEvents: collapsed ? "none" : "auto",
        }}
      >
        {/* Секция 1: дерево узлов */}
        <Section
          title="Дерево узлов"
          grow
          open={openSections.has("tree")}
          onToggle={() => toggleSection("tree")}
        >
          <div style={treeList}>
            {loadingRoots ? (
              <div style={hint}>Загрузка…</div>
            ) : roots.length === 0 ? (
              <div style={hint}>Нет узлов</div>
            ) : (
              roots.map((n) => <Row key={n.id} node={n} depth={0} />)
            )}
          </div>
        </Section>

        {/* Секция 2: палитра шаблонов для создания узла (только архитектор) */}
        {isArchitect && (
          <Section
            title="Добавить узел"
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

        {/* Секция 3: бизнес-процессы (заглушка) */}
        <Section
          title="Бизнес-процессы"
          open={openSections.has("bpm")}
          onToggle={() => toggleSection("bpm")}
        >
          <div style={stub}>Раздел в разработке</div>
        </Section>
      </div>

      {/* «Корзина» — серая плитка поверх всей панели на время драга шаблона. Рисуется
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

      <button
        onClick={() => setCollapsed((c) => !c)}
        style={toggleBtn}
        title={collapsed ? "Развернуть панель" : "Свернуть панель"}
      >
        {collapsed ? "›" : "‹"}
      </button>
    </aside>
  );
}

const PANEL_W = 260;          // ширина развёрнутой панели
const PANEL_COLLAPSED_W = 40; // узкая полоса в свёрнутом виде (под кнопку)

const panel: CSSProperties = {
  position: "relative",
  flexShrink: 0,
  borderRight: "1px solid #e5e7eb",
  background: "#fafafa",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  transition: "width 0.22s ease",
};
const content: CSSProperties = {
  width: PANEL_W,            // фиксированная ширина — без переноса текста при анимации
  height: "100%",
  display: "flex",
  flexDirection: "column",
  transition: "opacity 0.18s ease",
  overflowY: "auto",
};
const toggleBtn: CSSProperties = {
  position: "absolute",
  bottom: 8,
  right: 8,
  width: 26,
  height: 26,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  cursor: "pointer",
  color: "#6b7280",
  fontSize: 18,
  lineHeight: 1,
  boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
  zIndex: 2,
};
// Секция аккордеона
const section: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  borderBottom: "1px solid #e5e7eb",
};
const sectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "10px 14px",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 0.3,
  textTransform: "uppercase",
  color: "#6b7280",
  background: "none",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  flexShrink: 0,
};
// Шеврон секции крупный (≈ в 3 раза больше шеврона узла дерева, 15px → 36px).
// Эффект вдавленности (debossed/гравировка): цвет знака близок к фону панели, тёмная
// тень сверху + светлый блик снизу создают объём «вглубь» поверхности.
const sectionChev: CSSProperties = {
  fontSize: 36,
  lineHeight: 1,
  flexShrink: 0,
  color: "#cdd2d9",
  transition: "transform 0.12s ease",
  display: "inline-block",
  textShadow:
    "0 -1px 1px rgba(0,0,0,0.35), 0 1px 1px rgba(255,255,255,0.95), 0 2px 2px rgba(0,0,0,0.12)",
};
const sectionBody: CSSProperties = {
  minHeight: 0,
  overflowY: "auto",
};
const treeList: CSSProperties = {
  padding: "0 0 6px",
};
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px 4px 0",
  fontSize: 13,
  color: "#374151",
  whiteSpace: "nowrap",
};
const chevBtn: CSSProperties = {
  width: 24,
  height: 24,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#6b7280",
};
const chevIcon: CSSProperties = {
  fontSize: 15,
  lineHeight: 1,
  transition: "transform 0.12s ease",
  display: "inline-block",
};
const leafMark: CSSProperties = {
  width: 24,
  flexShrink: 0,
  textAlign: "center",
  color: "#cbd5e1",
  fontSize: 10,
};
// стиль для НЕкликабельного имени (когда колбэки не переданы); кликабельные имена
// оформлены классами .tree-link / .tree-leaf-btn в NodeTreePanel.css
const nodeName: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
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
  color: "#9ca3af",
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
  padding: "10px 6px",
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  // cursor задаётся через класс .template-card (нужен :active → grabbing «схватил»)
  userSelect: "none",
};
// Оверлей-«корзина» поверх панели на время драга шаблона. Не упирается в края
// панели (inset-отступ) → плитка «внутри» панели; сплошная рамка, скруглённые углы.
const trashOverlay: CSSProperties = {
  position: "absolute",
  inset: 10,
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#eceef1",
  border: "2px solid #cbd5e1",
  borderRadius: 12,
  transition: "background 0.12s ease, border-color 0.12s ease",
};
// Активное состояние (курсор над корзиной) — более глубокий оттенок серого
const trashOverlayActive: CSSProperties = {
  background: "#d5dae1",
  borderColor: "#94a3b8",
};
const trashInner: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};
const templateLabel: CSSProperties = {
  fontSize: 12,
  color: "#374151",
  textAlign: "center",
};
const iconSvg: CSSProperties = {
  display: "block",
  pointerEvents: "none",
};
const stub: CSSProperties = {
  padding: "4px 14px 14px",
  fontSize: 13,
  color: "#9ca3af",
  fontStyle: "italic",
};
