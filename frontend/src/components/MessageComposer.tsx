import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import { edgesApi } from "../api/nodes";
import { processesApi } from "../api/processes";
import type { Channel, ProcessParticipant } from "../types";
import { C4Glyph, IcoArrowR, IcoChevron, IcoClose, IcoLink, IcoWarn } from "./processes/icons";
import { legMeta } from "./processes/legMeta";
import { BPT } from "./processes/tokens";
import "./processes/processes.css";

/**
 * Композитор сообщения (звезда фичи). Сообщение НЕ рисуется, а выбирается из плеч
 * задокументированных каналов между двумя участниками (GET /channels). Нет канала →
 * валидатор ведёт достроить схему. Легальность плеч проверяет бэк — мы только показываем.
 */
interface Props {
  processId: string;
  participants: ProcessParticipant[];
  defaultOrder: number; // order для нового сообщения (в конец)
  onClose: () => void;
  onAdded: () => void; // перечитать детали процесса
}

export default function MessageComposer({ processId, participants, defaultOrder, onClose, onAdded }: Props) {
  const [fromNode, setFromNode] = useState<string>("");
  const [toNode, setToNode] = useState<string>("");
  // Результат /channels привязан к паре (key): пока key не совпал с текущей парой —
  // считаем «грузим» (channels=null). Так setState живёт только в async-колбэке, без
  // синхронного setState в эффекте (производное — в рендере).
  const [result, setResult] = useState<{ key: string; data: Channel[] } | null>(null);
  const [sel, setSel] = useState<{ edgeId: string; leg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const partByNode = useMemo(() => {
    const m: Record<string, ProcessParticipant> = {};
    for (const p of participants) m[p.node_id] = p;
    return m;
  }, [participants]);
  const nameOf = (nodeId: string) => partByNode[nodeId]?.name ?? nodeId;

  const pairReady = fromNode !== "" && toNode !== "" && fromNode !== toNode;
  const pairKey = pairReady ? `${fromNode}|${toNode}` : "";
  const channels = result && result.key === pairKey ? result.data : null;

  useEffect(() => {
    if (!pairReady) return;
    let alive = true;
    processesApi
      .channels(processId, fromNode, toNode)
      .then((ch) => alive && setResult({ key: pairKey, data: ch }))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Ошибка загрузки каналов"));
    return () => { alive = false; };
  }, [processId, fromNode, toNode, pairReady, pairKey]);

  // Смена участника сбрасывает выбранное плечо (в обработчиках, не в эффекте).
  const pickFrom = (n: string) => { setFromNode(n); setSel(null); };
  const pickTo = (n: string) => { setToNode(n); setSel(null); };

  async function addSchemaEdge() {
    setBusy(true);
    setError(null);
    try {
      // «Достроить схему»: документируем связь между узлами — она тут же появится
      // как плечо (канал). MVP без tech/label — связь синхронная по умолчанию.
      await edgesApi.create({ source_id: fromNode, target_id: toNode });
      const ch = await processesApi.channels(processId, fromNode, toNode);
      setResult({ key: pairKey, data: ch });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить связь");
    } finally {
      setBusy(false);
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
      await processesApi.addMessage(processId, {
        edge_id: channel.edge_id,
        leg: leg.leg,
        from_participant_id: fromP.id,
        to_participant_id: toP.id,
        caption: null,
        order: defaultOrder,
      });
      onAdded();
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

      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px 6px" }}>
        <div style={{ flex: 1 }}>
          <div className="bp-fieldlab">От кого</div>
          <ParticipantSelect participants={participants} value={fromNode} onPick={pickFrom} />
        </div>
        <span style={{ color: BPT.mut, marginTop: 16, flex: "none" }}>
          <IcoArrowR s={16} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="bp-fieldlab">Кому</div>
          <ParticipantSelect participants={participants} value={toNode} onPick={pickTo} />
        </div>
      </div>

      {error && <div style={{ color: "#dc2626", fontSize: 12, padding: "0 14px 6px" }}>{error}</div>}

      {!pairReady ? (
        <div style={{ fontSize: 12, color: BPT.mut, padding: "6px 14px 16px" }}>
          Выберите двух разных участников.
        </div>
      ) : channels === null ? (
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
                Процесс не может отправить сообщение, которого нет в архитектуре. Добавьте связь
                «{nameOf(fromNode)} → {nameOf(toNode)}» в схему — и она появится здесь как плечо.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
            <button className="bp-btn-ghost" onClick={() => { setFromNode(""); setToNode(""); setSel(null); }}>
              Выбрать другую пару
            </button>
            <button className="bp-btn-primary" onClick={() => void addSchemaEdge()} disabled={busy}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IcoLink s={14} />
                Добавить связь в схему
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
                  <span className={"bp-channeltag" + (ch.synchronous ? "" : " bp-channeltag--async")}>
                    {ch.synchronous ? "синхронный" : "async"}
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
                      <span style={{ color: m.ink, flex: "none", display: "inline-flex" }}>
                        <m.Icon s={13} />
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: m.ink,
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

// Выбор участника (От/Кому) — кнопка с дропдауном. Вынесен из композитора, чтобы не
// ремаунтился на каждый рендер.
function ParticipantSelect({
  participants,
  value,
  onPick,
}: {
  participants: ProcessParticipant[];
  value: string;
  onPick: (nodeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Снимок на момент открытия: координаты кнопки (позиционируем по ним дропдаун) и
  // хост портала. Композитор лежит в .bp-composer с overflow:hidden, который обрезал
  // бы дропдаун, поэтому рендерим список порталом прямо в <dialog> (top-layer
  // модалки) с position:fixed — он ложится ПОВЕРХ границы и не обрезается. Портал в
  // body не подошёл бы — ушёл бы под top-layer диалога.
  const [anchor, setAnchor] = useState<{ rect: DOMRect; host: Element } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const sel = participants.find((p) => p.node_id === value);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next && btnRef.current) {
        setAnchor({
          rect: btnRef.current.getBoundingClientRect(),
          host: btnRef.current.closest("dialog") ?? document.body,
        });
      }
      return next;
    });
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        className={"bp-pairsel" + (sel ? "" : " is-placeholder")}
        onClick={toggle}
      >
        {sel ? (
          <>
            <span style={{ color: sel.is_external ? BPT.mut : BPT.sec, display: "inline-flex" }}>
              <C4Glyph shape={sel.shape} s={16} />
            </span>
            <b>{sel.name}</b>
          </>
        ) : (
          <span style={{ fontSize: 13 }}>Выбрать…</span>
        )}
        <span className="bp-caret">
          <IcoChevron s={11} open={open} />
        </span>
      </button>
      {open && anchor &&
        createPortal(
          <>
            <div style={ddBackdrop} onClick={() => setOpen(false)} />
            <div
              style={{
                ...dropdown,
                top: anchor.rect.bottom + 4,
                left: anchor.rect.left,
                width: anchor.rect.width,
              }}
            >
              {participants.length === 0 ? (
                <div style={{ padding: "8px 11px", fontSize: 12, color: BPT.mut }}>Нет участников</div>
              ) : (
                participants.map((p) => (
                  <button
                    key={p.id}
                    style={ddItem}
                    onClick={() => { onPick(p.node_id); setOpen(false); }}
                  >
                    <span style={{ color: p.is_external ? BPT.mut : BPT.sec, display: "inline-flex" }}>
                      <C4Glyph shape={p.shape} s={15} />
                    </span>
                    <span style={{ fontSize: 13, color: BPT.head }}>{p.name}</span>
                  </button>
                ))
              )}
            </div>
          </>,
          anchor.host,
        )}
    </div>
  );
}

const validator: CSSProperties = {
  display: "flex",
  gap: 11,
  padding: "13px 14px",
  background: BPT.amberBg,
  border: "1px solid " + BPT.amberLine,
  borderRadius: 10,
};
const ddBackdrop: CSSProperties = { position: "fixed", inset: 0, zIndex: 2147483646 };
const dropdown: CSSProperties = {
  position: "fixed",
  zIndex: 2147483647,
  background: "#fff",
  border: "1px solid " + BPT.line,
  borderRadius: 8,
  boxShadow: "0 14px 36px rgba(15,23,42,.16)",
  padding: 4,
  maxHeight: 200,
  overflow: "auto",
};
const ddItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "7px 9px",
  background: "none",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  textAlign: "left",
};
