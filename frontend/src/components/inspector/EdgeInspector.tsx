// Мета связи в правой панели: просмотр (наблюдатель) и inline-правка (архитектор).
// Inline-правка коммитится по blur/смене конца и ложится в Undo/Redo через
// onEdgeSaved. Вся механика правки (черновики, CAS-коммит, 409, инверсия) —
// в общем хуке useEdgeEdit: его же переиспользует модалка связи на странице
// объекта (EdgeEditModal).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { DeletionSnapshot, Edge, EdgeUpdate, LevelEdge, Node } from "../../types";
import { canHaveChildren } from "../../types";
import { edgesApi, nodesApi } from "../../api/nodes";
import NodeSearchPicker from "../NodeSearchPicker";
import { ShapeGlyph } from "../nodeTree.shared";
import { useEdgeEdit } from "./useEdgeEdit";
import "./inspector.css";

interface Props {
  edge: LevelEdge;
  isArchitect: boolean;
  onEdgeSaved: (edge: Edge, undoPayload: EdgeUpdate, redoPayload: EdgeUpdate) => void;
  onEdgeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
}

export default function EdgeInspector({ edge, isArchitect, onEdgeSaved, onEdgeDeleted }: Props) {
  // Концы: РЕАЛЬНЫЕ (original_*), а не их проекция на уровень — иначе правка
  // затёрла бы концы спроецированными значениями.
  const {
    labelText, setLabelText,
    technology, setTechnology,
    sourceId, setSourceId,
    targetId, setTargetId,
    srcLabel, setSrcLabel,
    tgtLabel, setTgtLabel,
    error, setError, commit,
  } = useEdgeEdit({
    id: edge.id,
    label: edge.label ?? null,
    technology: edge.technology ?? null,
    source_id: edge.original_source_id,
    target_id: edge.original_target_id,
    version: edge.version,
    source_name: edge.original_source_name,
    target_name: edge.original_target_name,
  }, onEdgeSaved);
  const [deleting, setDeleting] = useState(false);

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
                  {/* многострочное описание: textarea (лимит — модель, String(256));
                      переносы автора уважает и плашка на схеме (wrapLabel по \n) */}
                  <textarea className="insp-field insp-fieldarea" value={labelText} maxLength={256}
                    onChange={(e) => setLabelText(e.target.value)}
                    onBlur={() => void commit({ label: labelText })} placeholder="запрос, событие…" />
                </span>
              ) : (
                <span className="insp-value insp-value--pre">{labelText}</span>
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
