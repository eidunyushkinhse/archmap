// Мета узла в правой панели: просмотр (наблюдатель) и inline-правка (архитектор).
// Перенос ветки «просмотр/правка» из NodeModal (создание осталось в модалке). Inline-
// правка коммитится по blur (тексты) / сразу (toggle/статус) и ложится в Undo/Redo через
// тот же onNodeSaved, что и модалка. Документация (схемы логики/OpenAPI) в редакторе
// не управляется — единый раздел «Документация» ведёт на страницу узла.
import { useCallback, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { DeletionSnapshot, Node, NodeShape, NodeStatus, NodeUpdate } from "../../types";
import { canHaveChildren } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { nodesApi } from "../../api/nodes";
import { ApiError, isConflict } from "../../api/client";
import { ShapeGlyph } from "../nodeTree.shared";
import NodeDeleteConfirm from "../NodeDeleteConfirm";
import { useContainerChildren } from "../../pages/useContainerChildren";
import "./inspector.css";

interface Props {
  node: Node;
  isArchitect: boolean;
  // Тот же обработчик, что у модалки: кладёт правку в Undo/Redo. before — узел ДО правки.
  onNodeSaved: (saved: Node, isCreate: boolean, before?: Node) => void;
  onNodeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  // Переход на страницу узла (раздел «Документация» → «Открыть»).
  onNavigateNode: (nodeId: string) => void;
}

const STATUS_ORDER: NodeStatus[] = ["existing", "planned", "deprecated"];
// Порядок типов в выпадашке — от самого частого (сервис) к самому редкому.
const SHAPE_ORDER: NodeShape[] = ["service", "database", "broker", "person"];

// Плашка-уведомление панели: и конфликт версий, и отказ сервера с причиной.
const noticeStyle: CSSProperties = {
  color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d",
  borderRadius: 8, padding: "6px 10px", fontSize: 12.5, margin: "0 0 10px",
};

export default function NodeInspector({ node, isArchitect, onNodeSaved, onNodeDeleted, onNavigateNode }: Props) {
  // Локальные значения полей. Сбрасываются на смену выбора: ObjectInspector монтирует
  // NodeInspector с key=node.id, поэтому при выборе другого узла компонент перемонтируется.
  const [name, setName] = useState(node.name);
  const [description, setDescription] = useState(node.description ?? "");
  const [role, setRole] = useState(node.role ?? "");
  const [technology, setTechnology] = useState(node.technology ?? "");
  const [isExternal, setIsExternal] = useState(node.is_external);
  const [status, setStatus] = useState<NodeStatus>(node.status);
  const [statusOpen, setStatusOpen] = useState(false);
  const [shapeOpen, setShapeOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Конфликт конкурентных сессий (409 CAS): правка не применилась, данные
  // обновлены с сервера — пользователь повторяет правку поверх свежего.
  const [conflict, setConflict] = useState<string | null>(null);
  // Отказ сервера с причиной (400: смена типа у узла с детьми / у базы с описанной
  // структурой). Гаснет при следующей успешной правке.
  const [error, setError] = useState<string | null>(null);

  // Узел ДО последней правки — для обратимой записи в историю. Обновляем после
  // успешного коммита.
  const beforeRef = useRef<Node>(node);
  const shape = node.shape;
  const isPerson = shape === "person";
  const isContainer = canHaveChildren(shape) && node.has_children;
  // Агрегированная технология потомков для контейнера: по правилам у контейнера
  // нет своей технологии — показываем сумму технологий потомков, read-only
  // (как на странице узла). Для не-контейнеров хук ничего не фетчит.
  const container = useContainerChildren(node.id, isContainer);

  // Единый коммит: собирает полный NodeUpdate из локального состояния + правленого поля
  // (over перекрывает то, что ещё не доехало в стейт на момент blur). openapi_spec
  // переносим из beforeRef без изменений — документацией управляет страница узла;
  // схемы логики живут отдельным API (node_docs), не здесь.
  const save = useCallback(
    async (over: Partial<NodeUpdate>) => {
      const before = beforeRef.current;
      const payload: NodeUpdate = {
        name: name.trim() || before.name,
        description: description || null,
        role: role || null,
        technology: technology || null,
        openapi_spec: before.openapi_spec,
        is_external: isExternal,
        shape: before.shape,
        status,
        ...over,
        // CAS (этап 0 конкурентности): правка от версии последнего сохранённого;
        // узел изменён другой сессией → 409 (ветка conflict ниже), не тихий LWW.
        base_version: before.version,
      };
      try {
        const saved = await nodesApi.update(node.id, payload);
        onNodeSaved(saved, false, before);
        beforeRef.current = saved;
        setConflict(null);
        setError(null);
      } catch (e: unknown) {
        if (!isConflict(e)) {
          // Отказ с причиной (400: смена типа у узла с детьми / у базы со
          // структурой). Раньше прочие ошибки уходили молча — правка «не
          // срабатывала» без объяснения; показываем текст сервера плашкой.
          setConflict(null);
          setError(e instanceof ApiError ? e.message : "Правка не сохранена");
          return;
        }
        // 409: подтягиваем свежие данные (правка НЕ применилась — чужая работа цела),
        // показываем плашку; в историю ничего не кладём (onNodeSaved не зовём).
        try {
          const fresh = await nodesApi.get(node.id);
          beforeRef.current = fresh;
          setName(fresh.name);
          setDescription(fresh.description ?? "");
          setRole(fresh.role ?? "");
          setTechnology(fresh.technology ?? "");
          setIsExternal(fresh.is_external);
          setStatus(fresh.status);
        } catch {
          // узел могли удалить — уровень догонит поллинг/ресинк
        }
        setError(null);
        setConflict("Узел изменён в другой сессии — данные обновлены, повторите правку");
      }
    },
    [name, description, role, technology, isExternal, status, node.id, onNodeSaved],
  );

  // Коммитим только при реальном изменении (не плодим пустые записи истории). Пустое
  // имя по blur откатываем к прежнему — оно обязательно.
  const commitName = () => {
    const t = name.trim();
    if (!t) { setName(beforeRef.current.name); return; }
    if (t === beforeRef.current.name) return;
    void save({ name: t });
  };
  const commitDesc = () => {
    if (description === (beforeRef.current.description ?? "")) return;
    void save({ description: description || null });
  };
  const commitRole = () => {
    if (role === (beforeRef.current.role ?? "")) return;
    void save({ role: role || null });
  };
  const commitTech = () => {
    if (technology === (beforeRef.current.technology ?? "")) return;
    void save({ technology: technology || null });
  };
  const toggleExternal = () => {
    const next = !isExternal;
    setIsExternal(next);
    void save({ is_external: next });
  };
  const pickStatus = (st: NodeStatus) => {
    setStatusOpen(false);
    if (st === status) return;
    setStatus(st);
    void save({ status: st });
  };
  // Смена типа: локального зеркала у формы нет осознанно — значение показываем из
  // самого узла (пропа), который обновится тем же путём, что имя (onNodeSaved →
  // данные узла в редакторе → холст). Отказ 400 приезжает плашкой, и показанный
  // тип остаётся прежним, потому что прошлое значение никто не перетирал.
  const pickShape = (sh: NodeShape) => {
    setShapeOpen(false);
    if (sh === shape) return;
    void save({ shape: sh });
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
              className="insp-field insp-field--name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
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
          className="insp-field insp-fieldarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={commitDesc}
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
              <button type="button" className="insp-toggle" onClick={toggleExternal} aria-pressed={isExternal}>
                <span className={"insp-switch" + (isExternal ? " is-on" : "")} />
                Внешний
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
                className="insp-field"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                onBlur={commitRole}
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
                  className="insp-field"
                  value={technology}
                  onChange={(e) => setTechnology(e.target.value)}
                  onBlur={commitTech}
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

// Форма узла → человекочитаемая подпись типа.
const SHAPE_LABEL: Record<NodeShape, string> = {
  service: "Сервис",
  database: "База данных",
  broker: "Брокер сообщений",
  person: "Пользователь",
};

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
