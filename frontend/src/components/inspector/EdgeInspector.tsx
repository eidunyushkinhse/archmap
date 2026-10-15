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
import { ShapeGlyph } from "../nodeTree.shared";
import { useEdgeEdit } from "./useEdgeEdit";
import EdgeEndRow from "./EdgeEndRow";
import MetaRow from "./MetaRow";
import { META_ICON } from "./metaIcons";
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
    sourceId, targetId, srcLabel, tgtLabel,
    error, setError, commit, pickEnd,
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
        <EdgeEndRow end="source" value={sourceId} label={srcLabel} glyph={endGlyph(sourceId)}
          onPick={isArchitect ? (id, lbl) => pickEnd("source", id, lbl) : undefined} />
        <EdgeEndRow end="target" value={targetId} label={tgtLabel} glyph={endGlyph(targetId)}
          onPick={isArchitect ? (id, lbl) => pickEnd("target", id, lbl) : undefined} />
        {(isArchitect || labelText) && (
          <MetaRow icon={META_ICON.desc} label="Описание">
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
          </MetaRow>
        )}
        {/* Канал брокера: показываем, только если хотя бы один конец — брокер.
            Наблюдателю — как остальные поля: строкой и только когда заполнено. */}
        {brokerEnds.length > 0 && (isArchitect || channel) && (
          <MetaRow icon={META_ICON.channel} label="Канал" layout="column">
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
          </MetaRow>
        )}
        {(isArchitect || technology) && (
          <MetaRow icon={META_ICON.tech} label="Технология">
            {isArchitect ? (
              <span className="insp-value">
                <input {...noAutofill("edge-inspector-3")} className="insp-field" value={technology} onChange={(e) => setTechnology(e.target.value)}
                  onBlur={() => void commit({ technology })} placeholder="REST, gRPC, Kafka…" />
              </span>
            ) : (
              <span className="insp-value">{technology}</span>
            )}
          </MetaRow>
        )}
      </dl>

      {error && <p style={{ color: "#dc2626", fontSize: 13, margin: "10px 0 0" }}>{error}</p>}

      {isArchitect && (
        <button type="button" className="insp-del" onClick={handleDelete} disabled={deleting}>
          {META_ICON.trash} {deleting ? "Удаление…" : "Удалить связь"}
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
