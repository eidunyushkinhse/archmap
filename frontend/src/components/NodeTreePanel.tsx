import { useState } from "react";
import type { CSSProperties } from "react";
import type { Node, NodeShape } from "../types";
import { nodeNesting } from "../types";
import { ShapeGlyph } from "./nodeTree.shared";
import { PlaceButton, TreeRow, type TreeRowCtx } from "./nodeTree.Row";
import { placeable, treeRowTitle } from "./nodeTree.mode";
import { CollapseIcon, TreeIcon, PlusIcon } from "../ui/icons";
import "./NodeTreePanel.css";
import { noAutofill } from "../ui/noAutofill";
import { PaletteSection, TrashOverlay } from "./nodeTree.Palette";
import { usePaletteDrag } from "./nodeTree.usePaletteDrag";
import { useLazyTree } from "./nodeTree.useLazyTree";
import { useTreeReparent } from "./nodeTree.useReparent";
import { useNodeSearch } from "./useNodeSearch";


/**
 * Дерево объектов отражает иерархию по parent_id. По умолчанию видны только
 * корни; дети подгружаются лениво по клику на шеврон. Режим задаётся явно (аудит
 * F-7; раньше угадывался по тому, какие колбэки переданы): в дереве страниц клик по
 * строке ведёт на страницу объекта, в редакторе-карте — навигирует внутри него
 * (контейнер → onDrillTo, лист → onPickLeaf), в «Развёртывании» — по холсту площадок
 * (система → onOpenLevel, прочие → onPickObject; иконка строки → onPlace). Выбор узла с
 * детьми попутно раскрывает его ветку. Персоны стоят в общей иерархии наравне с прочими.
 * Только в редакторе — перенос строк и секция-палитра «Добавить объект».
 */

type ModeProps =
  | {
      mode: "pages";
      // клик по ЛЮБОМУ узлу → его страница
      onNodePage: (node: Node) => void;
    }
  | {
      mode: "editor";
      // клик по промежуточному узлу (есть дети) → провалиться на его слой основной
      // схемы; path — полный путь от корня до узла включительно
      onDrillTo: (path: Node[]) => void;
      // клик по листу → показать на холсте (прыжок на слой узла, выделение, locate)
      onPickLeaf: (node: Node) => void;
      // Перенос узла на другой уровень перетаскиванием строки (ручка — у архитектора).
      onReparent?: (node: Node, newParentId: string | null) => void;
      // начало/конец перетаскивания шаблона из палитры: shape при старте, null при
      // завершении. По нему схема рисует превью-рамку будущего узла под курсором.
      onTemplateDrag?: (shape: NodeShape | null) => void;
    }
  | {
      // «Развёртывание» (docs/specs/deployment.md): объекты здесь не создаются и не
      // переносятся — без палитры, «+» и ручки; поиск и сворачивание — как везде.
      mode: "deploy";
      // клик по системе → её уровень развёртывания (уровня контейнера нет: компоненты
      // развёртываются вместе с ним, D24)
      onOpenLevel: (node: Node) => void;
      // клик по прочим (контейнер, компонент) → выделить карточки на холсте (при
      // нужде — сменив уровень; у компонента — карточки его контейнера)
      onPickObject: (node: Node) => void;
      // иконка «Указать размещение» на строке → режим размещения; только архитектору
      onPlace?: (node: Node) => void;
      // объект, который сейчас размещают: строка подсвечена, иконка видна
      placingId?: string | null;
    };

type Props = ModeProps & {
  // «+» на строке → создать дочерний объект (модалка, авто-позиция); «+» и палитра
  // видны только архитектору
  onCreateChild?: (parentId: string) => void;
  isArchitect: boolean;
  // сигнал внешней перезагрузки дерева (инкремент после создания/удаления узла):
  // дерево перечитывает корни и раскрытые ветки, не сворачиваясь.
  reloadToken?: number;
  // id узла, чья страница (или слой редактора) СЕЙЧАС открыта; null — корень проекта.
  // Дерево подсвечивает его строку и при смене раскрывает ветку до этого узла.
  currentNodeId?: string | null;
};

export default function NodeTreePanel(props: Props) {
  const { onCreateChild, isArchitect, reloadToken, currentNodeId } = props;
  // Колбэки редактора-карты и «Развёртывания» (в дереве страниц их нет).
  const editor = props.mode === "editor" ? props : null;
  const deploy = props.mode === "deploy" ? props : null;

  const {
    roots, loadingRoots, childrenById, expanded, loadingId, leaves, allById, pathTo,
    expandBranch, toggle, treeScrollRef,
  } = useLazyTree(reloadToken, currentNodeId);
  // Перенос узла на другой уровень перетаскиванием строки (только редактор-карта).
  const reparent = useTreeReparent(allById, pathTo, editor?.onReparent);
  const [collapsed, setCollapsed] = useState(false); // свёрнута ли вся панель
  // Драг шаблона из палитры: на это время панель накрывается «корзиной».
  const paletteDrag = usePaletteDrag(editor?.onTemplateDrag);
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
    if (props.mode === "pages") { props.onNodePage(node); return; }
    if (props.mode === "deploy") {
      // Элемент считает сервер: уровень на холсте развёртывания есть только у системы.
      if (node.element_effective === "system") props.onOpenLevel(node);
      else props.onPickObject(node);
      return;
    }
    const container = nodeNesting(node) === "group";
    if (container) props.onDrillTo(pathTo(node));
    else props.onPickLeaf(node);
  };

  // Контекст строки дерева. Строка живёт отдельным компонентом (nodeTree.Row):
  // объявленная ВНУТРИ панели, она ремаунтилась бы на каждый рендер и срывала бы
  // нативный драг. Ссылочная стабильность объекта не нужна — важен только тип.
  const rowCtx: TreeRowCtx = {
    expanded, loadingId, childrenById, leaves, currentNodeId,
    mode: props.mode, isArchitect,
    // в «Развёртывании» объекты не создаются (решение §2а п. 10) — «+» нет и при переданном
    onCreateChild: deploy ? undefined : onCreateChild,
    onPlace: deploy?.onPlace,
    placingId: deploy?.placingId,
    onSelect: (node) => { navigateFlat(node); if (nodeNesting(node) === "group") void expandBranch(node); },
    onToggle: (node) => { void toggle(node); },
    drag: editor?.onReparent && isArchitect ? { onStart: reparent.onRowDragStart, onEnd: reparent.onRowDragEnd } : undefined,
    movingId: reparent.moving?.id ?? null,
    dropTargetId: reparent.dropTargetId,
    onDragOverRow: reparent.onRowDragOver,
    onDragLeaveRow: reparent.onRowDragLeave,
    onDropRow: reparent.onRowDrop,
  };

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
          {isArchitect && !deploy && (
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
            {reparent.moving && reparent.canDropInto(reparent.moving, null) ? (
              <div style={searchWrap}>
                <div
                  className={"nt-rootzone" + (reparent.rootActive ? " nt-rootzone--active" : "")}
                  onDragOver={reparent.onRootDragOver}
                  onDragLeave={reparent.onRootDragLeave}
                  onDrop={reparent.onRootDrop}
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
                      className={"nt-row nt-row--clickable" + (deploy?.placingId === n.id ? " nt-row--placing" : "")}
                      onClick={() => navigateFlat(n)}
                      title={treeRowTitle(props.mode, n)}
                    >
                      <span className="nt-chevspacer" />
                      <ShapeGlyph container={nodeNesting(n) === "group"} shape={n.shape} />
                      <span className="nt-name">{n.name}</span>
                      {placeable(n, isArchitect, deploy?.onPlace) && <PlaceButton node={n} onPlace={deploy.onPlace} />}
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
            {editor && isArchitect && (
              <PaletteSection
                open={openSections.has("add")}
                onToggle={() => toggleSection("add")}
                drag={paletteDrag}
              />
            )}
          </>
      </div>
      )}

      {/* «Корзина» — плитка поверх всей панели на время драга шаблона. Рисуется
          СВЕРХУ (а не заменой контента), чтобы источник драга остался смонтированным:
          размонтирование плитки-источника во время нативного drag отменяет драг. */}
      {paletteDrag.dragging && <TrashOverlay drag={paletteDrag} />}

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
const treeList: CSSProperties = {
  padding: "0 0 6px",
};
const hint: CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  color: "#9ca3af",
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
