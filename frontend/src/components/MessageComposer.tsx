import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { edgesApi } from "../api/nodes";
import { processesApi } from "../api/processes";
import type { Channel, MessageCreate, ProcessMessage, ProcessParticipant } from "../types";
import { C4Glyph, IcoArrowR, IcoClose, IcoLink, IcoWarn } from "./processes/icons";
import { legMeta } from "./processes/legMeta";
import { BPT } from "./processes/tokens";
import SyncSegmented from "./SyncSegmented";
import "./processes/processes.css";

/**
 * Композитор сообщения (звезда фичи). Пара участников приходит готовой: её задаёт
 * пользователь, протянув стрелку между линиями жизни на схеме (drag-to-connect),
 * поэтому полей «От кого/Кому» тут больше нет — только схема выбранной пары.
 * Сообщение НЕ рисуется, а выбирается из плеч задокументированных каналов между
 * двумя участниками (GET /channels). Нет канала → валидатор ведёт достроить схему.
 */
interface Props {
  processId: string;
  participants: ProcessParticipant[];
  fromNode: string; // node_id источника (откуда тянули стрелку)
  toNode: string; // node_id цели (куда отпустили)
  defaultOrder: number; // order для нового сообщения (в конец)
  onClose: () => void;
  // Сообщение создано: отдаём созданную сущность и payload — редактор регистрирует
  // команду отката (undo удалит по id, redo пересоздаст из payload) и перечитывает процесс.
  onAdded: (created: ProcessMessage, payload: MessageCreate) => void;
}

export default function MessageComposer({
  processId,
  participants,
  fromNode,
  toNode,
  defaultOrder,
  onClose,
  onAdded,
}: Props) {
  // Результат /channels привязан к паре (key): пока key не совпал с текущей парой —
  // считаем «грузим» (channels=null). Так нет синхронного setState в эффекте —
  // «сброс» при смене пары выводится в рендере, а не зеркалится через setState.
  const [result, setResult] = useState<{ key: string; data: Channel[] } | null>(null);
  const [sel, setSel] = useState<{ edgeId: string; leg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // edge_id связи, у которой сейчас переключаем тип (на время запроса блокируем тумблеры).
  const [syncEdge, setSyncEdge] = useState<string | null>(null);
  // Поля достраиваемой связи. Живут здесь, а не в отдельной модалке: композитор —
  // окно про СООБЩЕНИЕ, и уводить из него ради трёх полей значит рвать поток.
  const [newLabel, setNewLabel] = useState("");
  const [newTech, setNewTech] = useState("");
  const [newSync, setNewSync] = useState(true);

  const partByNode = useMemo(() => {
    const m: Record<string, ProcessParticipant> = {};
    for (const p of participants) if (p.node_id) m[p.node_id] = p;
    return m;
  }, [participants]);
  const nameOf = (nodeId: string) => partByNode[nodeId]?.name ?? nodeId;

  // Колоночный порядок участников на схеме (как в SequenceDiagram — по order). Карточки
  // в модалке показываем в той же раскладке, что и на схеме, а стрелку направляем
  // source→target: если цель правее источника — стрелка вправо, иначе влево.
  const colIdx = useMemo(() => {
    const m: Record<string, number> = {};
    [...participants].sort((a, b) => a.order - b.order).forEach((p, k) => {
      if (p.node_id) m[p.node_id] = k;
    });
    return m;
  }, [participants]);
  const targetRight = (colIdx[toNode] ?? 0) > (colIdx[fromNode] ?? 0);
  const leftId = targetRight ? fromNode : toNode;
  const rightId = targetRight ? toNode : fromNode;

  const pairKey = `${fromNode}|${toNode}`;
  const channels = result && result.key === pairKey ? result.data : null;

  // Каналы пары грузим один раз (пара фиксирована пропсами). Бэк берёт {a,b} как
  // множество — порядок аргументов не влияет на результат.
  useEffect(() => {
    let alive = true;
    processesApi
      .channels(processId, fromNode, toNode)
      .then((ch) => alive && setResult({ key: pairKey, data: ch }))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Ошибка загрузки каналов"));
    return () => { alive = false; };
  }, [processId, fromNode, toNode, pairKey]);

  async function addSchemaEdge() {
    setBusy(true);
    setError(null);
    try {
      // «Достроить схему»: документируем связь source→target — она тут же появится
      // как плечо (канал). Поля заполняются ЗДЕСЬ же: раньше связь рождалась
      // безымянной, без технологии и всегда синхронной, и за правкой приходилось
      // уходить в редактор-карту — из того самого процесса, ради которого всё и
      // затевалось. Подпись важна вдвойне: default_caption плеча forward берётся
      // из edge.label, поэтому пустой label оставлял без подписи и сообщение.
      await edgesApi.create({
        source_id: fromNode,
        target_id: toNode,
        label: newLabel.trim() || null,
        technology: newTech.trim() || null,
        is_synchronous: newSync,
      });
      const ch = await processesApi.channels(processId, fromNode, toNode);
      setResult({ key: pairKey, data: ch });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить связь");
    } finally {
      setBusy(false);
    }
  }

  // Сменить тип уже задокументированной связи. Второе место правки синхронности —
  // карточка шага (2026-08-11); в C4-модалке признака нет и не будет: состав плеч —
  // вопрос процесса, а не схемы объекта (решение пользователя). Тип меняет состав
  // плеч, поэтому после апдейта перечитываем каналы и сбрасываем выбор с этой связи.
  async function setChannelSync(edgeId: string, v: boolean) {
    if (syncEdge) return;
    setSyncEdge(edgeId);
    setError(null);
    try {
      await edgesApi.update(edgeId, { is_synchronous: v });
      const ch = await processesApi.channels(processId, fromNode, toNode);
      setResult({ key: pairKey, data: ch });
      setSel((s) => (s && s.edgeId === edgeId ? null : s));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось изменить тип связи");
    } finally {
      setSyncEdge(null);
    }
  }

  async function add() {
    if (!sel || !channels || busy) return;
    const channel = channels.find((c) => c.edge_id === sel.edgeId);
    const leg = channel?.legs.find((l) => l.leg === sel.leg);
    if (!channel || !leg) return;
    const fromP = partByNode[leg.from_id];
    const toP = partByNode[leg.to_id];
    if (!fromP || !toP) {
      setError("Концы плеча не среди участников");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: MessageCreate = {
        edge_id: channel.edge_id,
        leg: leg.leg,
        from_participant_id: fromP.id,
        to_participant_id: toP.id,
        caption: null,
        order: defaultOrder,
      };
      const created = await processesApi.addMessage(processId, payload);
      onAdded(created, payload);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить сообщение");
      setBusy(false);
    }
  }

  return (
    <div className="bp bp-composer">
      <div className="bp-comphead">
        <span style={{ fontSize: 14, fontWeight: 700, color: BPT.head }}>Добавить сообщение</span>
        <button className="bp-iconbtn" style={{ width: 26, height: 26 }} onClick={onClose}>
          <IcoClose s={14} />
        </button>
      </div>

      {/* Схема выбранной пары: узлы в порядке колонок схемы, стрелка source→target */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 8, padding: "14px 14px 10px" }}>
        <NodeChip part={partByNode[leftId]} fallback={leftId} />
        <div style={{ display: "flex", alignItems: "center", color: BPT.accent, flex: "none" }}>
          <span style={{ display: "inline-flex", transform: targetRight ? "none" : "scaleX(-1)" }}>
            <IcoArrowR s={18} />
          </span>
        </div>
        <NodeChip part={partByNode[rightId]} fallback={rightId} />
      </div>

      {error && <div style={{ color: "#dc2626", fontSize: 12, padding: "0 14px 6px" }}>{error}</div>}

      {channels === null ? (
        <div style={{ fontSize: 12, color: BPT.mut, padding: "6px 14px 16px" }}>Загрузка каналов…</div>
      ) : channels.length === 0 ? (
        <div style={{ padding: "8px 14px 14px" }}>
          <div style={validator}>
            <span style={{ color: BPT.amberDot, flex: "none", marginTop: 1 }}>
              <IcoWarn s={18} />
            </span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: BPT.amber, marginBottom: 3 }}>
                Между ними нет задокументированной связи
              </div>
              <div style={{ fontSize: 12, color: "#92591a", lineHeight: 1.5 }}>
                Процесс не может отправить сообщение, которого нет в архитектуре. Опишите связь
                «{nameOf(fromNode)} → {nameOf(toNode)}» — она появится и в схеме, и здесь как плечо.
              </div>
            </div>
          </div>

          {/* Поля связи. «Что передаётся» = label связи: из него берётся подпись
              плеча, поэтому поле стоит первым и получает фокус. */}
          <div style={{ marginTop: 12 }}>
            <label className="bp-field-label" htmlFor="bp-new-label">Что передаётся</label>
            <input
              id="bp-new-label"
              className="bp-input"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="создать заказ, событие оплаты…"
              disabled={busy}
              autoFocus
            />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label className="bp-field-label" htmlFor="bp-new-tech">Технология</label>
              <input
                id="bp-new-tech"
                className="bp-input"
                value={newTech}
                onChange={(e) => setNewTech(e.target.value)}
                placeholder="REST, gRPC, Kafka…"
                disabled={busy}
              />
            </div>
            <div style={{ flex: "none" }}>
              <span className="bp-field-label">Тип канала</span>
              <SyncSegmented value={newSync} onChange={setNewSync} disabled={busy} compact />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
            <button className="bp-btn-ghost" onClick={onClose}>
              Отмена
            </button>
            <button className="bp-btn-primary" onClick={() => void addSchemaEdge()} disabled={busy}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IcoLink s={14} />
                {busy ? "Добавляем…" : "Добавить связь в схему"}
              </span>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11.5, color: BPT.micro, padding: "4px 14px 6px" }}>
            Сообщение — из задокументированных связей между ними:
          </div>
          <div style={{ padding: "0 14px", display: "grid", gap: 9, maxHeight: 200, overflow: "auto" }}>
            {channels.map((ch) => (
              <div className="bp-channel" key={ch.edge_id}>
                <div className="bp-channelhd">
                  <b>
                    {nameOf(ch.legs[0]?.from_id ?? "")} → {nameOf(ch.legs[0]?.to_id ?? "")}
                  </b>
                  {ch.technology && (
                    <span
                      style={{
                        fontSize: 9.5,
                        fontWeight: 600,
                        color: BPT.micro,
                        background: "#f1f5f9",
                        border: "1px solid " + BPT.line,
                        borderRadius: 4,
                        padding: "1px 5px",
                      }}
                    >
                      {ch.technology}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", flex: "none" }}>
                    <SyncSegmented
                      value={ch.synchronous}
                      onChange={(v) => void setChannelSync(ch.edge_id, v)}
                      disabled={syncEdge !== null}
                      compact
                    />
                  </span>
                </div>
                {ch.legs.map((leg) => {
                  const m = legMeta(leg.kind);
                  const on = sel?.edgeId === ch.edge_id && sel?.leg === leg.leg;
                  return (
                    <button
                      key={leg.leg}
                      className={"bp-legpick" + (on ? " is-sel" : "")}
                      onClick={() => setSel({ edgeId: ch.edge_id, leg: leg.leg })}
                    >
                      <span className={"bp-legradio" + (on ? " is-on" : "")} />
                      <span style={{ color: BPT.head, flex: "none", display: "inline-flex" }}>
                        <m.Icon s={13} />
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: BPT.head,
                          textTransform: "uppercase",
                          letterSpacing: ".03em",
                          flex: "none",
                        }}
                      >
                        {m.word}
                      </span>
                      <span style={{ fontSize: 12.5, color: BPT.head }}>
                        «{leg.default_caption ?? "—"}»
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, padding: "12px 14px 14px", justifyContent: "flex-end", borderTop: "1px solid " + BPT.line2, marginTop: 10 }}>
            <button className="bp-btn-ghost" onClick={onClose}>
              Отмена
            </button>
            <button className="bp-btn-primary" onClick={() => void add()} disabled={!sel || busy}>
              Добавить сообщение
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Схематичная карточка узла (иконка C4 + имя, без подробностей).
function NodeChip({ part, fallback }: { part: ProcessParticipant | undefined; fallback: string }) {
  return (
    <div style={chip}>
      <span style={{ color: part?.is_external ? BPT.mut : BPT.sec, display: "inline-flex", flex: "none" }}>
        <C4Glyph shape={part?.shape ?? "service"} s={17} />
      </span>
      <b style={{ fontSize: 13, fontWeight: 600, color: BPT.head, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {part?.name ?? fallback}
      </b>
    </div>
  );
}

const chip: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flex: 1,
  minWidth: 0,
  height: 40,
  padding: "0 11px",
  background: "#fff",
  border: "1px solid " + BPT.line,
  borderRadius: 9,
};
const validator: CSSProperties = {
  display: "flex",
  gap: 11,
  padding: "13px 14px",
  background: BPT.amberBg,
  border: "1px solid " + BPT.amberLine,
  borderRadius: 10,
};
