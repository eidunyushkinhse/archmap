import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Node, NodeEdgeInfo } from "../types";
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
  onDeleted: (id: string) => void;
}

export default function NodeDeleteConfirm({ node, onCancel, onDeleted }: Props) {
  const [edges, setEdges] = useState<NodeEdgeInfo[] | null>(null); // null — ещё грузим
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      await nodesApi.delete(node.id);
      onDeleted(node.id);
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
          setError(e instanceof Error ? e.message : "Не удалось получить связи узла");
        }
      });
    return () => { alive = false; };
  }, [node.id, node.has_children, confirmDelete]);

  // Пока грузим связи или сразу удаляем узел без связей — ничего не показываем
  // (модалка не должна мелькать на узлах, которые удаляются без подтверждения).
  if (edges === null && !error) return null;

  return (
    <Modal onClose={onCancel} closeButton={false} boxStyle={{ width: 460, maxHeight: "80vh", overflowY: "auto", padding: 24 }}>
      <h3 style={{ margin: "0 0 12px" }}>
          Вы уверены, что хотите удалить «{node.name}»?
        </h3>
        {edges && edges.length > 0 && (
          <>
            <p style={{ color: "#374151", margin: "0 0 8px" }}>
              {node.has_children
                ? "Узел и его дочерние узлы будут удалены. Вместе с ними удалятся связи:"
                : "Его связи будут удалены вместе с ним:"}
            </p>
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
          </>
        )}
        {/* Контейнер без внешних связей: связей не покажем, но удаление поддерева
            всё равно подтверждаем */}
        {node.has_children && edges && edges.length === 0 && (
          <p style={{ color: "#374151", margin: "0 0 8px" }}>
            Узел и все его дочерние узлы будут удалены.
          </p>
        )}
        {error && <p style={{ color: "#dc2626", margin: "8px 0" }}>{error}</p>}
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

const edgeList: CSSProperties = {
  margin: "0 0 4px",
  paddingLeft: 20,
  color: "#374151",
  fontSize: 14,
  lineHeight: 1.5,
};
