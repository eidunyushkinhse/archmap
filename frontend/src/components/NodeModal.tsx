import { useState } from "react";
import type { CSSProperties } from "react";
import type { Node, NodeCreate, NodeUpdate, NodeShape } from "../types";
import { nodesApi } from "../api/nodes";
import { getUserRole } from "../api/auth";
import MermaidRenderer from "./MermaidRenderer";
import NodeDeleteConfirm from "./NodeDeleteConfirm";
import Modal from "../ui/Modal";
import { labelStyle, input, primaryBtn, secondaryBtn, dangerBtn } from "../ui/styles";

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

  // Открыто ли подтверждение удаления (связи и само удаление — в NodeDeleteConfirm)
  const [confirming, setConfirming] = useState(false);

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

  return (
    <Modal onClose={onClose} boxStyle={{ width: 560, maxHeight: "90vh", overflowY: "auto" }}>
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
                <button onClick={() => setConfirming(true)} style={dangerBtn}>
                  Удалить
                </button>
              </div>
            )}
          </>
        )}

      {/* Подтверждение удаления со списком связей — общий компонент (он же
          открывается при удалении узла с канваса по Backspace). Свой <dialog>
          поверх — верхний в top-layer, Escape закрывает только его. */}
      {confirming && node && (
        <NodeDeleteConfirm
          node={node}
          onCancel={() => setConfirming(false)}
          onDeleted={(id) => { setConfirming(false); onDeleted?.(id); }}
        />
      )}
    </Modal>
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
