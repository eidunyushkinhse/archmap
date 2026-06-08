import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { nodesApi } from "../api/nodes";
import type { Node, NodeContext, Edge as AppEdge } from "../types";
import LevelGraph from "./LevelGraph";
import EdgeDetailModal from "./EdgeDetailModal";
import EdgeChoiceModal from "./EdgeChoiceModal";

interface Props {
  node: Node;
  onClose: () => void;
}

// Стабильная пустая ссылка: контекст-схема координаты не сохраняет, но проп —
// зависимость раскладки, поэтому держим один объект, а не новый `{}` на рендер.
const EMPTY_LEVEL_POSITIONS: Record<string, { pos_x: number; pos_y: number }> = {};

/**
 * Модалка «контекстная схема узла». Открывается кликом по узлу в дереве и
 * показывает диаграмму вокруг одного узла: сам узел (фокус) + его прямые соседи
 * (другой конец связей, выходящих за пределы поддерева фокуса), обёрнутый в рамки
 * своих предков. Соседи — «гости» (пунктир). Рендер переиспользует LevelGraph в
 * режиме mode="context": без кнопок входа/правки, координаты не сохраняются,
 * связи кликабельны только на просмотр деталей.
 */
export default function NodeContextModal({ node, onClose }: Props) {
  const [ctx, setCtx] = useState<NodeContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // просмотр деталей связи (и выбор из «мастер-стрелки»)
  const [edgeDetail, setEdgeDetail] = useState<AppEdge | null>(null);
  const [edgeChoice, setEdgeChoice] = useState<AppEdge[] | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setCtx(null);
    nodesApi
      .getContext(node.id)
      .then((c) => { if (alive) setCtx(c); })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Не удалось загрузить контекст");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [node.id]);

  // Рёбра контекста → формат, который ждёт LevelGraph (концы уже спроецированы).
  // Мемоизируем по ctx: пропсы LevelGraph — зависимости async-эффекта раскладки,
  // новая ссылка на каждый рендер модалки гоняла бы раскладку зря (мигание).
  const edges: AppEdge[] = useMemo(
    () =>
      (ctx?.edges ?? []).map((ge) => ({
        id: ge.id,
        label: ge.label,
        technology: ge.technology,
        source_id: ge.source_id,
        target_id: ge.target_id,
        source_handle: ge.source_handle,
        target_handle: ge.target_handle,
        created_at: "",
      })),
    [ctx],
  );

  // Фокус-узел стабильной ссылкой (тоже вход раскладки)
  const focusNodes = useMemo(() => (ctx ? [ctx.focus] : []), [ctx]);

  // Имя конца связи для модалок деталей (фокус + соседи)
  const labelOf = (id: string): string =>
    ctx?.focus.id === id
      ? ctx.focus.name
      : ctx?.neighbors.find((n) => n.id === id)?.name ?? id;

  const noNeighbors = !!ctx && ctx.neighbors.length === 0;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} style={closeBtn}>✕</button>
        <h2 style={{ margin: "0 0 2px" }}>{node.name}</h2>
        <p style={sub}>Контекстная схема — узел и его прямые соседи</p>
        {!loading && !error && noNeighbors && (
          <p style={emptyHint}>У этого узла нет внешних связей — показан только сам узел.</p>
        )}

        <div style={graphWrap}>
          {loading ? (
            <p style={hint}>Загрузка…</p>
          ) : error ? (
            <p style={{ ...hint, color: "#dc2626" }}>{error}</p>
          ) : ctx ? (
            <LevelGraph
              nodes={focusNodes}
              ghostNodes={ctx.neighbors}
              levelPositions={EMPTY_LEVEL_POSITIONS}
              edges={edges}
              depth={ctx.focus_ancestors.length}
              containerId={ctx.focus.parent_id}
              ancestorNames={ctx.focus_ancestors.map((a) => a.name)}
              ancestorIds={ctx.focus_ancestors.map((a) => a.id)}
              isArchitect={false}
              onDrillDown={() => {}}
              onEditNode={() => {}}
              onEdgeClick={(e) => setEdgeDetail(e)}
              onEdgesChoice={(g) => setEdgeChoice(g)}
              mode="context"
            />
          ) : null}
        </div>
      </div>

      {edgeDetail && (
        <EdgeDetailModal
          edge={edgeDetail}
          sourceLabel={labelOf(edgeDetail.source_id)}
          targetLabel={labelOf(edgeDetail.target_id)}
          isArchitect={false}
          onClose={() => setEdgeDetail(null)}
          onDeleted={() => setEdgeDetail(null)}
          onSaved={() => setEdgeDetail(null)}
        />
      )}
      {edgeChoice && edgeChoice.length > 0 && (
        <EdgeChoiceModal
          edges={edgeChoice}
          sourceLabel={labelOf(edgeChoice[0].source_id)}
          targetLabel={labelOf(edgeChoice[0].target_id)}
          onPick={(e) => { setEdgeChoice(null); setEdgeDetail(e); }}
          onClose={() => setEdgeChoice(null)}
        />
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
const modal: CSSProperties = {
  background: "#fff",
  borderRadius: 10,
  padding: 24,
  width: "min(1100px, 94vw)",
  position: "relative",
  boxShadow: "0 8px 32px rgba(0,0,0,.18)",
  display: "flex",
  flexDirection: "column",
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
const sub: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13,
  color: "#6b7280",
};
const emptyHint: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13,
  color: "#9ca3af",
};
const graphWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "74vh",
};
const hint: CSSProperties = {
  margin: "auto",
  fontSize: 14,
  color: "#9ca3af",
};
