import { useEffect, useMemo, useState } from "react";
import { edgesApi } from "../api/nodes";
import { processesApi } from "../api/processes";
import type { Channel, MessageCreate, ProcessMessage, ProcessParticipant } from "../types";
import { C4Glyph, IcoArrowR } from "./processes/icons";
import { legMeta } from "./processes/legMeta";
import SyncSelect from "./SyncSelect";
import { CloseIcon } from "../ui/icons";
import "../ui/ds.css";
import "./processes/processes.css";
import { limitMessage } from "./demo/demoLimits";
import type { LimitMessage } from "./demo/demoLimits";
import { LimitText } from "./demo/DemoLimitToast";
import { noAutofill } from "../ui/noAutofill";

/**
 * Композитор сообщения (звезда фичи). Пара участников приходит готовой: её задаёт
 * пользователь, протянув стрелку между линиями жизни на схеме (drag-to-connect),
 * поэтому полей «От кого/Кому» тут больше нет — только схема выбранной пары.
 * Сообщение НЕ рисуется, а выбирается из плеч задокументированных каналов между
 * двумя участниками (GET /channels). Нет канала → валидатор ведёт достроить схему.
 *
 * Вид — каркас окна нового языка карточкой поверх диаграммы (ds-win ds-win--card,
 * редизайн, фаза 13г): заголовок с крестиком; тело — пара объектов, отказы, связи пары
 * или поля новой связи; подвал — главная кнопка и «Отмена». Классы mc-* — processes.css.
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
  const [limit, setLimit] = useState<LimitMessage | null>(null);
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
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Не удалось загрузить связи"));
    return () => { alive = false; };
  }, [processId, fromNode, toNode, pairKey]);

  async function addSchemaEdge() {
    setBusy(true);
    setError(null);
    setLimit(null);
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
      // Демо-стенд: проект упёрся в предел (docs/tasks/demo-mode.md).
      const refusal = limitMessage(e, "edge");
      if (refusal) { setLimit(refusal); return; }
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
      setError("Не все объекты этой связи участвуют в процессе");
      return;
    }
    setBusy(true);
    setError(null);
    setLimit(null);
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
      setError(e instanceof Error ? e.message : "Не удалось добавить шаг");
      setBusy(false);
    }
  }

  return (
    <div className="ds ds-win ds-win--card proc-win">
      <div className="ds-win-head">
        <h2 className="ds-win-title">Добавить шаг</h2>
        <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="ds-win-body">
        {/* Пара объектов: в порядке колонок схемы, стрелка source→target */}
        <p className="mc-pair">
          <PairEnd part={partByNode[leftId]} fallback={leftId} />
          <span className={"mc-arrow" + (targetRight ? "" : " is-left")}>
            <IcoArrowR s={16} />
          </span>
          <PairEnd part={partByNode[rightId]} fallback={rightId} />
        </p>

        {error && <p className="ds-danger mc-flat">{error}</p>}
        {limit && (
          <p className="ds-danger mc-flat" role="alert">
            <LimitText message={limit} />
          </p>
        )}

        {channels === null ? (
          <p className="ds-empty mc-flat">Загрузка связей</p>
        ) : channels.length === 0 ? (
          <>
            <div>
              <p className="mc-warn-head">Между ними нет задокументированной связи</p>
              <p className="mc-muted">
                Шаг процесса идёт только по связи из схемы. Опишите связь
                «{nameOf(fromNode)} → {nameOf(toNode)}», и она появится на схеме и в этом списке.
              </p>
            </div>

            {/* Поля связи. «Что передаётся» = label связи: из него берётся подпись
                плеча, поэтому поле стоит первым и получает фокус. */}
            <div className="mc-field">
              <label className="mc-label" htmlFor="bp-new-label">Что передаётся</label>
              <input
                {...noAutofill("message-composer-1")}
                id="bp-new-label"
                className="ds-input"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="например, создать заказ"
                disabled={busy}
                autoFocus
              />
            </div>
            <div className="mc-row">
              <div className="mc-field">
                <label className="mc-label" htmlFor="bp-new-tech">Технология</label>
                <input
                  {...noAutofill("message-composer-2")}
                  id="bp-new-tech"
                  className="ds-input"
                  value={newTech}
                  onChange={(e) => setNewTech(e.target.value)}
                  placeholder="например, REST или Kafka"
                  disabled={busy}
                />
              </div>
              <div className="mc-field">
                <span className="mc-label">Тип связи</span>
                <SyncSelect className="mc-sync" value={newSync} onChange={setNewSync} disabled={busy} />
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="mc-muted">Шаг можно взять из связей между ними:</p>
            <div className="mc-channels">
              {channels.map((ch) => (
                <div className="mc-channel" key={ch.edge_id}>
                  <div className="mc-chhead">
                    <b className="mc-chname">
                      {nameOf(ch.legs[0]?.from_id ?? "")} → {nameOf(ch.legs[0]?.to_id ?? "")}
                    </b>
                    {ch.technology && <span className="mc-tech">{ch.technology}</span>}
                    <SyncSelect
                      className="mc-sync"
                      value={ch.synchronous}
                      onChange={(v) => void setChannelSync(ch.edge_id, v)}
                      disabled={syncEdge !== null}
                    />
                  </div>
                  {ch.legs.map((leg) => {
                    const m = legMeta(leg.kind);
                    const on = sel?.edgeId === ch.edge_id && sel?.leg === leg.leg;
                    return (
                      <button
                        type="button"
                        key={leg.leg}
                        className={"mc-leg" + (on ? " is-sel" : "")}
                        aria-pressed={on}
                        onClick={() => setSel({ edgeId: ch.edge_id, leg: leg.leg })}
                      >
                        <span className={"mc-radio" + (on ? " is-on" : "")} />
                        <span className="mc-legicon">
                          <m.Icon s={13} />
                        </span>
                        <span className="mc-word">{m.word}</span>
                        <span className="mc-cap">«{leg.default_caption ?? "—"}»</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {channels !== null && channels.length === 0 && (
        <div className="ds-win-foot">
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => void addSchemaEdge()} disabled={busy}>
            {busy ? "Добавляем" : "Добавить связь в схему"}
          </button>
          <button type="button" className="ds-btn" onClick={onClose}>
            Отмена
          </button>
        </div>
      )}
      {channels !== null && channels.length > 0 && (
        <div className="ds-win-foot">
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => void add()} disabled={!sel || busy}>
            Добавить шаг
          </button>
          <button type="button" className="ds-btn" onClick={onClose}>
            Отмена
          </button>
        </div>
      )}
    </div>
  );
}

// Конец пары: значок формы и имя одной строкой; длинное имя — многоточием, полное в title.
function PairEnd({ part, fallback }: { part: ProcessParticipant | undefined; fallback: string }) {
  const name = part?.name ?? fallback;
  return (
    <span className="mc-end" title={name}>
      <span className="mc-glyph">
        <C4Glyph shape={part?.shape ?? "service"} s={15} />
      </span>
      <span className="mc-name">{name}</span>
    </span>
  );
}
