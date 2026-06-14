import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { DeletionSnapshot, Node, NodeEdgeInfo } from "../types";
import { nodesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { dangerBtn, secondaryBtn } from "../ui/styles";

/**
 * Подтверждение удаления узла со списком связей, которые исчезнут. Единый
 * источник предупреждения: используется и из NodeModal (кнопка «Удалить»), и при
 * удалении узла с канваса по Backspace/Delete.
 *
 * Связи (внешние связи всего поддерева — узел + потомки) подгружаются при
 * открытии. Если терять нечего — узел без внешних связей И без детей — удаляем
 * сразу, без модалки (показывать нечего, лишнее подтверждение не нужно). Пока
 * связи грузятся, компонент ничего не рисует, чтобы модалка не мелькала.
 */

interface Props {
  node: Node;
  onCancel: () => void;
  // snapshot — снимок поддерева, снятый ПЕРЕД удалением; нужен для отката (Undo).
  onDeleted: (id: string, snapshot: DeletionSnapshot) => void;
}

export default function NodeDeleteConfirm({ node, onCancel, onDeleted }: Props) {
  const [edges, setEdges] = useState<NodeEdgeInfo[] | null>(null); // null — ещё грузим
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      // Снимок снимаем ДО удаления — после каскада восстанавливать будет нечего из чего.
      const snapshot = await nodesApi.deletionSnapshot(node.id);
      await nodesApi.delete(node.id);
      onDeleted(node.id, snapshot);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка удаления");
      setDeleting(false);
    }
  }, [node.id, onDeleted]);

  // Тянем внешние связи поддерева. Если их нет и у узла нет детей — удаляем сразу,
  // без подтверждения; иначе показываем модалку со списком связей.
  useEffect(() => {
    let alive = true;
    nodesApi
      .getEdges(node.id)
      .then((es) => {
        if (!alive) return;
        if (es.length === 0 && !node.has_children) {
          void confirmDelete();
        } else {
          setEdges(es);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : "Не удалось получить связи объекта");
        }
      });
    return () => { alive = false; };
  }, [node.id, node.has_children, confirmDelete]);

  // Пока грузим связи или сразу удаляем узел без связей — ничего не показываем
  // (модалка не должна мелькать на узлах, которые удаляются без подтверждения).
  if (edges === null && !error) return null;

  return (
    <Modal onClose={onCancel} closeButton={false} boxStyle={{ width: 460, maxHeight: "80vh", overflowY: "auto", padding: 24 }}>
      {/* Мягкий danger: знак-предупреждение в плашке (без янтаря) + заголовок. */}
      <div style={titleRow}>
        <span style={warnPlaque} aria-hidden>{WARN_ICON}</span>
        <h3 style={title}>Вы уверены, что хотите удалить «{node.name}»?</h3>
      </div>
        {edges && edges.length > 0 && (
          <>
            <p style={lead}>
              {node.has_children
                ? "Объект и его дочерние объекты будут удалены. Вместе с ними удалятся связи:"
                : "Его связи будут удалены вместе с ним:"}
            </p>
            <div style={edgeBox}>
              <ul style={edgeList}>
                {edges.map((e) => {
                  const lbl = e.label || e.technology || "связь";
                  const dir = e.direction === "outgoing" ? "к" : "от";
                  return (
                    <li key={e.id} style={{ marginBottom: 4 }}>
                      «{lbl}» {dir} {e.other_node_name}
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
        {/* Контейнер без внешних связей: связей не покажем, но удаление поддерева
            всё равно подтверждаем */}
        {node.has_children && edges && edges.length === 0 && (
          <p style={lead}>
            Объект и все его дочерние объекты будут удалены.
          </p>
        )}
        {error && <p style={errText}>{error}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            onClick={confirmDelete}
            disabled={deleting}
            style={dangerBtn}
          >
            {deleting ? "Удаление..." : "Да, удалить"}
          </button>
          <button onClick={onCancel} disabled={deleting} style={secondaryBtn}>
            Нет
          </button>
        </div>
    </Modal>
  );
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
