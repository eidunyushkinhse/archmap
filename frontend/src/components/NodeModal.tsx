import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { DeletionSnapshot, Node, NodeCreate, NodeUpdate, NodeShape } from "../types";
import { canHaveChildren, compareByRank, withoutPersons } from "../types";
import { nodesApi } from "../api/nodes";
import { getUserRole } from "../api/auth";
import MermaidRenderer from "./MermaidRenderer";
import NodeDeleteConfirm from "./NodeDeleteConfirm";
import Modal from "../ui/Modal";
import { labelStyle, input, primaryBtn, secondaryBtn, dangerBtn } from "../ui/styles";
import { ShapeGlyph, Chevron } from "./nodeTree.shared";
import "./nodeModal.css";
import "./NodeTreePanel.css";

interface Props {
  node: Node | null;
  parentId: string | null;
  // Форма узла. В режиме создания приходит из перетянутого шаблона (сервис/БД/
  // брокер/пользователь) — поэтому поля «Отображение» в модалке больше нет.
  // В режиме редактирования игнорируется (берётся из самого узла).
  shape?: NodeShape;
  // Координаты, куда бросили шаблон на схему (только для создания).
  initialPos?: { x: number; y: number } | null;
  onClose: () => void;
  // isCreate — true, если узел создан (а не отредактирован): нужно TreePage, чтобы
  // положить в историю команду создания (undo=delete) вместо команды правки полей.
  onSaved: (node: Node, isCreate: boolean) => void;
  // snapshot — снимок поддерева для отката удаления (Undo); пробрасывается из NodeDeleteConfirm.
  onDeleted?: (id: string, snapshot: DeletionSnapshot) => void;
}

export default function NodeModal({
  node, parentId, shape: templateShape, initialPos, onClose, onSaved, onDeleted,
}: Props) {
  const isArchitect = getUserRole() === "architect";
  const isCreate = node === null;
  const [editing, setEditing] = useState(isCreate);

  const [name, setName] = useState(node?.name ?? "");
  const [description, setDescription] = useState(node?.description ?? "");
  const [role, setRole] = useState(node?.role ?? "");
  const [technology, setTechnology] = useState(node?.technology ?? "");
  const [flowchart, setFlowchart] = useState(node?.flowchart ?? "");
  const [openapi, setOpenapi] = useState(node?.openapi_spec ?? "");
  const [isExternal, setIsExternal] = useState(node?.is_external ?? false);
  // Форма узла не редактируется в модалке: при создании — из шаблона, при
  // редактировании — из самого узла. Используется для скрытия полей у person.
  const shape: NodeShape = node?.shape ?? templateShape ?? "service";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flowTab, setFlowTab] = useState<"edit" | "preview">("edit");

  // Открыто ли подтверждение удаления (связи и само удаление — в NodeDeleteConfirm)
  const [confirming, setConfirming] = useState(false);

  // Прямые дети узла для справочной ветки «Дочерние объекты» (только просмотр).
  // null — ещё грузим (показываем плейсхолдер, НЕ мигаем «Нет»); [] — детей нет.
  const [rootKids, setRootKids] = useState<Node[] | null>(null);
  useEffect(() => {
    if (isCreate || editing) return; // ветка нужна только в просмотре существующего узла
    let alive = true;
    nodesApi.getChildren(node!.id)
      .then((cs) => { if (alive) setRootKids(withoutPersons(cs).sort(compareByRank)); })
      .catch(() => { if (alive) setRootKids([]); });
    return () => { alive = false; };
  }, [node, isCreate, editing]);

  // У какого края прокрутки находимся: пока есть скрытый контент за липкими
  // шапкой/полосой действий — у их края виден разделитель; у самого верха/низа
  // он плавно гаснет (см. nodeModal.css). Маяки — невидимые div'ы у краёв контента.
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  // Один IntersectionObserver на оба маяка: их пересечение со скролл-контейнером
  // (<dialog> модалки) и есть «мы у этого края». Пересборка при смене режима
  // (editing): у просмотра и редактирования разные футеры — маяки перемонтируются.
  useEffect(() => {
    const top = topSentinelRef.current;
    const bottom = bottomSentinelRef.current;
    const root = (top ?? bottom)?.closest("dialog");
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.target === top) setAtTop(e.isIntersecting);
          if (e.target === bottom) setAtBottom(e.isIntersecting);
        }
      },
      { root },
    );
    if (top) io.observe(top);
    if (bottom) io.observe(bottom);
    return () => io.disconnect();
  }, [editing]);

  const headerClass = `nm-header${atTop ? " nm-header--at-top" : ""}`;
  const footerClass = `nm-footer${atBottom ? " nm-footer--at-bottom" : ""}`;

  async function handleSave() {
    if (!name.trim()) {
      setError("Название обязательно");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let saved: Node;
      if (isCreate) {
        const data: NodeCreate = {
          name: name.trim(),
          description: description || null,
          role: role || null,
          technology: technology || null,
          parent_id: parentId,
          flowchart: flowchart || null,
          openapi_spec: openapi || null,
          is_external: isExternal,
          shape,
          // координаты места, куда бросили шаблон (если узел создаётся дрэгом)
          pos_x: initialPos?.x ?? null,
          pos_y: initialPos?.y ?? null,
        };
        saved = await nodesApi.create(data);
      } else {
        const data: NodeUpdate = {
          name: name.trim(),
          description: description || null,
          role: role || null,
          technology: technology || null,
          flowchart: flowchart || null,
          openapi_spec: openapi || null,
          is_external: isExternal,
          shape,
        };
        saved = await nodesApi.update(node!.id, data);
      }
      onSaved(saved, isCreate);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 560, maxHeight: "90vh", overflowY: "auto" }}>
      {/* Липкая шапка: название узла и крестик всегда видны. Свой крестик вместо
          дефолтного (closeButton={false}) — тот рисуется абсолютом на <dialog> и
          уезжает при прокрутке. Маяк верха — первым, чтобы ловить позицию у края. */}
      <div ref={topSentinelRef} style={{ height: 1 }} aria-hidden />
      <div className={headerClass}>
        <h2>{isCreate ? "Новый узел" : node!.name}</h2>
        <button onClick={onClose} className="nm-close" aria-label="Закрыть">✕</button>
      </div>

        {editing ? (
          <>
            <label style={labelStyle}>Название *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} style={input} />

            <label style={labelStyle}>Описание</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={textarea} rows={2} />

            <label style={labelStyle}>Роль</label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="сервис, БД, брокер..."
              style={input}
            />

            {/* Для пользователя «Технология» бессмысленна — скрываем (как и
                Flowchart/OpenAPI ниже). Поле зависит от выбора в «Отображение». */}
            {shape !== "person" && (
              <>
                <label style={labelStyle}>Технология</label>
                <input
                  value={technology}
                  onChange={(e) => setTechnology(e.target.value)}
                  placeholder="Python, Kafka, Redis..."
                  style={input}
                />
              </>
            )}

            <label style={toggleRow}>
              <input
                type="checkbox"
                checked={isExternal}
                onChange={(e) => setIsExternal(e.target.checked)}
                style={{ marginRight: 8, cursor: "pointer" }}
              />
              Внешний
            </label>

            {/* Flowchart и OpenAPI у пользователя тоже лишние — скрываем для person */}
            {shape !== "person" && (
              <>
                <label style={labelStyle}>Flowchart (Mermaid)</label>
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <button
                    onClick={() => setFlowTab("edit")}
                    style={flowTab === "edit" ? activeTab : tabBtn}
                  >
                    Редактор
                  </button>
                  <button
                    onClick={() => setFlowTab("preview")}
                    style={flowTab === "preview" ? activeTab : tabBtn}
                  >
                    Превью
                  </button>
                </div>
                {flowTab === "edit" ? (
                  <textarea
                    value={flowchart}
                    onChange={(e) => setFlowchart(e.target.value)}
                    style={{ ...textarea, fontFamily: "monospace", fontSize: 13 }}
                    rows={5}
                    placeholder={"graph TD\n  A[Старт] --> B[Конец]"}
                  />
                ) : (
                  <div style={previewBox}>
                    {flowchart.trim() ? (
                      <MermaidRenderer chart={flowchart} />
                    ) : (
                      <span style={{ color: "#9ca3af" }}>Нет диаграммы</span>
                    )}
                  </div>
                )}

                <label style={labelStyle}>OpenAPI YAML</label>
                <textarea
                  value={openapi}
                  onChange={(e) => setOpenapi(e.target.value)}
                  style={{ ...textarea, fontFamily: "monospace", fontSize: 12 }}
                  rows={6}
                  placeholder={"openapi: 3.0.0\ninfo:\n  title: My API\n  version: 1.0.0"}
                />
              </>
            )}

            {/* Маяк низа прокрутки (см. эффект с IntersectionObserver) */}
            <div ref={bottomSentinelRef} style={{ height: 1 }} aria-hidden />
            <div className={footerClass}>
              {error && <p style={errStyle}>{error}</p>}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={handleSave} disabled={saving} style={primaryBtn}>
                  {saving ? "Сохранение..." : "Сохранить"}
                </button>
                {!isCreate && (
                  <button onClick={() => setEditing(false)} style={secondaryBtn}>
                    Отмена
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            {node!.description && (
              <p style={{ color: "#374151", marginBottom: 12 }}>{node!.description}</p>
            )}
            {/* Метаданные узла — подписанный список «свойство → значение» с иконками
                (Вариант A из дизайн-хэндоффа). Подпись слева снимает неоднозначность
                чипов; пустые Роль/Технология показываем плейсхолдером, а не прячем. */}
            {(() => {
              const rows: Array<{
                key: string; icon: ReactNode; label: string;
                value: string; empty?: boolean; dot?: string;
              }> = [
                { key: "type", icon: META_ICON.type, label: "Тип", value: SHAPE_LABEL[node!.shape] },
                {
                  key: "placement", icon: META_ICON.placement, label: "Размещение",
                  value: node!.is_external ? "Внешний" : "Внутренний",
                  dot: node!.is_external ? "#9ca3af" : "#2563eb",
                },
                {
                  key: "role", icon: META_ICON.role, label: "Роль",
                  value: node!.role || "не указана", empty: !node!.role,
                },
              ];
              if (node!.shape !== "person") {
                rows.push({
                  key: "tech", icon: META_ICON.tech, label: "Технология",
                  value: node!.technology || "не указана", empty: !node!.technology,
                });
              }
              // Состояние ветки детей: null — ещё грузим (плейсхолдер), [] — «Нет».
              const loadingKids = rootKids === null;
              const kids = rootKids ?? [];
              const hasKids = kids.length > 0;
              return (
                <dl style={metaList}>
                  {rows.map((r) => (
                    <div key={r.key} style={metaRow}>
                      <dt style={metaTerm}>
                        <span style={metaIconWrap}>{r.icon}</span>
                        {r.label}
                      </dt>
                      <dd style={{ ...metaValue, ...(r.empty ? metaValueEmpty : null) }}>
                        {r.dot && <span style={{ ...metaDot, background: r.dot }} />}
                        {r.value}
                      </dd>
                    </div>
                  ))}
                  {/* Строка «Дочерние объекты»: тот же ряд метаданных, но в колонке
                      значения — справочная ветка дерева либо «Нет» (во время загрузки
                      «Нет» НЕ мигаем). При наличии детей терм выравниваем по верху. */}
                  <div style={{ ...metaRow, alignItems: hasKids ? "flex-start" : "center" }}>
                    <dt style={{ ...metaTerm, ...(hasKids ? { alignSelf: "flex-start", paddingTop: 6 } : null) }}>
                      <span style={metaIconWrap}>{META_ICON.children}</span>
                      Дочерние объекты
                    </dt>
                    <dd style={{ ...metaValue, display: "block", flex: 1, minWidth: 0 }}>
                      {loadingKids ? (
                        <span style={metaValueEmpty}>загрузка…</span>
                      ) : hasKids ? (
                        <div className="nt-tree nt-tree--inline">
                          {kids.map((k) => <ModalTreeRow key={k.id} node={k} />)}
                        </div>
                      ) : (
                        <span style={metaValueEmpty}>Нет</span>
                      )}
                    </dd>
                  </div>
                </dl>
              );
            })()}

            <h4 style={sectionHead}>Flowchart</h4>
            {node!.flowchart ? (
              <div style={previewBox}>
                <MermaidRenderer chart={node!.flowchart} />
              </div>
            ) : (
              <p style={{ color: "#9ca3af", margin: "0 0 12px" }}>Нет диаграммы</p>
            )}

            <h4 style={sectionHead}>OpenAPI</h4>
            {node!.openapi_spec ? (
              <pre style={preBlock}>{node!.openapi_spec}</pre>
            ) : (
              <p style={{ color: "#9ca3af", margin: "0 0 12px" }}>Нет спеки</p>
            )}

            {isArchitect && (
              <>
                {/* Маяк низа прокрутки (см. эффект с IntersectionObserver) */}
                <div ref={bottomSentinelRef} style={{ height: 1 }} aria-hidden />
                <div className={footerClass}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setEditing(true)} style={primaryBtn}>
                      Редактировать
                    </button>
                    <button onClick={() => setConfirming(true)} style={dangerBtn}>
                      Удалить
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
    </Modal>

      {/* Подтверждение удаления со списком связей — общий компонент (он же
          открывается при удалении узла с канваса по Backspace). Рендерим
          СИБЛИНГОМ, а не внутри <dialog> узла: вложенный <dialog> бубблил бы
          событие cancel (Escape) на родителя и закрывал бы обе модалки разом.
          Как сиблинг — отдельный <dialog> поверх в top-layer, Escape закрывает
          только его. */}
      {confirming && node && (
        <NodeDeleteConfirm
          node={node}
          onCancel={() => setConfirming(false)}
          onDeleted={(id, snapshot) => { setConfirming(false); onDeleted?.(id, snapshot); }}
        />
      )}
    </>
  );
}

// Строка справочной ветки детей в модалке: мини-аналог Row из NodeTreePanel, но
// БЕЗ построчного клика (drill/контекст) и без подписи действия — работает только
// раскрытие шевроном с ленивой подгрузкой. Глиф формы/шеврон/направляющая —
// общие с деревом слева (nodeTree.shared + классы nt-* из NodeTreePanel.css).
function ModalTreeRow({ node }: { node: Node }) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<Node[] | null>(null);
  const [loading, setLoading] = useState(false);
  const expandable = canHaveChildren(node.shape) && node.has_children;

  async function toggle() {
    if (open) { setOpen(false); return; }
    if (kids === null) {
      setLoading(true);
      try {
        const got = withoutPersons(await nodesApi.getChildren(node.id)).sort(compareByRank);
        setKids(got);
        if (got.length === 0) return; // после отсева персон — лист, не раскрываем
      } finally { setLoading(false); }
    } else if (kids.length === 0) { return; }
    setOpen(true);
  }

  const isContainer = expandable; // глиф «коробка с крышкой» как в дереве
  return (
    <>
      <div className="nt-row">
        {expandable ? (
          <button className="nt-chevzone" onClick={toggle}
            aria-label={open ? "Свернуть ветку" : "Развернуть ветку"} aria-expanded={open}>
            <span className="nt-chevhit">
              <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}>
                {loading ? "⋯" : <Chevron />}
              </span>
            </span>
          </button>
        ) : <span className="nt-chevspacer" />}
        <ShapeGlyph container={isContainer} shape={node.shape} />
        <span className={isContainer ? "nt-name nt-name--container" : "nt-name"}>{node.name}</span>
      </div>
      {open && kids && kids.length > 0 && (
        <div className="nt-children">{kids.map((k) => <ModalTreeRow key={k.id} node={k} />)}</div>
      )}
    </>
  );
}

const textarea: CSSProperties = {
  display: "block",
  width: "100%",
  marginBottom: 10,
  padding: "7px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
  resize: "vertical",
};
const tabBtn: CSSProperties = {
  padding: "4px 14px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "#f9fafb",
  cursor: "pointer",
  fontSize: 13,
};
const activeTab: CSSProperties = {
  padding: "4px 14px",
  border: "1px solid #2563eb",
  borderRadius: 6,
  background: "#2563eb",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const previewBox: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  padding: 12,
  minHeight: 60,
  marginBottom: 10,
  background: "#fafafa",
};
const preBlock: CSSProperties = {
  background: "#f4f4f5",
  padding: 12,
  borderRadius: 6,
  overflowX: "auto",
  fontSize: 12,
  fontFamily: "monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  marginBottom: 12,
};
const errStyle: CSSProperties = {
  color: "#dc2626",
  margin: "0 0 8px",
};
const toggleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontSize: 14,
  fontWeight: 500,
  color: "#374151",
  marginBottom: 12,
  cursor: "pointer",
  userSelect: "none",
};
const sectionHead: CSSProperties = {
  margin: "0 0 8px",
  fontSize: 14,
  color: "#6b7280",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".04em",
};

// --- Метаданные узла (режим просмотра): список «свойство → значение» ---

// Форма узла → человекочитаемая подпись типа (словом, без C4-иконки формы).
const SHAPE_LABEL: Record<NodeShape, string> = {
  service: "Сервис",
  database: "База данных",
  broker: "Брокер сообщений",
  person: "Пользователь",
};

// Базовые атрибуты линейных иконок полей (16×16).
const metaSvg = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5,
  strokeLinecap: "round", strokeLinejoin: "round",
} as const;

// Иконки: Тип (компонент-бокс), Размещение (глобус), Роль (закладка), Технология (</>),
// Дочерние объекты (мини-оргсхема «родитель → два потомка»).
const META_ICON: Record<"type" | "placement" | "role" | "tech" | "children", ReactNode> = {
  type: <svg {...metaSvg}><rect x="2.75" y="3.5" width="10.5" height="9" rx="1.5" /><path d="M2.75 6.25h10.5" /></svg>,
  placement: <svg {...metaSvg}><circle cx="8" cy="8" r="5.25" /><path d="M2.75 8h10.5" /><path d="M8 2.75c1.7 1.6 1.7 9 0 10.5c-1.7-1.5-1.7-8.9 0-10.5Z" /></svg>,
  role: <svg {...metaSvg}><path d="M4 2.9h8v10.2l-4-2.6-4 2.6Z" /></svg>,
  tech: <svg {...metaSvg}><path d="M6 5.4 3 8l3 2.6" /><path d="M10 5.4 13 8l-3 2.6" /></svg>,
  children: <svg {...metaSvg}>
    <rect x="6" y="2.5" width="4" height="3" rx="0.6" />
    <rect x="1.75" y="10.5" width="4" height="3" rx="0.6" />
    <rect x="10.25" y="10.5" width="4" height="3" rx="0.6" />
    <path d="M8 5.5V8 M3.75 8H12.25 M3.75 8V10.5 M12.25 8V10.5" />
  </svg>,
};

const metaList: CSSProperties = { margin: "0 0 12px", borderTop: "1px solid #eef0f2" };
const metaRow: CSSProperties = {
  display: "flex", gap: 12, alignItems: "center",
  padding: "10px 0", borderBottom: "1px solid #f3f4f6",
};
const metaTerm: CSSProperties = {
  display: "flex", alignItems: "center", gap: 9,
  width: 156, flexShrink: 0, color: "#6b7280", fontSize: 13, fontWeight: 600,
};
const metaIconWrap: CSSProperties = { display: "flex", color: "#9ca3af" };
// NB: metaValue стоит на <dd> — обязательно margin:0, иначе UA-стиль
// margin-inline-start:40px сдвинет значение.
const metaValue: CSSProperties = {
  margin: 0, display: "flex", alignItems: "center", gap: 8,
  fontSize: 14, color: "#111827",
};
const metaValueEmpty: CSSProperties = { color: "#9ca3af", fontStyle: "italic" };
const metaDot: CSSProperties = { width: 7, height: 7, borderRadius: 4, flexShrink: 0 };
