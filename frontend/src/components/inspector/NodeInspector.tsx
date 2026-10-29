// Мета узла в правой панели: просмотр (наблюдатель) и inline-правка (архитектор).
// Перенос ветки «просмотр/правка» из NodeModal (создание осталось в модалке). Inline-
// правка коммитится по blur (тексты) / сразу (toggle/статус) и ложится в Undo/Redo через
// тот же onNodeSaved, что и модалка. Документация (схемы логики/OpenAPI) в редакторе
// не управляется — единый раздел «Документация» ведёт на страницу узла.
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { DeletionSnapshot, Node, NodeElement, NodeShape, NodeStatus } from "../../types";
import { nodeNesting } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { ShapeGlyph } from "../nodeTree.shared";
import NodeDeleteConfirm from "../NodeDeleteConfirm";
import AnchorField from "../anchor/AnchorField";
import MetaRow from "./MetaRow";
import { META_ICON } from "./metaIcons";
import { aggregateTech, useDescendants } from "../../pages/useContainerChildren";
import { useNodePatch } from "../../pages/useNodePatch";
import "./inspector.css";
import { noAutofill } from "../../ui/noAutofill";
import { ELEMENT_HINT, ELEMENT_LABEL, ELEMENT_ORDER, SHAPE_LABEL, SHAPE_ORDER, STATUS_ORDER } from "../nodeTerms";
import { elementView, useElementPick, type ElementView } from "../element/useElementPick";

interface Props {
  node: Node;
  isArchitect: boolean;
  // Тот же обработчик, что у модалки: кладёт правку в Undo/Redo. before — узел ДО правки.
  onNodeSaved: (saved: Node, isCreate: boolean, before?: Node) => void;
  onNodeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  // Переход на страницу узла (раздел «Документация» → «Открыть»).
  onNavigateNode: (nodeId: string) => void;
}


// Плашка-уведомление панели: и конфликт версий, и отказ сервера с причиной.
const noticeStyle: CSSProperties = {
  color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d",
  borderRadius: 8, padding: "6px 10px", fontSize: 12.5, margin: "0 0 10px",
};

export default function NodeInspector({ node, isArchitect, onNodeSaved, onNodeDeleted, onNavigateNode }: Props) {
  // Правка по blur (тексты) / сразу (тогл, статус, тип) с CAS и 409-ресинком — тот же
  // хук, что на странице объекта. Успешная правка ложится в Undo редактора: хук отдаёт
  // узел ДО правки вторым аргументом. Значения полей сбрасываются на смену выбора:
  // ObjectInspector монтирует NodeInspector с key=node.id. Плашки: conflict — 409
  // (правка не применилась, данные обновлены с сервера), error — отказ с причиной
  // (400: смена типа у узла с детьми / у базы с описанной структурой).
  const patch = useNodePatch(node, (saved, before) => onNodeSaved(saved, false, before));
  const { name, description, role, technology, isExternal, status, conflict, error } = patch;
  const [statusOpen, setStatusOpen] = useState(false);
  const [shapeOpen, setShapeOpen] = useState(false);
  const [elementOpen, setElementOpen] = useState(false);
  // Элемент архитектуры (Ф5): выбор у узла с детьми, у листа и компонента — текст,
  // у «Пользователя» строки нет. Смена — с окном последствий, если они есть.
  const element = useElementPick(patch);
  const [confirming, setConfirming] = useState(false);
  // Тип показываем из самого узла (пропа): он обновится тем же путём, что имя
  // (onNodeSaved → данные узла в редакторе → холст), а при отказе 400 показанный тип
  // остаётся прежним, потому что прошлое значение никто не перетирал.
  const shape = node.shape;
  const isPerson = shape === "person";
  const isContainer = nodeNesting(node) === "group";
  // Агрегированная технология потомков для контейнера: по правилам у контейнера
  // нет своей технологии — показываем сумму технологий потомков, read-only
  // (как на странице узла). Для не-контейнеров хук ничего не фетчит.
  const { descendants } = useDescendants(node.id, isContainer);
  const aggTech = useMemo(() => (descendants ? aggregateTech(descendants) : ""), [descendants]);
  const techLoading = isContainer && descendants === null;

  // Выпадашки закрываются сами; коммит — только при реальном изменении (хук не
  // плодит пустых записей истории).
  const pickStatus = (st: NodeStatus) => {
    setStatusOpen(false);
    patch.pickStatus(st);
  };
  const pickShape = (sh: NodeShape) => {
    setShapeOpen(false);
    if (sh === shape) return;
    patch.pickShape(sh);
  };

  const statusDot = (st: NodeStatus) => (st === "existing" ? "#9ca3af" : getNodeColors(isExternal, 0, st).bg);

  return (
    <div>
      {conflict && <p style={noticeStyle}>{conflict}</p>}
      {error && <p style={noticeStyle}>{error}</p>}
      {/* Шапка-идентификатор: глиф формы + имя + строка типа */}
      <div className="insp-head">
        <span className="insp-headglyph"><ShapeGlyph container={isContainer} shape={shape} /></span>
        <div className="insp-headmain">
          {isArchitect ? (
            <input
              {...noAutofill("node-inspector-1")}
              className="insp-field insp-field--name"
              value={name}
              onChange={(e) => patch.setName(e.target.value)}
              onBlur={patch.commitName}
            />
          ) : (
            <div className="insp-name">{node.name}</div>
          )}
          <div className="insp-typeline">
            {SHAPE_LABEL[shape]} · {isExternal ? "внешний" : "внутренний"}
          </div>
        </div>
      </div>

      {/* Описание */}
      {isArchitect ? (
        <textarea
          {...noAutofill("node-inspector-2")}
          className="insp-field insp-fieldarea"
          value={description}
          onChange={(e) => patch.setDescription(e.target.value)}
          onBlur={patch.commitDesc}
          placeholder="Описание"
        />
      ) : (
        node.description && <p className="insp-desc">{node.description}</p>
      )}

      {/* Список меты «терм → значение» (в узкой панели — терм над значением) */}
      <dl className="insp-meta insp-meta--stacked">
        <MetaRow icon={META_ICON.type} label="Тип">
          {isArchitect ? (
            <span className="insp-value">
              <span className="insp-selwrap">
                <button
                  type="button"
                  className="insp-field insp-select"
                  onClick={() => setShapeOpen((o) => !o)}
                  aria-haspopup="listbox"
                  aria-expanded={shapeOpen}
                >
                  <span className="insp-select-label">{SHAPE_LABEL[shape]}</span>
                  <span className="insp-chev"><ChevronDown /></span>
                </button>
                {shapeOpen && (
                  <>
                    <div className="insp-backdrop" onClick={() => setShapeOpen(false)} />
                    <ul className="insp-menu" role="listbox">
                      {SHAPE_ORDER.map((sh) => (
                        <li
                          key={sh}
                          role="option"
                          aria-selected={sh === shape}
                          onClick={() => pickShape(sh)}
                        >
                          {SHAPE_LABEL[sh]}
                          {sh === shape && <span className="insp-menu-check"><CheckMark /></span>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </span>
            </span>
          ) : (
            <span className="insp-value">{SHAPE_LABEL[shape]}</span>
          )}
        </MetaRow>

        <ElementRow
          view={elementView(node, isArchitect)}
          open={elementOpen}
          setOpen={setElementOpen}
          onPick={element.pick}
        />

        <MetaRow icon={META_ICON.membership} label="Принадлежность">
          {isArchitect ? (
            <span className="insp-value">
              {/* Тогл «включён» = ВНУТРЕННИЙ (решение пользователя 2026-09-04): свой
                  сервис — активный синий, чужой — серый, как точка у наблюдателя.
                  Подпись называет состояние, а не «что включает» тогл. */}
              <button type="button" className="insp-toggle" onClick={patch.toggleExternal} aria-pressed={!isExternal}>
                <span className={"insp-switch" + (isExternal ? "" : " is-on")} />
                {isExternal ? "Внешний" : "Внутренний"}
              </button>
            </span>
          ) : (
            <span className="insp-value">
              <span className="insp-dot" style={{ background: isExternal ? "#9ca3af" : "#2563eb" }} />
              {isExternal ? "Внешний" : "Внутренний"}
            </span>
          )}
        </MetaRow>

        <MetaRow icon={META_ICON.status} label="Статус">
          {isArchitect ? (
            <span className="insp-value">
              <span className="insp-selwrap">
                <button
                  type="button"
                  className="insp-field insp-select"
                  onClick={() => setStatusOpen((o) => !o)}
                  aria-haspopup="listbox"
                  aria-expanded={statusOpen}
                >
                  <span className="insp-dot" style={{ background: statusDot(status) }} />
                  <span className="insp-select-label">{STATUS_META[status].label}</span>
                  <span className="insp-chev"><ChevronDown /></span>
                </button>
                {statusOpen && (
                  <>
                    <div className="insp-backdrop" onClick={() => setStatusOpen(false)} />
                    <ul className="insp-menu" role="listbox">
                      {STATUS_ORDER.map((st) => (
                        <li
                          key={st}
                          role="option"
                          aria-selected={st === status}
                          onClick={() => pickStatus(st)}
                        >
                          <span className="insp-dot" style={{ background: statusDot(st) }} />
                          {STATUS_META[st].label}
                          {st === status && <span className="insp-menu-check"><CheckMark /></span>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </span>
            </span>
          ) : (
            <span className="insp-value">
              <span className="insp-dot" style={{ background: statusDot(node.status) }} />
              {STATUS_META[node.status].label}
            </span>
          )}
        </MetaRow>

        <MetaRow icon={META_ICON.role} label="Роль">
          {isArchitect ? (
            <span className="insp-value">
              <input
                {...noAutofill("node-inspector-3")}
                className="insp-field"
                value={role}
                onChange={(e) => patch.setRole(e.target.value)}
                onBlur={patch.commitRole}
                placeholder="сервис, БД, брокер…"
              />
            </span>
          ) : (
            <span className={"insp-value" + (node.role ? "" : " insp-value--empty")}>
              {node.role || "не указана"}
            </span>
          )}
        </MetaRow>

        {!isPerson && (
          <MetaRow icon={META_ICON.tech} label="Технология">
            {isContainer ? (
              // Контейнер: агрегированная технология потомков, только чтение.
              <span className={"insp-value" + (aggTech ? "" : " insp-value--empty")}>
                {techLoading ? "…" : aggTech || "не указана"}
              </span>
            ) : isArchitect ? (
              <span className="insp-value">
                <input
                  {...noAutofill("node-inspector-4")}
                  className="insp-field"
                  value={technology}
                  onChange={(e) => patch.setTechnology(e.target.value)}
                  onBlur={patch.commitTech}
                  placeholder="Python, Kafka, Redis…"
                />
              </span>
            ) : (
              <span className={"insp-value" + (node.technology ? "" : " insp-value--empty")}>
                {node.technology || "не указана"}
              </span>
            )}
          </MetaRow>
        )}
      </dl>

      {/* Источник — чем ArchMap опознаёт объект при обновлениях из кода. НЕ строкой
          меты, а отдельным блоком во всю ширину панели: у источника свои кнопки
          «Изменить»/«Очистить» и форма. Тот же компонент, что в карточке объекта. */}
      <div className="insp-block-label">Источник</div>
      <AnchorField
        source={node.source}
        isArchitect={isArchitect}
        onSave={patch.commitSource}
      />

      {/* Документация: управление схемами логики и спеками — только на странице
          узла; из редактора ведёт туда единая точка входа «Открыть». */}
      {!isPerson && (
        <>
          <div className="insp-block-label">Документация</div>
          <button type="button" className="insp-doc-item" onClick={() => onNavigateNode(node.id)}>
            <span className="insp-doc-name">Открыть</span>
          </button>
        </>
      )}

      {/* Удаление */}
      {isArchitect && (
        <button type="button" className="insp-del" onClick={() => setConfirming(true)}>
          {META_ICON.trash} Удалить объект
        </button>
      )}

      {element.dialog}

      {confirming && (
        <NodeDeleteConfirm
          node={node}
          onCancel={() => setConfirming(false)}
          onDeleted={(id, snapshot) => { setConfirming(false); onNodeDeleted(id, snapshot); }}
        />
      )}
    </div>
  );
}

// Строка «Элемент архитектуры» сразу под «Типом»: выпадашка того же вида, что «Статус»,
// пункты в две строки (подпись и пояснение), или текст только для чтения.
function ElementRow({ view, open, setOpen, onPick }: {
  view: ElementView;
  open: boolean;
  setOpen: (open: boolean) => void;
  onPick: (value: NodeElement) => void;
}) {
  if (view.kind === "none") return null;
  return (
    <MetaRow icon={META_ICON.type} label="Элемент архитектуры">
      {view.kind === "text" ? (
        <span className="insp-value">{view.text}</span>
      ) : (
        <span className="insp-value">
          <span className="insp-selwrap">
            <button
              type="button"
              className="insp-field insp-select"
              onClick={() => setOpen(!open)}
              aria-haspopup="listbox"
              aria-expanded={open}
            >
              <span className="insp-select-label">{ELEMENT_LABEL[view.value]}</span>
              <span className="insp-chev"><ChevronDown /></span>
            </button>
            {open && (
              <>
                <div className="insp-backdrop" onClick={() => setOpen(false)} />
                <ul className="insp-menu" role="listbox">
                  {ELEMENT_ORDER.map((el) => (
                    <li
                      key={el}
                      role="option"
                      aria-selected={el === view.value}
                      onClick={() => { setOpen(false); onPick(el); }}
                    >
                      <span className="insp-menu-two">
                        {ELEMENT_LABEL[el]}
                        <small>{ELEMENT_HINT[el]}</small>
                      </span>
                      {el === view.value && <span className="insp-menu-check"><CheckMark /></span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </span>
        </span>
      )}
    </MetaRow>
  );
}

function ChevronDown() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9 L12 15 L18 9" /></svg>;
}
function CheckMark() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12 L10 17 L19 7" /></svg>;
}
