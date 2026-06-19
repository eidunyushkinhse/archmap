// Оверлей тяжёлого поля меты (Flowchart / OpenAPI) — единственная оставшаяся модалка
// меты объекта. В узкую правую панель Mermaid-редактор и YAML не помещаются, поэтому
// открываются окном по кнопке-строке. Наблюдателю — только просмотр; архитектору —
// редактирование с тем же inline-сохранением (blur → onCommit → nodesApi.update → история).
import { useState } from "react";
import type { CSSProperties } from "react";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import MermaidRenderer from "../MermaidRenderer";

interface Props {
  mode: "flowchart" | "openapi";
  nodeName: string;
  flowchart: string;
  openapi: string;
  isArchitect: boolean;
  onCommit: (field: "flowchart" | "openapi_spec", value: string) => void;
  onClose: () => void;
}

export default function DocOverlay({ mode, nodeName, flowchart, openapi, isArchitect, onCommit, onClose }: Props) {
  const [flow, setFlow] = useState(flowchart);
  const [api, setApi] = useState(openapi);
  const [flowTab, setFlowTab] = useState<"edit" | "preview">(isArchitect ? "edit" : "preview");

  const title = `${nodeName} · ${mode === "flowchart" ? "Flowchart" : "OpenAPI"}`;

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 620, maxHeight: "90vh", overflowY: "auto" }}>
      <div style={head}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
      </div>

      {mode === "flowchart" ? (
        <>
          {isArchitect && (
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <button onClick={() => setFlowTab("edit")} style={flowTab === "edit" ? activeTab : tabBtn}>Редактор</button>
              <button onClick={() => setFlowTab("preview")} style={flowTab === "preview" ? activeTab : tabBtn}>Превью</button>
            </div>
          )}
          {isArchitect && flowTab === "edit" ? (
            <textarea
              value={flow}
              onChange={(e) => setFlow(e.target.value)}
              onBlur={() => onCommit("flowchart", flow)}
              style={{ ...textarea, fontFamily: "monospace", fontSize: 13 }}
              rows={12}
              placeholder={"graph TD\n  A[Старт] --> B[Конец]"}
            />
          ) : (
            <div style={previewBox}>
              {flow.trim() ? <MermaidRenderer chart={flow} /> : <span style={{ color: "#9ca3af" }}>Нет диаграммы</span>}
            </div>
          )}
        </>
      ) : isArchitect ? (
        <textarea
          value={api}
          onChange={(e) => setApi(e.target.value)}
          onBlur={() => onCommit("openapi_spec", api)}
          style={{ ...textarea, fontFamily: "monospace", fontSize: 12 }}
          rows={16}
          placeholder={"openapi: 3.0.0\ninfo:\n  title: My API\n  version: 1.0.0"}
        />
      ) : api.trim() ? (
        <pre style={preBlock}>{api}</pre>
      ) : (
        <p style={{ color: "#9ca3af", margin: 0 }}>Нет спеки</p>
      )}
    </Modal>
  );
}

const head: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  marginBottom: 14, paddingRight: 4,
};
const textarea: CSSProperties = {
  display: "block", width: "100%", padding: "9px 11px", border: "1px solid #e2e8f0",
  borderRadius: 8, fontSize: 14, boxSizing: "border-box", color: "#0f172a", resize: "vertical",
};
const tabBtn: CSSProperties = {
  padding: "5px 14px", border: "1px solid #e2e8f0", borderRadius: 8,
  background: "#f1f5f9", color: "#475569", cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const activeTab: CSSProperties = { ...tabBtn, border: "1px solid #2563eb", background: "#2563eb", color: "#fff" };
const previewBox: CSSProperties = {
  border: "1px solid #e5e7eb", borderRadius: 6, padding: 12, minHeight: 80, background: "#fafafa",
};
const preBlock: CSSProperties = {
  background: "#f4f4f5", padding: 12, borderRadius: 6, overflowX: "auto", fontSize: 12,
  fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0,
};
