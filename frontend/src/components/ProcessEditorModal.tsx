import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { processesApi } from "../api/processes";
import type { FragmentKind, NodeStatus, ProcessDetail, ProcessParticipant } from "../types";
import Modal from "../ui/Modal";
import MessageComposer from "./MessageComposer";
import NodeSearchPicker from "./NodeSearchPicker";
import ParticipantDeleteConfirm from "./processes/ParticipantDeleteConfirm";
import { C4Glyph, IcoClose, IcoPlus } from "./processes/icons";
import LegLegend from "./processes/LegLegend";
import ProcessWindow from "./processes/ProcessWindow";
import { SchemaViewSeg, StatusLegend, ViewHint } from "./processes/SchemaViewChrome";
import SequenceDiagram from "./processes/SequenceDiagram";
import { deriveActivations } from "./processes/sequence/layout";
import { detailToSeq } from "./processes/sequence/fromDetail";
import { BPT } from "./processes/tokens";
import { readSchemaView, SCHEMA_VIEW_KEY, type SchemaView } from "./schemaView";
import "./processes/processes.css";

/**
 * Редактор процесса (архитектор). Правки персистятся сразу (как везде в ArchMap):
 * после каждого действия перечитываем детали. Сообщение добавляется через
 * MessageComposer (только плечи существующих каналов). Свободный слой — фрагменты
 * alt/opt/loop/par. Участники — узлы C4 из схемы.
 */
interface Props {
  id: string;
  onClose: () => void;
}

const FRAGMENTS: FragmentKind[] = ["alt", "opt", "loop", "par"];

export default function ProcessEditorModal({ id, onClose }: Props) {
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Пара для композитора задаётся drag-to-connect на схеме (node_id источника/цели).
  const [composer, setComposer] = useState<{ from: string; to: string } | null>(null);
  const [partPanel, setPartPanel] = useState(false);
  const [fragKind, setFragKind] = useState<FragmentKind | null>(null);
  const [fragGuard, setFragGuard] = useState("");
  const [delMsg, setDelMsg] = useState<string | null>(null);
  // Участник, чьё удаление подтверждаем (есть проведённые связи). null — модалки нет.
  const [delPart, setDelPart] = useState<ProcessParticipant | null>(null);
  const [delPartBusy, setDelPartBusy] = useState(false);
  const [delPartErr, setDelPartErr] = useState<string | null>(null);
  // Вид схемы — общая привычка пользователя (тот же ключ, что у C4-схемы).
  const [view, setView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { localStorage.setItem(SCHEMA_VIEW_KEY, view); }, [view]);

  const reload = useCallback(() => {
    processesApi
      .get(id)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Не удалось загрузить процесс"));
  }, [id]);

  useEffect(reload, [reload]);

  const seq = useMemo(() => (detail ? detailToSeq(detail) : null), [detail]);
  const activations = useMemo(() => (seq ? deriveActivations(seq.messages) : []), [seq]);
  const counts = useMemo<Record<NodeStatus, number>>(() => {
    const c: Record<NodeStatus, number> = { existing: 0, planned: 0, deprecated: 0 };
    if (detail) for (const p of detail.participants) c[p.status]++;
    return c;
  }, [detail]);
  const hasStatus = counts.planned + counts.deprecated > 0;
  const nextOrder = useMemo(
    () => (detail ? detail.messages.reduce((mx, m) => Math.max(mx, m.order), -1) + 1 : 0),
    [detail],
  );
  // Имя участника по node_id (для подписи концов в подтверждении удаления).
  const nameByNode = useMemo(() => {
    const m: Record<string, string> = {};
    if (detail) for (const p of detail.participants) m[p.node_id] = p.name;
    return m;
  }, [detail]);
  // Связи удаляемого участника на схеме: подпись сообщения + направление + другой конец.
  const delLinks = useMemo(() => {
    if (!detail || !delPart) return [];
    return detail.messages
      .filter((m) => m.from_id === delPart.node_id || m.to_id === delPart.node_id)
      .map((m) => {
        const outgoing = m.from_id === delPart.node_id;
        const other = outgoing ? m.to_id : m.from_id;
        return {
          id: m.id,
          label: m.caption || m.technology || "сообщение",
          dir: (outgoing ? "к" : "от") as "к" | "от",
          other: nameByNode[other] ?? other,
        };
      });
  }, [detail, delPart, nameByNode]);

  async function addParticipant(nodeId: string) {
    if (!detail) return;
    try {
      await processesApi.addParticipant(id, { node_id: nodeId, order: detail.participants.length });
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить участника");
    }
  }
  // Сообщения процесса, проходящие через узел (по любому концу) — то, что исчезнет
  // вместе с участником (бэк сносит их каскадом).
  function messagesThrough(nodeId: string) {
    return detail ? detail.messages.filter((m) => m.from_id === nodeId || m.to_id === nodeId) : [];
  }
  // Запрос на удаление участника: если связей на схеме нет — удаляем сразу (как в C4
  // NodeDeleteConfirm — подтверждать нечего); иначе показываем подтверждение со списком.
  function requestRemoveParticipant(p: ProcessParticipant) {
    if (messagesThrough(p.node_id).length === 0) {
      void removeParticipant(p.id);
      return;
    }
    setDelPartErr(null);
    setDelPart(p);
  }
  async function removeParticipant(pid: string) {
    try {
      await processesApi.removeParticipant(id, pid);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось удалить участника");
    }
  }
  async function confirmRemoveParticipant() {
    if (!delPart) return;
    setDelPartBusy(true);
    setDelPartErr(null);
    try {
      await processesApi.removeParticipant(id, delPart.id);
      setDelPart(null);
      reload();
    } catch (e: unknown) {
      setDelPartErr(e instanceof Error ? e.message : "Не удалось удалить участника");
    } finally {
      setDelPartBusy(false);
    }
  }
  async function removeMessage(mid: string) {
    try {
      await processesApi.removeMessage(id, mid);
      setDelMsg(null);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось удалить сообщение");
    }
  }
  async function addFragment() {
    if (!detail || !fragKind || detail.messages.length === 0) return;
    const orders = detail.messages.map((m) => m.order);
    try {
      // Один фрагмент на процесс (движок рендерит один): старый снимаем.
      for (const f of detail.fragments) await processesApi.removeFragment(id, f.id);
      await processesApi.addFragment(id, {
        kind: fragKind,
        from_order: Math.min(...orders),
        to_order: Math.max(...orders),
        guard: fragGuard.trim() || null,
        else_guard: null,
        else_order: null,
      });
      setFragKind(null);
      setFragGuard("");
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить фрагмент");
    }
  }

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ padding: 0, width: 1040, display: "flex", flexDirection: "column" }}>
      <ProcessWindow
        title={`${detail?.name ?? "Процесс"} — редактирование`}
        scope={detail?.scope_name}
        width={1040}
        height="min(800px, 88vh)"
        actions={
          <>
            {hasStatus && <SchemaViewSeg view={view} onChange={setView} />}
            <span style={{ fontSize: 12, color: "#0e9f6e", display: "inline-flex", alignItems: "center", gap: 5, marginRight: 2 }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: "#0e9f6e" }} />
              сохранено
            </span>
            <button className="bp-btn-primary" onClick={onClose}>
              Готово
            </button>
            <button className="bp-iconbtn" title="Закрыть" onClick={onClose}>
              <IcoClose />
            </button>
          </>
        }
        foot={
          <>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: BPT.mut, marginRight: 2 }}>
              Фрагменты
            </span>
            {FRAGMENTS.map((k) => (
              <button
                key={k}
                className="bp-palitem"
                title={`Фрагмент ${k}`}
                onClick={() => { setFragKind(k); setFragGuard(""); }}
                disabled={!detail || detail.messages.length === 0}
              >
                <span className="bp-fragtag">{k}</span>
              </button>
            ))}
            <span style={{ width: 1, height: 22, background: BPT.line, margin: "0 4px" }} />
            <button className="bp-addpart" onClick={() => setPartPanel(true)}>
              <IcoPlus s={14} />
              <span>Добавить участника</span>
              <span className="bp-addparthint">из узлов схемы</span>
            </button>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
              <StatusLegend view={view} counts={counts} />
              <LegLegend />
            </span>
          </>
        }
      >
        {hasStatus && <ViewHint view={view} />}
        <div className="bp-canvas" style={{ flex: 1, overflow: "auto", position: "relative" }}>
          {error && <div style={{ padding: "8px 14px 0", color: "#dc2626", fontSize: 12 }}>{error}</div>}
          {!detail || !seq ? (
            <div style={{ padding: 24, color: BPT.mut, fontSize: 14 }}>Загрузка…</div>
          ) : seq.participants.length === 0 ? (
            <div style={{ padding: 24, color: BPT.mut, fontSize: 14 }}>
              Добавьте участников (узлы схемы), затем сообщения между ними.
            </div>
          ) : (
            <div style={{ padding: "8px 12px 18px", width: "max-content" }}>
              <SequenceDiagram
                participants={seq.participants}
                messages={seq.messages}
                activations={activations}
                fragment={seq.fragment}
                view={view}
                ghost
                onConnect={(from, to) => setComposer({ from, to })}
                onMessageClick={(mid) => setDelMsg(mid)}
                onDeleteParticipant={(nodeId) => {
                  const p = detail.participants.find((pp) => pp.node_id === nodeId);
                  if (p) requestRemoveParticipant(p);
                }}
              />
            </div>
          )}

          {/* Композитор сообщения — оверлей по центру тела */}
          {composer && detail && (
            <>
              <div style={overlayDim} onClick={() => setComposer(null)} />
              <div style={overlayCenter}>
                <MessageComposer
                  processId={id}
                  participants={detail.participants}
                  fromNode={composer.from}
                  toNode={composer.to}
                  defaultOrder={nextOrder}
                  onClose={() => setComposer(null)}
                  onAdded={reload}
                />
              </div>
            </>
          )}

          {/* Подтверждение удаления сообщения */}
          {delMsg && (
            <>
              <div style={overlayDim} onClick={() => setDelMsg(null)} />
              <div style={overlayCenter}>
                <div style={confirmCard}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head }}>Удалить сообщение?</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                    <button className="bp-btn-ghost" onClick={() => setDelMsg(null)}>Отмена</button>
                    <button className="bp-btn-primary" style={{ background: "#dc2626", borderColor: "#dc2626" }} onClick={() => void removeMessage(delMsg)}>
                      Удалить
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Подтверждение удаления участника (со списком связей на схеме) */}
          {delPart && (
            <>
              <div style={overlayDim} onClick={() => { if (!delPartBusy) setDelPart(null); }} />
              <div style={overlayCenter}>
                <ParticipantDeleteConfirm
                  name={delPart.name}
                  links={delLinks}
                  deleting={delPartBusy}
                  error={delPartErr}
                  onConfirm={() => void confirmRemoveParticipant()}
                  onCancel={() => setDelPart(null)}
                />
              </div>
            </>
          )}

          {/* Фрагмент: ввод условия */}
          {fragKind && detail && (
            <>
              <div style={overlayDim} onClick={() => setFragKind(null)} />
              <div style={overlayCenter}>
                <div style={confirmCard}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head, marginBottom: 4 }}>
                    Фрагмент «{fragKind}» — на все сообщения
                  </div>
                  <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>
                    Условие (показывается у рамки). Заменит существующий фрагмент, если есть.
                  </div>
                  <input
                    value={fragGuard}
                    onChange={(e) => setFragGuard(e.target.value)}
                    placeholder="напр. [ оплата прошла ]"
                    style={fragInput}
                    autoFocus
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                    <button className="bp-btn-ghost" onClick={() => setFragKind(null)}>Отмена</button>
                    <button className="bp-btn-primary" onClick={() => void addFragment()}>Добавить</button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Управление участниками */}
          {partPanel && detail && (
            <>
              <div style={overlayDim} onClick={() => setPartPanel(false)} />
              <div style={overlayCenter}>
                <div style={{ ...confirmCard, width: 340, textAlign: "left" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: BPT.head }}>Участники</div>
                    <button className="bp-iconbtn" style={{ width: 26, height: 26 }} onClick={() => setPartPanel(false)}>
                      <IcoClose s={14} />
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10, maxHeight: 160, overflow: "auto" }}>
                    {detail.participants.length === 0 ? (
                      <div style={{ fontSize: 12, color: BPT.mut }}>Пока никого</div>
                    ) : (
                      [...detail.participants]
                        .sort((a, b) => a.order - b.order)
                        .map((p) => (
                          <div key={p.id} style={partRow}>
                            <span style={{ color: p.is_external ? BPT.mut : BPT.sec, display: "inline-flex" }}>
                              <C4Glyph shape={p.shape} s={15} />
                            </span>
                            <span style={{ fontSize: 13, color: BPT.head, flex: 1 }}>{p.name}</span>
                            <button style={partX} title="Убрать" onClick={() => requestRemoveParticipant(p)}>
                              <IcoClose s={13} />
                            </button>
                          </div>
                        ))
                    )}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: BPT.mut, marginBottom: 6 }}>
                    Добавить узел
                  </div>
                  <NodeSearchPicker
                    key={detail.participants.length}
                    value=""
                    onChange={(nodeId) => { if (nodeId) void addParticipant(nodeId); }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </ProcessWindow>
    </Modal>
  );
}

const overlayDim: CSSProperties = { position: "absolute", inset: 0, background: "rgba(15,23,42,.06)", zIndex: 5 };
const overlayCenter: CSSProperties = {
  position: "absolute",
  top: 80,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 6,
};
const confirmCard: CSSProperties = {
  width: 300,
  background: "#fff",
  border: "1px solid " + BPT.line,
  borderRadius: 13,
  boxShadow: "0 20px 56px rgba(15,23,42,.24)",
  padding: 16,
};
const fragInput: CSSProperties = {
  width: "100%",
  height: 34,
  padding: "0 10px",
  border: "1px solid " + BPT.line,
  borderRadius: 8,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};
const partRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 6px",
  borderRadius: 7,
  background: "#f8fafc",
};
const partX: CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  color: "#94a3b8",
  display: "inline-flex",
  padding: 2,
};
