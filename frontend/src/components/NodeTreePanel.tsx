import { useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import type { Node, NodeShape } from "../types";
import { canHaveChildren } from "../types";
import { ShapeGlyph } from "./nodeTree.shared";
import { TreeRow, type TreeRowCtx } from "./nodeTree.Row";
import { ChevronIcon, CollapseIcon, TreeIcon, PlusIcon } from "../ui/icons";
import "./NodeTreePanel.css";
import { noAutofill } from "../ui/noAutofill";
import { useLazyTree } from "./nodeTree.useLazyTree";
import { useNodeSearch } from "./useNodeSearch";

// MIME-тип данных перетаскивания шаблона узла. На схеме (LevelGraph) по нему
// читается выбранная форма из dataTransfer.
export const NODE_DRAG_MIME = "application/archmap-node-shape";
// Перенос СУЩЕСТВУЮЩЕГО узла на другой уровень (драг строки дерева). Тип нарочно свой:
// корзина палитры и холст фильтруют драги по MIME и этот пропустят мимо.
export const NODE_MOVE_MIME = "application/archmap-node-move";
// Служебный ключ цели «корень проекта» (строки у корня нет — только полоса).
const ROOT_TARGET = "__root__";

/**
 * Дерево объектов отражает иерархию по parent_id. По умолчанию видны только
 * корни; дети подгружаются лениво по клику на шеврон. Клик по строке ведёт на
 * страницу объекта (onNodePage) либо навигирует внутри редактора-карты
 * (контейнер → onDrillTo, лист → onPickLeaf); выбор узла с детьми попутно
 * раскрывает его ветку. Персоны стоят в общей иерархии наравне с прочими.
 * В редакторе внизу добавляется секция-палитра «Добавить объект» (единственное
 * отличие от дерева страниц).
 */

interface Props {
  // клик по промежуточному узлу (есть дети) → провалиться на его слой основной схемы;
  // path — полный путь от корня до узла включительно
  onDrillTo?: (path: Node[]) => void;
  // pages_pivot: клик по ЛЮБОМУ узлу → его страница (включает плоский дизайн)
  onNodePage?: (node: Node) => void;
  // редактор-карта: клик по листу → показать на холсте (прыжок на слой узла,
  // выделение, locate). Включает тот же плоский дизайн, что и страничный режим
  // (поиск, «+», персоны, подсветка текущего узла), но клик навигирует внутри
  // редактора: контейнер → onDrillTo(path), лист → onPickLeaf(node).
  onPickLeaf?: (node: Node) => void;
  // pages_pivot: «+» на строке → создать дочерний объект (модалка, авто-позиция)
  onCreateChild?: (parentId: string) => void;
  // Перенос узла на другой уровень перетаскиванием строки. Передаёт ТОЛЬКО
  // редактор-карта — этим же и гейтится жест: в оболочке страниц ручки нет.
  onReparent?: (node: Node, newParentId: string | null) => void;
  // секция «Добавить узел» показывается только архитектору
  isArchitect: boolean;
  // начало/конец перетаскивания шаблона из палитры: shape при старте, null при
  // завершении. По нему схема рисует превью-рамку будущего узла под курсором.
  onTemplateDrag?: (shape: NodeShape | null) => void;
  // сигнал внешней перезагрузки дерева (инкремент после создания/удаления узла в
  // MapEditorPage): дерево перечитывает корни и раскрытые ветки, не сворачиваясь.
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

export default function NodeTreePanel({ onDrillTo, onNodePage, onPickLeaf, onCreateChild, onReparent, isArchitect, onTemplateDrag, reloadToken, currentNodeId }: Props) {
  // pages_pivot: плоское дерево без секций/палитры, с поиском, «+» и персонами
  const pagesMode = !!onNodePage;
  // редактор-карта: тот же плоский дизайн, но клик — навигация внутри редактора
  const editorMode = !!onPickLeaf;

  const {
    roots, loadingRoots, childrenById, expanded, loadingId, leaves, allById, pathTo,
    expandBranch, toggle, treeScrollRef,
  } = useLazyTree(reloadToken, currentNodeId);
  const [collapsed, setCollapsed] = useState(false); // свёрнута ли вся панель
  // идёт ли перетаскивание шаблона из палитры → панель закрывается «корзиной»
  const [dragging, setDragging] = useState(false);
  // курсор над «корзиной» (drop здесь = отмена) → подсветка активного состояния
  const [trashActive, setTrashActive] = useState(false);
  // синхронный флаг «идёт драг» — оверлей показываем отложенно (см. onTemplateDragStart),
  // а ref нужен, чтобы не зажечь его уже после завершения короткого драга
  const draggingRef = useRef(false);
  // Переносимый узел (драг строки). Ref — истина на момент события, стейт — для
  // подсветки; зажигаем его отложенно по той же причине, что и корзину палитры.
  const movingRef = useRef<Node | null>(null);
  const [moving, setMoving] = useState<Node | null>(null);
  // Цель под курсором: id строки, ROOT_TARGET (полоса «в корень») либо null.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
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
  // Дебаунс-поиск (общий с выбором конца связи), результат — плоский список совпадений.
  const { found: foundNodes, searching } = useNodeSearch(searchQuery, 250);
  const searchResults = searchQuery.trim() ? foundNodes : null;

  // Единый клик строки в плоском дизайне: страница → переход на страницу объекта;
  // редактор → контейнер дрилнится на свой слой, лист показывается на холсте.
  const navigateFlat = (node: Node) => {
    if (onNodePage) { onNodePage(node); return; }
    if (canHaveChildren(node.shape) && node.has_children) onDrillTo?.(pathTo(node));
    else onPickLeaf?.(node);
  };

  // Контекст строки дерева. Строка живёт отдельным компонентом (nodeTree.Row):
  // объявленная ВНУТРИ панели, она ремаунтилась бы на каждый рендер и срывала бы
  // нативный драг. Ссылочная стабильность объекта не нужна — важен только тип.
  const rowCtx: TreeRowCtx = {
    expanded, loadingId, childrenById, leaves, currentNodeId,
    pagesMode, isArchitect, onCreateChild,
    onSelect: (node) => { navigateFlat(node); if (canHaveChildren(node.shape) && node.has_children) void expandBranch(node); },
    onToggle: (node) => { void toggle(node); },
    drag: onReparent && isArchitect ? { onStart: onRowDragStart, onEnd: onRowDragEnd } : undefined,
    movingId: moving?.id ?? null,
    dropTargetId: dropTarget,
    onDragOverRow: onRowDragOver,
    onDragLeaveRow: onRowDragLeave,
    onDropRow: onRowDrop,
  };

  // Перенос узла: драг начинается с ручки-шести-точек. Сам дроп — на строке-цели
  // (см. Ф3), здесь только старт/завершение жеста.
  function onRowDragStart(e: DragEvent, node: Node) {
    e.dataTransfer.setData(NODE_MOVE_MIME, node.id);
    e.dataTransfer.effectAllowed = "move";
    movingRef.current = node;
    // Подсветку зажигаем СЛЕДУЮЩИМ кадром: перерисовка источника прямо в dragstart
    // отменяет нативный драг (та же причина, что у корзины палитры).
    requestAnimationFrame(() => { if (movingRef.current) setMoving(movingRef.current); });
  }
  function onRowDragEnd() {
    movingRef.current = null;
    setMoving(null);
    setDropTarget(null);
  }

  // Куда переносить МОЖНО. Зеркало серверных запретов (app/reparent.py): отказ должен
  // быть виден ДО дропа (цель просто не подсвечивается и не принимает), а не приходить
  // ошибкой после. targetId === null — корень проекта.
  function canDropInto(node: Node, targetId: string | null): boolean {
    // Человек по C4 живёт ЗА границей системы — ему доступен только вынос в корень.
    if (node.shape === "person") return targetId === null && node.parent_id !== null;
    if (targetId === null) return node.parent_id !== null;
    if (targetId === node.id || targetId === node.parent_id) return false;
    const target = allById.get(targetId);
    if (!target || !canHaveChildren(target.shape)) return false;
    // Собственный потомок (цикл): путь до цели строится по ЗАГРУЖЕННЫМ предкам, и
    // этого достаточно — чтобы строка была видна, все её предки раскрыты.
    return !pathTo(target).some((n) => n.id === node.id);
  }

  function onRowDragOver(e: DragEvent, target: Node) {
    const m = movingRef.current;
    if (!m || !e.dataTransfer.types.includes(NODE_MOVE_MIME)) return;
    if (!canDropInto(m, target.id)) return; // дроп не разрешаем — курсор останется «запретным»
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== target.id) setDropTarget(target.id);
  }
  function onRowDragLeave(target: Node) {
    setDropTarget((prev) => (prev === target.id ? null : prev));
  }
  function onRowDrop(e: DragEvent, target: Node) {
    e.preventDefault();
    const m = movingRef.current;
    setDropTarget(null);
    if (m && canDropInto(m, target.id)) onReparent?.(m, target.id);
  }

  function onRootDragOver(e: DragEvent) {
    const m = movingRef.current;
    if (!m || !e.dataTransfer.types.includes(NODE_MOVE_MIME) || !canDropInto(m, null)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== ROOT_TARGET) setDropTarget(ROOT_TARGET);
  }
  function onRootDrop(e: DragEvent) {
    e.preventDefault();
    const m = movingRef.current;
    setDropTarget(null);
    if (m && canDropInto(m, null)) onReparent?.(m, null);
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
          <>
            {/* Поиск — а на время переноса ВМЕСТО него полоса «в корень проекта»:
                единственный способ вынести объект на верхний уровень (строки, которая
                представляла бы корень, в дереве нет), а поиск в разгар жеста не нужен.
                Подмена в том же слоте — список под ней не съезжает. */}
            {moving && canDropInto(moving, null) ? (
              <div style={searchWrap}>
                <div
                  className={"nt-rootzone" + (dropTarget === ROOT_TARGET ? " nt-rootzone--active" : "")}
                  onDragOver={onRootDragOver}
                  onDragLeave={() => setDropTarget((prev) => (prev === ROOT_TARGET ? null : prev))}
                  onDrop={onRootDrop}
                >
                  В корень проекта
                </div>
              </div>
            ) : (
              <div style={searchWrap}>
                <input
                  {...noAutofill("node-tree-panel-1")}
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
            )}

            {/* Результаты поиска или дерево */}
            <div ref={treeScrollRef} data-tour="tree" style={{ ...treeList, flex: 1, minHeight: 0, overflowY: "auto" }}>
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
                roots.map((n) => <TreeRow key={n.id} node={n} ctx={rowCtx} />)
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
                <div style={palette} data-tour="palette">
                  {NODE_TEMPLATES.map((t) => (
                    <div
                      key={t.shape}
                      data-tour={`palette:${t.shape}`}
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
