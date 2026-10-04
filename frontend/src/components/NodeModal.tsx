import { useState } from "react";
import type { CSSProperties } from "react";
import type { Node, NodeCreate, NodeShape, NodeStatus } from "../types";
import { getNodeColors, STATUS_META } from "./graph/colors";
import { nodesApi, viewsApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { labelStyle, input, primaryBtn } from "../ui/styles";
import { useScrollEdges } from "../ui/useScrollEdges";
import { CloseIcon } from "../ui/icons";
import "../ui/modalShell.css";
import { limitMessage } from "./demo/demoLimits";
import type { LimitMessage } from "./demo/demoLimits";
import { LimitText } from "./demo/DemoLimitToast";
import { emitTourEvent } from "./tour/tourBus";

// Модалка СОЗДАНИЯ объекта. Просмотр и правка существующего узла переехали в правую
// панель схемы (inspector/NodeInspector) — здесь осталась только форма нового объекта,
// открываемая дропом шаблона на холст. Форма приходит из шаблона (service/database/
// broker/person) и в модалке не меняется.
interface Props {
  parentId: string | null;
  shape?: NodeShape;
  // Координаты, куда бросили шаблон на схему.
  initialPos?: { x: number; y: number } | null;
  // Вид, в который писать позицию дропа. Задан ТОЛЬКО при дропе в раскрытую рамку:
  // тогда parentId — контейнер рамки, а позиция принадлежит виду ТЕКУЩЕГО уровня
  // (posView), а не виду parentId (иначе узел появился бы в рамке не там, где брошен).
  // undefined — обычный дроп: позицию кладёт сам POST /nodes (в вид parentId).
  posView?: string | null;
  onClose: () => void;
  // isCreate всегда true — но сигнатуру держим общей с inline-правкой в панели.
  onSaved: (node: Node, isCreate: boolean) => void;
}

const STATUS_ORDER: NodeStatus[] = ["existing", "planned", "deprecated"];

export default function NodeModal({ parentId, shape: templateShape, initialPos, posView, onClose, onSaved }: Props) {
  // Дроп в раскрытую рамку: позицию пишем отдельным батчем в вид текущего уровня.
  const intoFrame = posView !== undefined;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState("");
  const [technology, setTechnology] = useState("");
  const [isExternal, setIsExternal] = useState(false);
  const [status, setStatus] = useState<NodeStatus>("existing");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Демо-стенд: проект упёрся в предел — тот же текст, что в тосте холста.
  const [limit, setLimit] = useState<LimitMessage | null>(null);

  // Форма не редактируется: при создании — из шаблона. Используется для скрытия полей у person.
  const shape: NodeShape = templateShape ?? "service";

  const { atTop, atBottom, topRef, bottomRef } = useScrollEdges(false);
  const headerClass = `modal-header${atTop ? " modal-header--at-top" : ""}`;
  const footerClass = `modal-footer${atBottom ? " modal-footer--at-bottom" : ""}`;

  async function handleSave() {
    if (!name.trim()) {
      setError("Название обязательно");
      return;
    }
    setSaving(true);
    setError(null);
    setLimit(null);
    try {
      const data: NodeCreate = {
        name: name.trim(),
        description: description || null,
        role: role || null,
        technology: technology || null,
        parent_id: parentId,
        // Доки и спека в создание не входят: они добавляются на странице объекта.
        is_external: isExternal,
        shape,
        status,
        // При дропе в рамку позицию НЕ отдаём POST-у (он положил бы её в вид parentId) —
        // пишем ниже в вид текущего уровня. Обычный дроп — как раньше, позицию кладёт POST.
        pos_x: intoFrame ? null : (initialPos?.x ?? null),
        pos_y: intoFrame ? null : (initialPos?.y ?? null),
      };
      const saved = await nodesApi.create(data);
      // Дроп в рамку: позиция принадлежит виду ТЕКУЩЕГО уровня (posView), не виду parentId.
      if (intoFrame && initialPos) {
        await viewsApi.saveLayout(posView ?? null, { [saved.id]: { x: initialPos.x, y: initialPos.y } });
      }
      // Обучающий тур демо-стенда ждёт созданные объекты (docs/tasks/demo-tour.md).
      emitTourEvent({ type: "node-created", id: saved.id, name: saved.name, shape: saved.shape, parentId: saved.parent_id ?? null });
      onSaved(saved, true);
    } catch (e: unknown) {
      const refusal = limitMessage(e, "node");
      if (refusal) setLimit(refusal);
      else setError(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 560, maxHeight: "90vh", overflowY: "auto" }}>
      <div ref={topRef} style={{ height: 1 }} aria-hidden />
      <div className={headerClass}>
        <h2>Новый объект</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть">
          <CloseIcon />
        </button>
      </div>

      <label style={labelStyle}>Название *</label>
      <input value={name} onChange={(e) => setName(e.target.value)} style={input} data-autofocus />

      <label style={labelStyle}>Описание</label>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={textarea} rows={2} />

      <label style={labelStyle}>Роль</label>
      <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="сервис, БД, брокер..." style={input} />

      {shape !== "person" && (
        <>
          <label style={labelStyle}>Технология</label>
          <input value={technology} onChange={(e) => setTechnology(e.target.value)} placeholder="Python, Kafka, Redis..." style={input} />
        </>
      )}

      <label style={toggleRow}>
        <input type="checkbox" checked={isExternal} onChange={(e) => setIsExternal(e.target.checked)} style={{ marginRight: 8, cursor: "pointer" }} />
        Внешний
      </label>

      <label style={labelStyle}>Статус</label>
      <div style={statusSeg} role="radiogroup" aria-label="Статус">
        {STATUS_ORDER.map((st) => {
          const active = status === st;
          const dot = getNodeColors(isExternal, 0, st).bg;
          return (
            <button
              key={st}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setStatus(st)}
              style={active ? statusSegBtnActive : statusSegBtn}
            >
              <span style={{ ...metaDot, background: dot }} />
              {STATUS_META[st].label}
            </button>
          );
        })}
      </div>

      <div ref={bottomRef} style={{ height: 1 }} aria-hidden />
      <div className={footerClass}>
        {error && <p style={errStyle}>{error}</p>}
        {limit && <p style={errStyle} role="alert"><LimitText message={limit} /></p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSave} disabled={saving} style={primaryBtn}>
            {saving ? "Сохранение..." : "Создать"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const textarea: CSSProperties = {
  display: "block", width: "100%", marginBottom: 10, padding: "9px 11px",
  border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 14, boxSizing: "border-box",
  color: "#0f172a", resize: "vertical",
};
const errStyle: CSSProperties = { color: "#dc2626", margin: "0 0 8px" };
const toggleRow: CSSProperties = {
  display: "flex", alignItems: "center", fontSize: 14, fontWeight: 500,
  color: "#374151", marginBottom: 12, cursor: "pointer", userSelect: "none",
};
const statusSeg: CSSProperties = { display: "flex", gap: 6, marginBottom: 12 };
const statusSegBtn: CSSProperties = {
  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
  padding: "8px 6px", border: "1px solid #e2e8f0", borderRadius: 8,
  background: "#f8fafc", color: "#475569", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
};
const statusSegBtnActive: CSSProperties = {
  ...statusSegBtn, border: "1px solid #2563eb", background: "#eff6ff", color: "#1e3a8a",
};
const metaDot: CSSProperties = { width: 7, height: 7, borderRadius: 4, flexShrink: 0 };
