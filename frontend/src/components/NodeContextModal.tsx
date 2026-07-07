import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { nodesApi } from "../api/nodes";
import type { Node, NodeContext, LevelEdge } from "../types";
import LevelGraph from "./LevelGraph";
import EdgeDetailModal from "./EdgeDetailModal";
import EdgeChoiceModal from "./EdgeChoiceModal";
import Modal from "../ui/Modal";

interface Props {
  node: Node;
  onClose: () => void;
}

/**
 * Модалка «контекстная схема узла». Открывается кликом по узлу в дереве и
 * показывает диаграмму вокруг одного узла: сам узел (фокус) + его прямые соседи
 * (другой конец связей, выходящих за пределы поддерева фокуса), обёрнутый в рамки
 * своих предков. Соседи — «гости» (пунктир). Рендер переиспользует LevelGraph в
 * режиме mode="context": без кнопок входа/правки, координаты не сохраняются,
 * связи кликабельны только на просмотр деталей.
 */
export default function NodeContextModal({ node, onClose }: Props) {
  // Контекст грузим в ОДИН стейт с привязкой к узлу: forNodeId фиксирует, для какого
  // node.id получен результат. Эффект ТОЛЬКО фетчит и пишет в async-колбэке (без
  // синхронных setState-зеркал на входе — их и ловил set-state-in-effect). loading/
  // ctx/error — производные в рендере: при смене node.id `current` сам становится null
  // (forNodeId ещё старый) → loading, без эффекта-сброса. Сохраняет сценарий смены
  // node.id при уже открытой модалке.
  const [state, setState] = useState<{ forNodeId: string; ctx?: NodeContext; error?: string } | null>(null);
  // просмотр деталей связи (и выбор из «мастер-стрелки»)
  const [edgeDetail, setEdgeDetail] = useState<LevelEdge | null>(null);
  const [edgeChoice, setEdgeChoice] = useState<LevelEdge[] | null>(null);

  useEffect(() => {
    let alive = true;
    nodesApi
      .getContext(node.id)
      .then((c) => { if (alive) setState({ forNodeId: node.id, ctx: c }); })
      .catch((e: unknown) => {
        if (alive) {
          setState({
            forNodeId: node.id,
            error: e instanceof Error ? e.message : "Не удалось загрузить контекст",
          });
        }
      });
    return () => { alive = false; };
  }, [node.id]);

  // Производные от стейта: результат «своего» узла или null (идёт загрузка / устарел).
  const current = state?.forNodeId === node.id ? state : null;
  const loading = current === null;
  const ctx = current?.ctx ?? null;
  const error = current?.error ?? null;

  // Рёбра контекста → формат, который ждёт LevelGraph (концы уже спроецированы).
  // Мемоизируем по ctx: пропсы LevelGraph — зависимости async-эффекта раскладки,
  // новая ссылка на каждый рендер модалки гоняла бы раскладку зря (мигание).
  const edges: LevelEdge[] = useMemo(
    () =>
      (ctx?.edges ?? []).map((ge) => ({
        id: ge.id,
        label: ge.label,
        technology: ge.technology,
        source_id: ge.source_id,
        target_id: ge.target_id,
        // реальные концы ребра — модалка деталей показывает их, а не проекцию на фокус
        original_source_id: ge.original_source_id,
        original_target_id: ge.original_target_id,
        original_source_name: ge.original_source_name,
        original_target_name: ge.original_target_name,
        created_at: "",
      })),
    [ctx],
  );

  // Полное ребро контекста по id — LevelGraph в колбэках сужает тип до Edge (без
  // original_*); восстанавливаем из мемо (тот же объект) для модалки деталей.
  const findEdge = (id: string): LevelEdge | null =>
    edges.find((e) => e.id === id) ?? null;

  // Фокус-узел стабильной ссылкой (тоже вход раскладки)
  const focusNodes = useMemo(() => (ctx ? [ctx.focus] : []), [ctx]);

  // Имя конца связи для модалок деталей (фокус + соседи)
  const labelOf = (id: string): string =>
    ctx?.focus.id === id
      ? ctx.focus.name
      : ctx?.neighbors.find((n) => n.id === id)?.name ?? id;

  const noNeighbors = !!ctx && ctx.neighbors.length === 0;

  return (
    <>
    <Modal
      onClose={onClose}
      closeOnBackdrop
      boxStyle={{ width: "min(1100px, 94vw)", padding: 24, display: "flex", flexDirection: "column" }}
    >
      <h2 style={{ margin: "0 0 2px" }}>{node.name}</h2>
      <p style={sub}>Контекстная схема — объект и его прямые соседи</p>
      {!loading && !error && noNeighbors && (
        <p style={emptyHint}>У этого объекта нет внешних связей — показан только сам объект.</p>
      )}

      <div style={graphWrap}>
        {loading ? (
          <p style={hint}>Загрузка…</p>
        ) : error ? (
          <p style={{ ...hint, color: "#dc2626" }}>{error}</p>
        ) : ctx ? (
          <LevelGraph
            nodes={focusNodes}
            endpoints={ctx.neighbors}
            edges={edges}
            depth={ctx.focus_ancestors.length}
            containerId={ctx.focus.parent_id}
            ancestorNames={ctx.focus_ancestors.map((a) => a.name)}
            ancestorIds={ctx.focus_ancestors.map((a) => a.id)}
            isArchitect={false}
            onDrillDown={() => {}}
            onEditNode={() => {}}
            onEdgesChoice={(g) =>
              setEdgeChoice(
                g.map((m) => findEdge(m.id)).filter((e): e is LevelEdge => e != null),
              )
            }
            mode="context"
          />
        ) : null}
      </div>
    </Modal>

      {/* Детали/выбор связи — отдельные <dialog> поверх (top-layer), рендерим
          СИБЛИНГОМ контекст-модалки, а не внутри её <dialog>: вложенный <dialog>
          бубблил бы cancel (Escape) на контекст и закрывал бы обе модалки. Как
          сиблинг — Escape закрывает только детали, контекст остаётся; клик по
          подложке контекста ловит только клик ровно по нему (см. Modal). */}
      {edgeDetail && (
        <EdgeDetailModal
          edge={edgeDetail}
          sourceId={edgeDetail.original_source_id}
          targetId={edgeDetail.original_target_id}
          sourceLabel={edgeDetail.original_source_name}
          targetLabel={edgeDetail.original_target_name}
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
    </>
  );
}

const sub: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13,
  color: "#64748b",
};
const emptyHint: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13,
  color: "#94a3b8",
};
const graphWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "74vh",
};
const hint: CSSProperties = {
  margin: "auto",
  fontSize: 14,
  color: "#94a3b8",
};
