import type { CSSProperties } from "react";
import type { Edge } from "../types";
import Modal from "../ui/Modal";
import { secondaryBtn } from "../ui/styles";

// Строка окна — любая связь с подписью: связь холста (Edge с original_*) или строка
// таблицы «Связи» страницы объекта (NodeEdgeInfo). Окну нужны только id и текст.
type ChoiceEdge = Pick<Edge, "id" | "label" | "technology">;

// Дженерик по типу ребра: onPick возвращает РОВНО тот объект, что пришёл в edges
// (с original_* полями), не теряя их в типе при сужении до базового Edge.
interface Props<E extends ChoiceEdge> {
  edges: E[];
  sourceLabel?: string;
  targetLabel?: string;
  // Настоящий конец строки («→ Каталог», «Уведомления →»), когда связи пучка расходятся
  // концами: десять одинаковых «пользуется» без него не различить. undefined — строка
  // без второй строчки (концы у всех общие, их называет шапка).
  endOf?: (edge: E) => string | undefined;
  onPick: (edge: E) => void;
  // Опционально (только для архитектора): дозаписать новую связь в том же
  // направлении, не протягивая отдельную стрелку. Кнопки нет, если проп не передан.
  onAdd?: () => void;
  onClose: () => void;
}

// Текст связи для пункта списка
function edgeText(e: ChoiceEdge): string {
  return [e.label, e.technology].filter(Boolean).join(" · ") || "связь";
}

export default function EdgeChoiceModal<E extends ChoiceEdge>({
  edges,
  sourceLabel,
  targetLabel,
  endOf,
  onPick,
  onAdd,
  onClose,
}: Props<E>) {
  return (
    <Modal onClose={onClose} boxStyle={{ width: 420, maxHeight: "80vh", overflowY: "auto" }}>
      <h2 style={{ margin: "0 0 6px", color: "#1e293b" }}>Выберите связь</h2>
      <p style={{ margin: "0 0 16px", color: "#64748b", fontSize: 13 }}>
        {`${sourceLabel} → ${targetLabel}`}
      </p>
      <div style={list}>
        {edges.map((e) => {
          const end = endOf?.(e);
          return (
            <button key={e.id} onClick={() => onPick(e)} style={linkRow}>
              {edgeText(e)}
              {end && <span style={endLine}>{end}</span>}
            </button>
          );
        })}
      </div>
      {onAdd && (
        <button onClick={onAdd} style={{ ...secondaryBtn, marginTop: 12, width: "100%" }}>
          + Добавить связь
        </button>
      )}
    </Modal>
  );
}

const list: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const linkRow: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
  color: "#2563eb",
};
// Вторая строчка пункта: настоящий конец связи, приглушённо
const endLine: CSSProperties = {
  display: "block",
  marginTop: 2,
  fontSize: 12,
  fontWeight: 400,
  color: "#64748b",
};
// строка с правой колонкой «куда/откуда ведёт» (вариант общего плеча, E80)
