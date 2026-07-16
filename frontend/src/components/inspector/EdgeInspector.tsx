// Мета связи в правой панели: просмотр (наблюдатель) и inline-правка (архитектор).
// Перенос ветки «просмотр/правка» из бывшей EdgeDetailModal (модалка удалена
// 2026-07-16: её последний потребитель — путь деталей в контекст-схеме — был
// недостижим). Inline-правка коммитится по blur/смене конца и ложится в
// Undo/Redo через onEdgeSaved.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DeletionSnapshot, Edge, EdgeUpdate, LevelEdge, Node } from "../../types";
import { canHaveChildren } from "../../types";
import { edgesApi, nodesApi } from "../../api/nodes";
import NodeSearchPicker from "../NodeSearchPicker";
import { ShapeGlyph } from "../nodeTree.shared";
import "./inspector.css";

interface Props {
  edge: LevelEdge;
  isArchitect: boolean;
  onEdgeSaved: (edge: Edge, undoPayload: EdgeUpdate, redoPayload: EdgeUpdate) => void;
  onEdgeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
}

export default function EdgeInspector({ edge, isArchitect, onEdgeSaved, onEdgeDeleted }: Props) {
  const [labelText, setLabelText] = useState(edge.label ?? "");
  const [technology, setTechnology] = useState(edge.technology ?? "");
  // Концы: РЕАЛЬНЫЕ (original_*), а не их проекция на уровень — иначе правка затёрла бы
  // концы спроецированными значениями.
  const [sourceId, setSourceId] = useState(edge.original_source_id);
  const [targetId, setTargetId] = useState(edge.original_target_id);
  const [srcLabel, setSrcLabel] = useState(edge.original_source_name);
  const [tgtLabel, setTgtLabel] = useState(edge.original_target_name);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Состояние ДО последней правки — для обратимой записи в историю (undoPayload).
  // Хэндлов в контракте связи больше нет (R3): геометрия живёт на пучке в view_layout.
  const beforeRef = useRef<EdgeUpdate>({
    label: edge.label ?? null,
    technology: edge.technology ?? null,
    source_id: edge.original_source_id,
    target_id: edge.original_target_id,
  });

  // Узлы-концы (read-only) для глифа формы рядом с «Откуда/Куда». Концы off-level,
  // поэтому фетч по id (контракт связи формы концов не несёт).
  const [ends, setEnds] = useState<Record<string, Node>>({});
  useEffect(() => {
    let alive = true;
    const ids = Array.from(new Set([sourceId, targetId].filter(Boolean)));
    Promise.all(ids.map((id) => nodesApi.get(id).catch(() => null))).then((nodes) => {
      if (!alive) return;
      setEnds((prev) => {
        const next = { ...prev };
        for (const n of nodes) if (n) next[n.id] = n;
        return next;
      });
    });
    return () => { alive = false; };
  }, [sourceId, targetId]);

  const endGlyph = (id: string): ReactNode => {
    const n = ends[id];
    if (!n) return null;
    return <ShapeGlyph container={canHaveChildren(n.shape) && !!n.has_children} shape={n.shape} />;
  };

  async function commit(over: Partial<{ label: string; technology: string; source_id: string; target_id: string }>) {
    const src = over.source_id ?? sourceId;
    const tgt = over.target_id ?? targetId;
    if (!src || !tgt) { setError("Выберите исходный и целевой объекты"); return; }
    if (src === tgt) { setError("Объект не может ссылаться сам на себя"); return; }
    setError(null);
    const redo: EdgeUpdate = {
      label: (over.label ?? labelText) || null,
      technology: (over.technology ?? technology) || null,
      source_id: src,
      target_id: tgt,
    };
    const before = beforeRef.current;
    // no-op: ничего не изменилось — не плодим записи истории
    if (redo.label === (before.label ?? null) && redo.technology === (before.technology ?? null)
      && redo.source_id === before.source_id && redo.target_id === before.target_id) return;
    const undo: EdgeUpdate = { ...before };
    try {
      const updated = await edgesApi.update(edge.id, redo);
      onEdgeSaved(updated, undo, redo);
      beforeRef.current = {
        label: updated.label ?? null,
        technology: updated.technology ?? null,
        source_id: updated.source_id,
        target_id: updated.target_id,
      };
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка сохранения");
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const snapshot = await edgesApi.deletionSnapshot(edge.id);
      await edgesApi.delete(edge.id);
      onEdgeDeleted(edge.id, snapshot);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка удаления");
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="insp-block-label">Связь</div>
      <dl className="insp-meta">
        {/* Откуда */}
        <div className={"insp-row" + (isArchitect ? " insp-row--top" : "")}>
          <dt className="insp-term"><span className="insp-term-ico">{ICON.source}</span>Откуда</dt>
          <dd style={{ margin: 0, flex: 1, minWidth: 0 }}>
            {isArchitect ? (
              <NodeSearchPicker
                value={sourceId}
                initialLabel={srcLabel}
                onChange={(id, lbl) => { setSourceId(id); if (lbl != null) setSrcLabel(lbl); if (id) void commit({ source_id: id }); }}
              />
            ) : (
              <span className="insp-value">{endGlyph(sourceId)}<span className="insp-endname">{srcLabel}</span></span>
            )}
          </dd>
        </div>
        {/* Куда */}
        <div className={"insp-row" + (isArchitect ? " insp-row--top" : "")}>
          <dt className="insp-term"><span className="insp-term-ico">{ICON.target}</span>Куда</dt>
          <dd style={{ margin: 0, flex: 1, minWidth: 0 }}>
            {isArchitect ? (
              <NodeSearchPicker
                value={targetId}
                initialLabel={tgtLabel}
                onChange={(id, lbl) => { setTargetId(id); if (lbl != null) setTgtLabel(lbl); if (id) void commit({ target_id: id }); }}
              />
            ) : (
              <span className="insp-value">{endGlyph(targetId)}<span className="insp-endname">{tgtLabel}</span></span>
            )}
          </dd>
        </div>
        {/* Описание */}
        {(isArchitect || labelText) && (
          <div className="insp-row">
            <dt className="insp-term"><span className="insp-term-ico">{ICON.desc}</span>Описание</dt>
            <dd style={{ margin: 0, flex: 1, minWidth: 0, display: "flex" }}>
              {isArchitect ? (
                <span className="insp-value">
                  <input className="insp-field" value={labelText} onChange={(e) => setLabelText(e.target.value)}
                    onBlur={() => void commit({ label: labelText })} placeholder="запрос, событие…" />
                </span>
              ) : (
                <span className="insp-value">{labelText}</span>
              )}
            </dd>
          </div>
        )}
        {/* Технология */}
        {(isArchitect || technology) && (
          <div className="insp-row">
            <dt className="insp-term"><span className="insp-term-ico">{ICON.tech}</span>Технология</dt>
            <dd style={{ margin: 0, flex: 1, minWidth: 0, display: "flex" }}>
              {isArchitect ? (
                <span className="insp-value">
                  <input className="insp-field" value={technology} onChange={(e) => setTechnology(e.target.value)}
                    onBlur={() => void commit({ technology })} placeholder="REST, gRPC, Kafka…" />
                </span>
              ) : (
                <span className="insp-value">{technology}</span>
              )}
            </dd>
          </div>
        )}
      </dl>

      {error && <p style={{ color: "#dc2626", fontSize: 13, margin: "10px 0 0" }}>{error}</p>}

      {isArchitect && (
        <button type="button" className="insp-del" onClick={handleDelete} disabled={deleting}>
          {ICON.trash} {deleting ? "Удаление…" : "Удалить связь"}
        </button>
      )}
    </div>
  );
}

const ms = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
} as const;
const ICON: Record<"source" | "target" | "desc" | "tech" | "trash", ReactNode> = {
  source: <svg {...ms}><circle cx="3.5" cy="8" r="2.25" /><path d="M6 8h7" /><path d="M10.5 5.4 13.2 8l-2.7 2.6" /></svg>,
  target: <svg {...ms}><path d="M2.8 8h7" /><path d="M7.3 5.4 10 8l-2.7 2.6" /><circle cx="12.5" cy="8" r="2.25" /></svg>,
  desc: <svg {...ms}><path d="M8.4 2.6 13 7.2a1.3 1.3 0 0 1 0 1.8l-3.9 3.9a1.3 1.3 0 0 1-1.8 0L2.7 8.3V4a1.3 1.3 0 0 1 1.3-1.3Z" /><circle cx="5.6" cy="5.5" r=".9" fill="currentColor" stroke="none" /></svg>,
  tech: <svg {...ms}><path d="M6 5.4 3 8l3 2.6" /><path d="M10 5.4 13 8l-3 2.6" /></svg>,
  trash: <svg {...ms} width={15} height={15}><path d="M3 4.2h10 M5.5 4.2V3h5v1.2 M4.2 4.2l.6 8.3a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.3" /></svg>,
};
