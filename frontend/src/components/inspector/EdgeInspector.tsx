// Панель связи в редакторе-карте (редизайн, направление А «Документ»): заголовок «Связь» с
// крестиком, строки «Откуда», «Куда», «Описание», «Канал» (только если один из концов —
// брокер), «Технология» тем же видом, что строки свойств объекта (nodePage/PropRows),
// внизу у редактора — «Удалить связь». Читатель видит только строки со значением.
//
// Правка коммитится по уходу с поля и по выбору конца и ложится в Undo/Redo через
// onEdgeSaved. Вся механика правки (черновики, CAS-коммит, 409, проверки концов) — в
// общем хуке useEdgeEdit; значения «Откуда», «Куда», «Описание» и «Технология» — общие
// с окном «Связь» на странице объекта (EdgeEditModal) части inspector/EdgeFields.
import { useEffect, useMemo, useState } from "react";
import type { BrokerChannel, DeletionSnapshot, Edge, EdgeUpdate, LevelEdge, Node } from "../../types";
import { treeNesting } from "../../types";
import { brokerChannelsApi, edgesApi, nodesApi } from "../../api/nodes";
import { ShapeGlyph } from "../nodeTree.shared";
import { Prop } from "../nodePage/PropRows";
import { revertOnEscape } from "../nodePage/revertOnEscape";
import { noAutofill } from "../../ui/noAutofill";
import PanelHead from "./PanelHead";
import { useEdgeEdit } from "./useEdgeEdit";
import { EdgeLabelField, EdgeTechField, EndValue } from "./EdgeFields";
import "../../ui/ds.css";
import "./panel.css";

interface Props {
  edge: LevelEdge;
  isArchitect: boolean;
  onEdgeSaved: (edge: Edge, undoPayload: EdgeUpdate, redoPayload: EdgeUpdate) => void;
  onEdgeDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  onClose: () => void;
}

export default function EdgeInspector({ edge, isArchitect, onEdgeSaved, onEdgeDeleted, onClose }: Props) {
  // Концы: РЕАЛЬНЫЕ (original_*), а не их проекция на уровень — иначе правка
  // затёрла бы концы спроецированными значениями.
  const {
    labelText, setLabelText,
    technology, setTechnology,
    channel, setChannel,
    sourceId, targetId, srcLabel, tgtLabel,
    saved, error, setError, commit, pickEnd,
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

  // Узлы-концы (только чтение) для значка формы у «Откуда» и «Куда» и для поля «Канал».
  // Концы бывают вне уровня, поэтому запрос по id (контракт связи формы концов не несёт).
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
  // отвечает на «откуда взялось событие». У остальных связей строки нет.
  const brokerEnds = useMemo(
    () => [sourceId, targetId].filter((id) => ends[id]?.shape === "broker"),
    [ends, sourceId, targetId],
  );
  // Структура концов-брокеров — только для ПРЕДУПРЕЖДЕНИЯ (сохранение она не гейтит:
  // канал может появиться в структуре позже, и запрет писать его сейчас заставил бы
  // описывать брокер раньше схемы). Истина шва — алерт AL31.
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
  const unknownChannel = typedChannel !== "" && !channelKnown(typedChannel, brokerChannels);

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

  const endValue = (end: "source" | "target") => {
    const id = end === "source" ? sourceId : targetId;
    const label = end === "source" ? srcLabel : tgtLabel;
    const n = ends[id];
    return (
      <EndValue
        label={label}
        glyph={n ? <ShapeGlyph nesting={treeNesting(n)} shape={n.shape} /> : null}
        onPick={isArchitect ? (pid, lbl) => pickEnd(end, pid, lbl) : undefined}
        term={end === "source" ? "Откуда" : "Куда"}
      />
    );
  };

  return (
    <>
      <PanelHead title={<h2 className="ip-title">Связь</h2>} onClose={onClose} />

      <dl className="ip-props">
        <Prop term="Откуда">{endValue("source")}</Prop>
        <Prop term="Куда">{endValue("target")}</Prop>
        {(isArchitect || labelText) && (
          <Prop term="Описание">
            {isArchitect ? (
              <EdgeLabelField
                value={labelText}
                saved={saved.label}
                onChange={setLabelText}
                onCommit={() => void commit({ label: labelText })}
                autofill="edge-label"
              />
            ) : (
              <span className="ip-pre">{labelText}</span>
            )}
          </Prop>
        )}
        {/* Канал брокера: только если хотя бы один конец — брокер. Под ним — только
            предупреждение, когда канала нет в структуре брокера. */}
        {brokerEnds.length > 0 && (isArchitect || channel) && (
          <Prop term="Канал">
            {isArchitect ? (
              <input
                {...noAutofill("edge-channel")}
                className="ds-field"
                aria-label="Канал"
                maxLength={256}
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                onBlur={() => void commit({ channel })}
                onKeyDown={revertOnEscape(channel !== saved.channel, () => setChannel(saved.channel))}
                placeholder="не указан"
              />
            ) : (
              channel
            )}
            {unknownChannel && <span className="ip-warn">Канала нет в структуре брокера</span>}
          </Prop>
        )}
        {(isArchitect || technology) && (
          <Prop term="Технология">
            {isArchitect ? (
              <EdgeTechField
                value={technology}
                saved={saved.technology}
                onChange={setTechnology}
                onCommit={() => void commit({ technology })}
                autofill="edge-tech"
              />
            ) : (
              technology
            )}
          </Prop>
        )}
      </dl>

      {error && <p className="ds-warn">{error}</p>}

      {isArchitect && (
        <button type="button" className="ip-delete" onClick={() => { void handleDelete(); }} disabled={deleting}>
          {deleting ? "Удаляем" : "Удалить связь"}
        </button>
      )}
    </>
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
