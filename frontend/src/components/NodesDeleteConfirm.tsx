import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import type { DeletionSnapshot, Node } from "../types";
import { nodesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { dangerBtn, secondaryBtn } from "../ui/styles";

/**
 * Подтверждение удаления НЕСКОЛЬКИХ выбранных узлов (мультиудаление с канваса по
 * Backspace/Delete). В отличие от одиночного NodeDeleteConfirm не перечисляет
 * связи каждого узла (их может быть много) — показывает список имён и общее
 * предупреждение, что потомки и связи уйдут каскадом.
 *
 * Узлы уровня — сиблинги (общий родитель), вложенности между ними нет, поэтому
 * снимки и удаления делаем параллельно: ни одно удаление не каскадит другое.
 */

interface Props {
  nodes: Node[];
  onCancel: () => void;
  // snapshots сняты ПЕРЕД удалением (для отката, Undo); порядок совпадает с ids.
  onDeleted: (ids: string[], snapshots: DeletionSnapshot[]) => void;
}

export default function NodesDeleteConfirm({ nodes, onCancel, onDeleted }: Props) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const ids = nodes.map((n) => n.id);
      // Снимки снимаем ДО удаления — после каскада восстанавливать будет не из чего.
      const snapshots = await Promise.all(ids.map((id) => nodesApi.deletionSnapshot(id)));
      await Promise.all(ids.map((id) => nodesApi.delete(id)));
      onDeleted(ids, snapshots);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка удаления");
      setDeleting(false);
    }
  }, [nodes, onDeleted]);

  return (
    <Modal onClose={onCancel} closeButton={false} boxStyle={{ width: 460, maxHeight: "80vh", overflowY: "auto", padding: 24 }}>
      <div style={titleRow}>
        <span style={warnPlaque} aria-hidden>{WARN_ICON}</span>
        <h3 style={title}>Удалить {nodes.length} {plural(nodes.length)}?</h3>
      </div>
      <p style={lead}>
        Будут удалены вместе со своими дочерними объектами и связями:
      </p>
      <div style={edgeBox}>
        <ul style={edgeList}>
          {nodes.map((n) => (
            <li key={n.id} style={{ marginBottom: 4 }}>{n.name}</li>
          ))}
        </ul>
      </div>
      {error && <p style={errText}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={confirmDelete} disabled={deleting} style={dangerBtn}>
          {deleting ? "Удаление..." : "Да, удалить"}
        </button>
        <button onClick={onCancel} disabled={deleting} style={secondaryBtn}>
          Нет
        </button>
      </div>
    </Modal>
  );
}

// Русское склонение «объект» по числу (2 объекта / 5 объектов).
function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "объект";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "объекта";
  return "объектов";
}

// Знак-предупреждение (линейный SVG, наследует цвет плашки через currentColor).
const WARN_ICON = (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4 L21.5 20 H2.5 Z" />
    <path d="M12 10 V14.5" />
    <circle cx="12" cy="17.5" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

const titleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 14,
};
const warnPlaque: CSSProperties = {
  flexShrink: 0,
  width: 36,
  height: 36,
  borderRadius: 10,
  background: "#fee2e2",
  color: "#dc2626",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
const title: CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 700,
  color: "#1e293b",
  lineHeight: 1.3,
};
const lead: CSSProperties = {
  color: "#475569",
  margin: "0 0 8px",
  fontSize: 14,
};
const edgeBox: CSSProperties = {
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: "10px 12px",
  marginBottom: 4,
};
const edgeList: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: "#475569",
  fontSize: 14,
  lineHeight: 1.6,
};
const errText: CSSProperties = {
  color: "#dc2626",
  margin: "8px 0",
  fontSize: 13,
};
