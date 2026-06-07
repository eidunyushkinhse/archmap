import { useState } from "react";
import type { CSSProperties } from "react";
import type { Node, NodeCreate, NodeUpdate, NodeEdgeInfo, NodeShape } from "../types";
import { nodesApi } from "../api/nodes";
import { getUserRole } from "../api/auth";
import MermaidRenderer from "./MermaidRenderer";

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
  onSaved: (node: Node) => void;
  onDeleted?: (id: string) => void;
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

  // Подтверждение удаления: null — закрыто; массив (возможно пустой) — открыто
  const [deleteEdges, setDeleteEdges] = useState<NodeEdgeInfo[] | null>(null);
  const [deleting, setDeleting] = useState(false);

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
      onSaved(saved);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  // Шаг 1: запрашиваем связи узла и открываем модалку подтверждения
  async function requestDelete() {
    if (!node) return;
    setError(null);
    try {
      const edges = await nodesApi.getEdges(node.id);
      setDeleteEdges(edges);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось получить связи узла");
    }
  }

  // Шаг 2: подтверждённое удаление узла вместе со всеми связями
  async function confirmDelete() {
    if (!node) return;
    setDeleting(true);
    setError(null);
    try {
      await nodesApi.delete(node.id);
      setDeleteEdges(null);
      onDeleted?.(node.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка удаления");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div style={overlay}>
      <div style={modal}>
        <button onClick={onClose} style={closeBtn}>✕</button>
        <h2 style={{ margin: "0 0 16px" }}>{isCreate ? "Новый узел" : node!.name}</h2>

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
              Внешний сервис
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

            {error && <p style={{ color: "#dc2626", margin: "8px 0" }}>{error}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={handleSave} disabled={saving} style={primaryBtn}>
                {saving ? "Сохранение..." : "Сохранить"}
              </button>
              {!isCreate && (
                <button onClick={() => setEditing(false)} style={secondaryBtn}>
                  Отмена
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            {node!.description && (
              <p style={{ color: "#374151", marginBottom: 12 }}>{node!.description}</p>
            )}
            <div style={{ marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
              <span style={node!.is_external ? tagExternal : tagInternal}>
                {node!.is_external ? "Внешний" : "Внутренний"}
              </span>
              {node!.role && <span style={tag}>{node!.role}</span>}
              {node!.technology && <span style={{ ...tag, background: "#eff6ff", color: "#1d4ed8" }}>{node!.technology}</span>}
            </div>

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
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={() => setEditing(true)} style={primaryBtn}>
                  Редактировать
                </button>
                <button onClick={requestDelete} style={dangerBtn}>
                  Удалить
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Модалка подтверждения удаления со списком связей */}
      {deleteEdges !== null && node && (
        <div style={confirmOverlay}>
          <div style={confirmModal}>
            <h3 style={{ margin: "0 0 12px" }}>
              Вы уверены, что хотите удалить «{node.name}»?
            </h3>
            {deleteEdges.length > 0 && (
              <>
                <p style={{ color: "#374151", margin: "0 0 8px" }}>
                  Его связи будут удалены вместе с ним:
                </p>
                <ul style={edgeList}>
                  {deleteEdges.map((e) => {
                    const lbl = e.label || e.technology || "связь";
                    const dir = e.direction === "outgoing" ? "к" : "от";
                    return (
                      <li key={e.id} style={{ marginBottom: 4 }}>
                        «{lbl}» {dir} {e.other_node_name}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {error && <p style={{ color: "#dc2626", margin: "8px 0" }}>{error}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={confirmDelete} disabled={deleting} style={dangerBtn}>
                {deleting ? "Удаление..." : "Да, удалить"}
              </button>
              <button
                onClick={() => setDeleteEdges(null)}
                disabled={deleting}
                style={secondaryBtn}
              >
                Нет
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const confirmOverlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1100, // выше основной модалки узла
};
const confirmModal: CSSProperties = {
  background: "#fff",
  borderRadius: 10,
  padding: 24,
  width: 460,
  maxHeight: "80vh",
  overflowY: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,.2)",
};
const edgeList: CSSProperties = {
  margin: "0 0 4px",
  paddingLeft: 20,
  color: "#374151",
  fontSize: 14,
  lineHeight: 1.5,
};
const modal: CSSProperties = {
  background: "#fff",
  borderRadius: 10,
  padding: 28,
  width: 560,
  maxHeight: "90vh",
  overflowY: "auto",
  position: "relative",
  boxShadow: "0 8px 32px rgba(0,0,0,.18)",
};
const closeBtn: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  border: "none",
  background: "none",
  fontSize: 18,
  cursor: "pointer",
  color: "#6b7280",
};
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  marginBottom: 4,
};
const input: CSSProperties = {
  display: "block",
  width: "100%",
  marginBottom: 10,
  padding: "7px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
};
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
const primaryBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
const secondaryBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#f3f4f6",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
const dangerBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#dc2626",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
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
const tag: CSSProperties = {
  display: "inline-block",
  padding: "2px 10px",
  borderRadius: 12,
  background: "#f0fdf4",
  color: "#166534",
  fontSize: 12,
  marginRight: 6,
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
const tagInternal: CSSProperties = {
  display: "inline-block",
  padding: "2px 10px",
  borderRadius: 12,
  background: "#dbeafe",
  color: "#1e40af",
  fontSize: 12,
  fontWeight: 600,
};
const tagExternal: CSSProperties = {
  display: "inline-block",
  padding: "2px 10px",
  borderRadius: 12,
  background: "#f3f4f6",
  color: "#4b5563",
  fontSize: 12,
  fontWeight: 600,
};
const sectionHead: CSSProperties = {
  margin: "0 0 8px",
  fontSize: 14,
  color: "#6b7280",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".04em",
};
