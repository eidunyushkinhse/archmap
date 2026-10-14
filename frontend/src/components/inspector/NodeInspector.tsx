// Мета узла в правой панели: просмотр (наблюдатель) и inline-правка (архитектор).
// Перенос ветки «просмотр/правка» из NodeModal (создание осталось в модалке). Inline-
// правка коммитится по blur (тексты) / сразу (toggle/статус) и ложится в Undo/Redo через
// тот же onNodeSaved, что и модалка. Документация (схемы логики/OpenAPI) в редакторе
// не управляется — единый раздел «Документация» ведёт на страницу узла.
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { DeletionSnapshot, Node, NodeShape, NodeStatus } from "../../types";
import { canHaveChildren } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { ShapeGlyph } from "../nodeTree.shared";
import NodeDeleteConfirm from "../NodeDeleteConfirm";
import AnchorField from "../anchor/AnchorField";
import { useContainerChildren } from "../../pages/useContainerChildren";
import { useNodePatch } from "../../pages/useNodePatch";
import "./inspector.css";
import { noAutofill } from "../../ui/noAutofill";
import { SHAPE_LABEL, SHAPE_ORDER, STATUS_ORDER } from "../nodeTerms";

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
  const [confirming, setConfirming] = useState(false);
  // Тип показываем из самого узла (пропа): он обновится тем же путём, что имя
  // (onNodeSaved → данные узла в редакторе → холст), а при отказе 400 показанный тип
  // остаётся прежним, потому что прошлое значение никто не перетирал.
  const shape = node.shape;
  const isPerson = shape === "person";
  const isContainer = canHaveChildren(shape) && node.has_children;
  // Агрегированная технология потомков для контейнера: по правилам у контейнера
  // нет своей технологии — показываем сумму технологий потомков, read-only
  // (как на странице узла). Для не-контейнеров хук ничего не фетчит.
  const container = useContainerChildren(node.id, isContainer);

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

      {/* Список меты «терм → значение» */}
      <dl className="insp-meta">
        <Row icon={META_ICON.type} label="Тип">
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
        </Row>

        <Row icon={META_ICON.placement} label="Размещение">
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
        </Row>

        <Row icon={META_ICON.status} label="Статус">
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
        </Row>

        <Row icon={META_ICON.role} label="Роль">
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
        </Row>

        {!isPerson && (
          <Row icon={META_ICON.tech} label="Технология">
            {isContainer ? (
              // Контейнер: агрегированная технология потомков, только чтение.
              <span className={"insp-value" + (container.aggTech ? "" : " insp-value--empty")}>
                {container.loading ? "…" : container.aggTech || "не указана"}
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
          </Row>
        )}
      </dl>

      {/* Якорь — чем ArchMap опознаёт объект при обновлениях из кода. НЕ строкой
          меты, а отдельным блоком во всю ширину панели: в колонке значения
          (≈140px при терме 104px) репозиторий не помещается ни в чтении, ни в
          форме — рвался посреди слова. Тот же компонент, что в карточке объекта. */}
      <div className="insp-block-label">Якорь</div>
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

// Строка меты «терм → значение». dd — нейтральная флекс-ячейка; само значение несёт
// класс .insp-value (его передаёт вызывающий — текст у наблюдателя / поле у архитектора).
function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="insp-row">
      <dt className="insp-term">
        <span className="insp-term-ico">{icon}</span>
        {label}
      </dt>
      <dd style={{ margin: 0, flex: 1, minWidth: 0, display: "flex" }}>{children}</dd>
    </div>
  );
}


// Линейные иконки термов (16×16, currentColor). Порт META_ICON из NodeModal + flow/api/trash.
const ms = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
} as const;
const META_ICON: Record<"type" | "placement" | "status" | "role" | "tech" | "flow" | "api" | "trash", ReactNode> = {
  type: <svg {...ms}><rect x="2.75" y="3.5" width="10.5" height="9" rx="1.5" /><path d="M2.75 6.25h10.5" /></svg>,
  placement: <svg {...ms}><circle cx="8" cy="8" r="5.25" /><path d="M2.75 8h10.5" /><path d="M8 2.75c1.7 1.6 1.7 9 0 10.5c-1.7-1.5-1.7-8.9 0-10.5Z" /></svg>,
  status: <svg {...ms}><path d="M1.75 8h2.5l1.6-3.8 2.2 7.2 1.7-5 1 1.6h3.5" /></svg>,
  role: <svg {...ms}><path d="M4 2.9h8v10.2l-4-2.6-4 2.6Z" /></svg>,
  tech: <svg {...ms}><path d="M6 5.4 3 8l3 2.6" /><path d="M10 5.4 13 8l-3 2.6" /></svg>,
  flow: <svg {...ms}><circle cx="4" cy="4" r="1.8" /><circle cx="12" cy="8" r="1.8" /><circle cx="4" cy="12" r="1.8" /><path d="M5.6 4H9a1.7 1.7 0 0 1 1.7 1.7v.6 M5.6 12H9a1.7 1.7 0 0 0 1.7-1.7v-.6" /></svg>,
  api: <svg {...ms}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 6.5 3.5 8 5 9.5 M11 6.5 12.5 8 11 9.5 M8.6 5.7 7.4 10.3" /></svg>,
  trash: <svg {...ms} width={15} height={15}><path d="M3 4.2h10 M5.5 4.2V3h5v1.2 M4.2 4.2l.6 8.3a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.3" /></svg>,
};

function ChevronDown() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9 L12 15 L18 9" /></svg>;
}
function CheckMark() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12 L10 17 L19 7" /></svg>;
}
