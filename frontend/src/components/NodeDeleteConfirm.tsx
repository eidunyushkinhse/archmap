import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Node, NodeEdgeInfo } from "../types";
import { nodesApi } from "../api/nodes";

/**
 * Модалка подтверждения удаления узла со списком его связей. Единый источник
 * предупреждения: используется и из NodeModal (кнопка «Удалить»), и при удалении
 * узла прямо с канваса по Backspace/Delete — чтобы архитектор в любом случае
 * увидел, какие связи исчезнут вместе с узлом, и не снёс его случайно.
 * Связи узла подгружаются сами при открытии.
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

  // Тянем связи узла при открытии — покажем их в предупреждении
  useEffect(() => {
    let alive = true;
    nodesApi
      .getEdges(node.id)
      .then((es) => { if (alive) setEdges(es); })
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : "Не удалось получить связи узла");
        }
      });
    return () => { alive = false; };
  }, [node.id]);

  async function confirmDelete() {
    setDeleting(true);
    setError(null);
    try {
      await nodesApi.delete(node.id);
      onDeleted(node.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка удаления");
      setDeleting(false);
    }
  }

  return (
    <div style={confirmOverlay}>
      <div style={confirmModal}>
        <h3 style={{ margin: "0 0 12px" }}>
          Вы уверены, что хотите удалить «{node.name}»?
        </h3>
        {edges === null && !error ? (
          <p style={{ color: "#6b7280", margin: "0 0 8px" }}>Загрузка связей…</p>
        ) : edges && edges.length > 0 ? (
          <>
            <p style={{ color: "#374151", margin: "0 0 8px" }}>
              Его связи будут удалены вместе с ним:
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
        ) : null}
        {error && <p style={{ color: "#dc2626", margin: "8px 0" }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            onClick={confirmDelete}
            disabled={deleting || edges === null}
            style={dangerBtn}
          >
            {deleting ? "Удаление..." : "Да, удалить"}
          </button>
          <button onClick={onCancel} disabled={deleting} style={secondaryBtn}>
            Нет
          </button>
        </div>
      </div>
    </div>
  );
}

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
const dangerBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#dc2626",
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
