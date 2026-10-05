// Мета связи в правой панели: просмотр (наблюдатель) и inline-правка (архитектор).
// Inline-правка коммитится по blur/смене конца и ложится в Undo/Redo через
// onEdgeSaved. Вся механика правки (черновики, CAS-коммит, 409, инверсия) —
// в общем хуке useEdgeEdit: его же переиспользует модалка связи на странице
// объекта (EdgeEditModal).
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { BrokerChannel, DeletionSnapshot, Edge, EdgeUpdate, LevelEdge, Node } from "../../types";
import { canHaveChildren } from "../../types";
import { brokerChannelsApi, edgesApi, nodesApi } from "../../api/nodes";
import NodeSearchPicker from "../NodeSearchPicker";
import { ShapeGlyph } from "../nodeTree.shared";
import { useEdgeEdit } from "./useEdgeEdit";
import "./inspector.css";
import { noAutofill } from "../../ui/noAutofill";

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
    channel, setChannel,
    sourceId, setSourceId,
    targetId, setTargetId,
    srcLabel, setSrcLabel,
    tgtLabel, setTgtLabel,
    error, setError, commit,
  } = useEdgeEdit({
    id: edge.id,
    label: edge.label ?? null,
    technology: edge.technology ?? null,
    channel: edge.channel ?? null,
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

  // Концы-БРОКЕРЫ. Стрелка, у которой хотя бы один конец — брокер, обязана назвать
  // канал (решение пользователя №4, docs/plan-broker-docs.md §4): без этого схема не
  // отвечает на «откуда взялось событие». У остальных связей поля просто нет.
  const brokerEnds = useMemo(
    () => [sourceId, targetId].filter((id) => ends[id]?.shape === "broker"),
    [ends, sourceId, targetId],
  );
  // Структура концов-брокеров — только для ПОДСКАЗКИ резолва (сохранение она не
  // гейтит: канал может появиться в структуре позже, и запрет писать его сейчас
  // заставил бы описывать брокер раньше схемы). Истина шва — алерт AL31.
  const [brokerChannels, setBrokerChannels] = useState<BrokerChannel[]>([]);
  useEffect(() => {
    let alive = true;
    // Пустой список концов-брокеров идёт тем же путём (Promise.all([]) → []), а не
    // синхронным setState в теле эффекта: правило react-hooks/set-state-in-effect.
    Promise.all(brokerEnds.map((id) => brokerChannelsApi.list(id).catch(() => [])))
      .then((lists) => { if (alive) setBrokerChannels(lists.flat()); });
    return () => { alive = false; };
  }, [brokerEnds]);

  const typedChannel = channel.trim();
  const channelHint: ReactNode = typedChannel === "" ? null
    : channelKnown(typedChannel, brokerChannels)
      ? <span className="insp-hint insp-hint--ok">✓ {typedChannel}</span>
      : <span className="insp-hint insp-hint--warn">⚠ канала нет в структуре брокера</span>;

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
                  <textarea {...noAutofill("edge-inspector-1")} className="insp-field insp-fieldarea" value={labelText} maxLength={256}
                    onChange={(e) => setLabelText(e.target.value)}
                    onBlur={() => void commit({ label: labelText })} placeholder="запрос, событие…" />
                </span>
              ) : (
                <span className="insp-value insp-value--pre">{labelText}</span>
              )}
            </dd>
          </div>
        )}
        {/* Канал брокера: показываем, только если хотя бы один конец — брокер.
            Наблюдателю — как остальные поля: строкой и только когда заполнено. */}
        {brokerEnds.length > 0 && (isArchitect || channel) && (
          <div className="insp-row">
            <dt className="insp-term"><span className="insp-term-ico">{ICON.channel}</span>Канал</dt>
            <dd style={{ margin: 0, flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {isArchitect ? (
                <span className="insp-value">
                  <input {...noAutofill("edge-inspector-2")} className="insp-field" value={channel} maxLength={256}
                    onChange={(e) => setChannel(e.target.value)}
                    onBlur={() => void commit({ channel })} placeholder="топик / очередь" />
                </span>
              ) : (
                <span className="insp-value">{channel}</span>
              )}
              {channelHint}
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
                  <input {...noAutofill("edge-inspector-3")} className="insp-field" value={technology} onChange={(e) => setTechnology(e.target.value)}
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

/**
 * Знает ли структура брокера-конца такой канал. ЗЕРКАЛО бэкендового `_channel_known`
 * (app/alerts.py): точное имя канала — включая имя С ТОЧКАМИ целиком («orders.created»
 * — норма Kafka), — либо «группа.канал» (vhost/namespace/account). Квалификатора
 * «Брокер / …» здесь не бывает: брокер задан концом связи.
 */
function channelKnown(name: string, channels: BrokerChannel[]): boolean {
  return channels.some(
    (c) => c.name === name || (c.group_name !== "" && `${c.group_name}.${c.name}` === name),
  );
}

const ms = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
} as const;
const ICON: Record<"source" | "target" | "desc" | "tech" | "channel" | "trash", ReactNode> = {
  source: <svg {...ms}><circle cx="3.5" cy="8" r="2.25" /><path d="M6 8h7" /><path d="M10.5 5.4 13.2 8l-2.7 2.6" /></svg>,
  target: <svg {...ms}><path d="M2.8 8h7" /><path d="M7.3 5.4 10 8l-2.7 2.6" /><circle cx="12.5" cy="8" r="2.25" /></svg>,
  desc: <svg {...ms}><path d="M8.4 2.6 13 7.2a1.3 1.3 0 0 1 0 1.8l-3.9 3.9a1.3 1.3 0 0 1-1.8 0L2.7 8.3V4a1.3 1.3 0 0 1 1.3-1.3Z" /><circle cx="5.6" cy="5.5" r=".9" fill="currentColor" stroke="none" /></svg>,
  tech: <svg {...ms}><path d="M6 5.4 3 8l3 2.6" /><path d="M10 5.4 13 8l-3 2.6" /></svg>,
  // Канал: конверт события (та же метафора, что у секции каналов брокера).
  channel: <svg {...ms}><rect x="2.2" y="4" width="11.6" height="8" rx="1.3" /><path d="M2.2 5 8 8.9 13.8 5" /></svg>,
  trash: <svg {...ms} width={15} height={15}><path d="M3 4.2h10 M5.5 4.2V3h5v1.2 M4.2 4.2l.6 8.3a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.3" /></svg>,
};
