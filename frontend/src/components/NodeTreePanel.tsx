import { useMemo, useState } from "react";
import type { Node } from "../types";
import { nodeNesting, treeNesting } from "../types";
import { ShapeGlyph } from "./nodeTree.shared";
import { PlaceButton, TreeRow, type TreeRowCtx } from "./nodeTree.Row";
import { offDeployCanvas, placeable, treeRowTitle } from "./nodeTree.mode";
import { CloseIcon, CollapseIcon } from "../ui/icons";
import "../ui/ds.css";
import "./NodeTreePanel.css";
import { noAutofill } from "../ui/noAutofill";
import { PaletteSection, TrashOverlay } from "./nodeTree.Palette";
import { usePaletteDrag } from "./nodeTree.usePaletteDrag";
import { useLazyTree } from "./nodeTree.useLazyTree";
import { useTreeReparent } from "./nodeTree.useReparent";
import { useNodeSearch } from "./useNodeSearch";
import type { NodeType } from "./nodeTerms";
import type { PaletteTile } from "./element/paletteTiles";


/**
 * Дерево объектов отражает иерархию по parent_id. По умолчанию видны только
 * корни; дети подгружаются лениво по клику на шеврон. Режим задаётся явно (аудит
 * F-7; раньше угадывался по тому, какие колбэки переданы): в дереве страниц клик по
 * строке ведёт на страницу объекта, в редакторе-карте — навигирует внутри него
 * (контейнер → onDrillTo, лист → onPickLeaf), в «Развёртывании» — по холсту площадок
 * (система → onOpenLevel, прочие → onPickObject; иконка строки → onPlace). Выбор узла с
 * детьми попутно раскрывает его ветку. Персоны стоят в общей иерархии наравне с прочими.
 * Только в редакторе — перенос строк и секция-палитра «Добавить объект».
 *
 * Вид — на новом языке (редизайн, фаза 4б): корень панели — область .ds, кегли, цвета,
 * радиусы и отступы из токенов (NodeTreePanel.css). Панель одинакова в редакторе-карте,
 * в оболочке проекта и в «Развёртывании», где бы её ни нарисовали.
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
      onReparent?: (node: Node, newParentId: string | null, targetName?: string) => void;
      // начало/конец перетаскивания шаблона из палитры: тип объекта при старте, null при
      // завершении. По нему схема рисует превью-рамку будущего узла под курсором.
      onTemplateDrag?: (type: NodeType | null) => void;
      // Плитки палитры: какие типы можно тянуть и почему нет (считает страница по
      // родителю уровня и раскрытым рамкам холста, element/paletteTiles); null или не
      // передано — палитра ничего не гасит (тип проверит окно «Новый объект»).
      paletteTiles?: readonly PaletteTile[] | null;
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

// «Развёртывание»: компоненты в дереве не показываются (на холсте их нет, размещаются они
// вместе с контейнером — D33): ветка контейнера и составного компонента не раскрывается,
// контейнер — строка без шеврона. Функция модульная — ссылка стабильна для мемо дерева.
const hidesComponents = (node: Node): boolean =>
  node.element_effective === "container" || node.element_effective === "component";

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
  } = useLazyTree(reloadToken, currentNodeId, deploy ? hidesComponents : undefined);
  // Перенос узла на другой уровень перетаскиванием строки (только редактор-карта).
  const reparent = useTreeReparent(allById, pathTo, editor?.onReparent);
  const [collapsed, setCollapsed] = useState(false); // свёрнута ли вся панель
  // Драг шаблона из палитры: на это время панель накрывается «корзиной».
  const paletteDrag = usePaletteDrag(editor?.onTemplateDrag);

  // ── Поиск (pages_pivot) ──────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  // Дебаунс-поиск (общий с выбором конца связи), результат — плоский список совпадений.
  const { found: foundNodes, searching } = useNodeSearch(searchQuery, 250);
  // «Развёртывание»: «Пользователя» нет ни в дереве, ни в поиске (offDeployCanvas, D28).
  const isDeploy = props.mode === "deploy";
  const searchResults = searchQuery.trim()
    ? (isDeploy && foundNodes ? foundNodes.filter((n) => !offDeployCanvas(n)) : foundNodes)
    : null;
  const shownRoots = useMemo(
    () => (isDeploy ? roots.filter((n) => !offDeployCanvas(n)) : roots),
    [isDeploy, roots],
  );
  // Вложенный «Пользователь» бывает только в старых данных (AL25) — и его в этом режиме
  // не показываем; у остальных режимов ветки как есть.
  const shownChildren = useMemo(() => {
    if (!isDeploy) return childrenById;
    const out: Record<string, Node[]> = {};
    for (const [id, kids] of Object.entries(childrenById)) out[id] = kids.filter((n) => !offDeployCanvas(n));
    return out;
  }, [isDeploy, childrenById]);

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
    expanded, loadingId, childrenById: shownChildren, leaves, currentNodeId,
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
    <aside className={"ds nt-panel" + (collapsed ? " nt-panel--collapsed" : "")}>
      {/* Свёрнутая панель — узкая полоса с одной кнопкой «Развернуть панель» внизу. */}
      {!collapsed && (
      <div className="nt-content">
          <>
            {/* Поиск — а на время переноса ВМЕСТО него полоса «в корень проекта»:
                единственный способ вынести объект на верхний уровень (строки, которая
                представляла бы корень, в дереве нет), а поиск в разгар жеста не нужен.
                Подмена в том же слоте — список под ней не съезжает. */}
            {reparent.moving && reparent.canDropInto(reparent.moving, null) ? (
              <div className="nt-search">
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
              <div className="nt-search">
                <div className="nt-search-field">
                  <input
                    {...noAutofill("node-tree-panel-1")}
                    className="ds-input nt-search-input"
                    type="text"
                    placeholder="Поиск по имени"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button type="button" className="nt-search-clear" onClick={() => setSearchQuery("")} title="Очистить" aria-label="Очистить">
                      <CloseIcon size={14} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Результаты поиска или дерево */}
            <div ref={treeScrollRef} data-tour="tree" className="nt-tree">
              {searchResults !== null ? (
                searching ? (
                  <div className="nt-hint">Ищем</div>
                ) : searchResults.length === 0 ? (
                  <div className="nt-hint">Ничего не найдено</div>
                ) : (
                  searchResults.map((n) => (
                    <div
                      key={n.id}
                      className={"nt-row nt-row--clickable" + (deploy?.placingId === n.id ? " nt-row--placing" : "")}
                      onClick={() => navigateFlat(n)}
                      title={treeRowTitle(props.mode, n)}
                    >
                      <span className="nt-chevspacer" />
                      <ShapeGlyph nesting={treeNesting(n)} shape={n.shape} />
                      <span className="nt-name">{n.name}</span>
                      {/* Компонента на холсте «Развёртывание» нет: строка поиска говорит,
                          чей контейнер покажет щелчок (D28) */}
                      {props.mode === "deploy" && n.element_effective === "component" && n.container_name && (
                        <span className="nt-note">в «{n.container_name}»</span>
                      )}
                      {placeable(n, isArchitect, deploy?.onPlace) && <PlaceButton node={n} onPlace={deploy.onPlace} />}
                    </div>
                  ))
                )
              ) : loadingRoots ? (
                <div className="nt-hint">Загрузка</div>
              ) : shownRoots.length === 0 ? (
                <div className="nt-hint">Нет объектов</div>
              ) : (
                shownRoots.map((n) => <TreeRow key={n.id} node={n} ctx={rowCtx} />)
              )}
            </div>

            {/* Палитра «Добавить объект» — только в редакторе; ЕДИНСТВЕННОЕ
                отличие плоского дерева редактора от дерева страниц. Всегда раскрыта. */}
            {editor && isArchitect && (
              <PaletteSection drag={paletteDrag} tiles={editor.paletteTiles ?? null} />
            )}
          </>
      </div>
      )}

      {/* «Корзина» — плитка поверх всей панели на время драга шаблона. Рисуется
          СВЕРХУ (а не заменой контента), чтобы источник драга остался смонтированным:
          размонтирование плитки-источника во время нативного drag отменяет драг. */}
      {paletteDrag.dragging && <TrashOverlay drag={paletteDrag} />}

      {/* Сворачивание — тихая кнопка-значок внизу, вне скролла контента, как у списка
          процессов; видна и в свёрнутой полосе. На подсказку «Свернуть панель» опирается
          зонд холста (scripts/dump-levels.mjs). */}
      <button
        type="button"
        className="ds-icon-btn nt-collapse"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Развернуть панель" : "Свернуть панель"}
        aria-label={collapsed ? "Развернуть панель" : "Свернуть панель"}
      >
        <CollapseIcon size={15} dir={collapsed ? "right" : "left"} />
      </button>
    </aside>
  );
}

// Ширина панели (320px, симметрично правой панели схемы) и свёрнутой полосы (48px) —
// в NodeTreePanel.css (.nt-panel, .nt-panel--collapsed).
