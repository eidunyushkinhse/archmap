import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { processesApi } from "../api/processes";
import type { FragmentKind, MessageCreate, NodeStatus, ProcessDetail, ProcessMessage, ProcessParticipant } from "../types";
import Modal from "../ui/Modal";
import { RedoIcon, UndoIcon } from "../ui/icons";
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
import { useProcessHistory } from "./processes/useProcessHistory";
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

// Снимок сообщения для восстановления при undo (концы — node_id, разрешаются в
// participant_id на момент восстановления; edge_id null у повисших — не восстановимы).
interface MessageSnapshot {
  edge_id: string | null;
  leg: ProcessMessage["leg"];
  from_id: string;
  to_id: string;
  caption: string | null;
  order: number;
}

export default function ProcessEditorModal({ id, onClose }: Props) {
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Пара для композитора задаётся drag-to-connect на схеме (node_id источника/цели).
  const [composer, setComposer] = useState<{ from: string; to: string } | null>(null);
  // Самосообщение (внутренняя операция): node_id участника, на котором его создаём.
  const [selfMsg, setSelfMsg] = useState<string | null>(null);
  const [selfCaption, setSelfCaption] = useState("");
  const [partPanel, setPartPanel] = useState(false);
  // Режим выбора диапазона под фрагмент: выбран тип, ждём протягивания по сообщениям.
  const [fragSelect, setFragSelect] = useState<FragmentKind | null>(null);
  // Диапазон выбран (индексы строк), ждём ввода условия перед созданием.
  const [pendingFrag, setPendingFrag] = useState<{ kind: FragmentKind; fromRow: number; toRow: number } | null>(null);
  const [fragGuard, setFragGuard] = useState("");
  // Фрагмент, удаление которого подтверждаем (id). null — модалки нет.
  const [delFrag, setDelFrag] = useState<string | null>(null);
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

  // Undo/Redo: каждая мутация регистрирует обратимую команду (компенсирующий вызов API).
  const hist = useProcessHistory(reload);
  // node_id → participant_id из СВЕЖЕГО состояния процесса (для restore-замыканий, где
  // участники могли пересоздаться с новыми id). Берём с сервера, а не из stale-detail.
  const freshPartByNode = useCallback(async () => {
    const fresh = await processesApi.get(id);
    const m: Record<string, string> = {};
    for (const p of fresh.participants) m[p.node_id] = p.id;
    return m;
  }, [id]);
  // Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) — как на C4. Не перехватываем при вводе в поля.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); hist.undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); hist.redo(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hist]);

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
    const order = detail.participants.length;
    try {
      const np = await processesApi.addParticipant(id, { node_id: nodeId, order });
      let pid = np.id;
      hist.push({
        label: "Добавление участника",
        undo: () => processesApi.removeParticipant(id, pid),
        redo: async () => {
          const r = await processesApi.addParticipant(id, { node_id: nodeId, order });
          pid = r.id;
        },
      });
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить участника");
    }
  }
  // Снимок сообщений, проходящих через узел: бэк сносит их каскадом при удалении
  // участника, поэтому для undo восстанавливаем и участника, и его сообщения.
  function captureMessages(nodeId: string): MessageSnapshot[] {
    return messagesThrough(nodeId).map((m) => ({
      edge_id: m.edge_id,
      leg: m.leg,
      from_id: m.from_id,
      to_id: m.to_id,
      caption: m.caption,
      order: m.order,
    }));
  }
  // Восстановить сообщения по снимку: концы (node_id) разрешаем в актуальные
  // participant_id. Самосообщения (from==to, без edge_id) восстанавливаем; повисшие
  // без edge_id и без self (связь реально удалена из схемы) восстановить нельзя.
  async function restoreMessages(snaps: MessageSnapshot[]) {
    if (snaps.length === 0) return;
    const partByNode = await freshPartByNode();
    for (const m of snaps) {
      const isSelf = m.from_id === m.to_id;
      if (!m.edge_id && !isSelf) continue;
      const fromP = partByNode[m.from_id];
      const toP = partByNode[m.to_id];
      if (!fromP || !toP) continue;
      await processesApi.addMessage(id, {
        edge_id: m.edge_id,
        leg: m.leg,
        from_participant_id: fromP,
        to_participant_id: toP,
        caption: m.caption,
        order: m.order,
      });
    }
  }
  // Сообщения процесса, проходящие через узел (по любому концу) — то, что исчезнет
  // вместе с участником (бэк сносит их каскадом).
  function messagesThrough(nodeId: string) {
    return detail ? detail.messages.filter((m) => m.from_id === nodeId || m.to_id === nodeId) : [];
  }
  // Удаление участника + регистрация команды отката (восстанавливает участника и его
  // каскадно снесённые сообщения). Forward выполняется здесь; reload — на стороне вызова.
  async function doRemoveParticipant(p: ProcessParticipant) {
    const { node_id, order } = p;
    const snaps = captureMessages(node_id);
    await processesApi.removeParticipant(id, p.id);
    hist.push({
      label: "Удаление участника",
      undo: async () => {
        await processesApi.addParticipant(id, { node_id, order });
        await restoreMessages(snaps);
      },
      redo: async () => {
        const partByNode = await freshPartByNode();
        const pid = partByNode[node_id];
        if (pid) await processesApi.removeParticipant(id, pid);
      },
    });
  }
  // Запрос на удаление участника: если связей на схеме нет — удаляем сразу (как в C4
  // NodeDeleteConfirm — подтверждать нечего); иначе показываем подтверждение со списком.
  function requestRemoveParticipant(p: ProcessParticipant) {
    if (messagesThrough(p.node_id).length === 0) {
      void removeParticipant(p);
      return;
    }
    setDelPartErr(null);
    setDelPart(p);
  }
  async function removeParticipant(p: ProcessParticipant) {
    try {
      await doRemoveParticipant(p);
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
      await doRemoveParticipant(delPart);
      setDelPart(null);
      reload();
    } catch (e: unknown) {
      setDelPartErr(e instanceof Error ? e.message : "Не удалось удалить участника");
    } finally {
      setDelPartBusy(false);
    }
  }
  // Создано сообщение (из MessageComposer): регистрируем откат (undo — удалить по id,
  // redo — пересоздать из payload, обновив id) и перечитываем.
  function handleMessageAdded(created: ProcessMessage, payload: MessageCreate) {
    let mid = created.id;
    hist.push({
      label: "Добавление сообщения",
      undo: () => processesApi.removeMessage(id, mid),
      redo: async () => {
        const r = await processesApi.addMessage(id, payload);
        mid = r.id;
      },
    });
    reload();
  }
  // Создать самосообщение на участнике (внутренняя операция — без связи C4).
  async function createSelfMessage(nodeId: string, caption: string) {
    if (!detail) return;
    const part = detail.participants.find((p) => p.node_id === nodeId);
    if (!part) return;
    const payload: MessageCreate = {
      leg: "forward",
      from_participant_id: part.id,
      to_participant_id: part.id,
      caption: caption.trim() || null,
      order: nextOrder,
    };
    try {
      const created = await processesApi.addMessage(id, payload);
      let mid = created.id;
      hist.push({
        label: "Самосообщение",
        undo: () => processesApi.removeMessage(id, mid),
        redo: async () => {
          // participant_id мог смениться (участника пересоздавали) — берём по node_id.
          const partByNode = await freshPartByNode();
          const pid = partByNode[nodeId];
          if (!pid) return;
          const r = await processesApi.addMessage(id, { ...payload, from_participant_id: pid, to_participant_id: pid });
          mid = r.id;
        },
      });
      setSelfMsg(null);
      setSelfCaption("");
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить самосообщение");
    }
  }
  async function removeMessage(mid: string) {
    const m = detail?.messages.find((x) => x.id === mid);
    try {
      await processesApi.removeMessage(id, mid);
      setDelMsg(null);
      if (m) {
        const snap: MessageSnapshot = {
          edge_id: m.edge_id, leg: m.leg, from_id: m.from_id, to_id: m.to_id, caption: m.caption, order: m.order,
        };
        let restoredId: string | null = null;
        hist.push({
          label: "Удаление сообщения",
          undo: async () => {
            const isSelf = snap.from_id === snap.to_id;
            if (!snap.edge_id && !isSelf) return; // повисшее (не self) — восстановить нельзя
            const partByNode = await freshPartByNode();
            const fromP = partByNode[snap.from_id];
            const toP = partByNode[snap.to_id];
            if (!fromP || !toP) return;
            const created = await processesApi.addMessage(id, {
              edge_id: snap.edge_id, leg: snap.leg, from_participant_id: fromP, to_participant_id: toP, caption: snap.caption, order: snap.order,
            });
            restoredId = created.id;
          },
          redo: async () => {
            if (restoredId) await processesApi.removeMessage(id, restoredId);
          },
        });
      }
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось удалить сообщение");
    }
  }
  // Создать фрагмент на ВЫБРАННОМ диапазоне строк (не на всей схеме). Индексы строк
  // переводим в order сообщений (бэк хранит фрагмент в order-координатах). Старые
  // фрагменты НЕ трогаем — их может быть несколько (в т.ч. вложенных).
  async function createFragment(kind: FragmentKind, fromRow: number, toRow: number, guard: string) {
    if (!detail) return;
    const sorted = [...detail.messages].sort((a, b) => a.order - b.order);
    if (fromRow < 0 || toRow >= sorted.length || fromRow > toRow) return;
    const payload = {
      kind,
      from_order: sorted[fromRow].order,
      to_order: sorted[toRow].order,
      guard: guard.trim() || null,
      else_guard: null,
      else_order: null,
    };
    try {
      const created = await processesApi.addFragment(id, payload);
      let fid = created.id;
      hist.push({
        label: "Добавление фрагмента",
        undo: () => processesApi.removeFragment(id, fid),
        redo: async () => {
          const r = await processesApi.addFragment(id, payload);
          fid = r.id;
        },
      });
      setPendingFrag(null);
      setFragGuard("");
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить фрагмент");
    }
  }
  async function removeFragment(fid: string) {
    const f = detail?.fragments.find((x) => x.id === fid);
    try {
      await processesApi.removeFragment(id, fid);
      setDelFrag(null);
      if (f) {
        const payload = {
          kind: f.kind, from_order: f.from_order, to_order: f.to_order, guard: f.guard, else_guard: f.else_guard, else_order: f.else_order,
        };
        let restoredId: string | null = null;
        hist.push({
          label: "Удаление фрагмента",
          undo: async () => {
            const r = await processesApi.addFragment(id, payload);
            restoredId = r.id;
          },
          redo: async () => {
            if (restoredId) await processesApi.removeFragment(id, restoredId);
          },
        });
      }
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось удалить фрагмент");
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
            {/* Undo/Redo — как на C4-канвасе (компенсирующие вызовы API) */}
            <div style={{ display: "inline-flex", gap: 4, marginRight: 2 }}>
              <button
                className="bp-iconbtn"
                onClick={hist.undo}
                disabled={!hist.canUndo || hist.busy}
                title="Отменить · Ctrl+Z"
                aria-label="Отменить"
              >
                <UndoIcon size={16} />
              </button>
              <button
                className="bp-iconbtn"
                onClick={hist.redo}
                disabled={!hist.canRedo || hist.busy}
                title="Вернуть · Ctrl+Shift+Z"
                aria-label="Вернуть"
              >
                <RedoIcon size={16} />
              </button>
            </div>
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
                className={"bp-palitem" + (fragSelect === k ? " is-active" : "")}
                title={`Фрагмент ${k} — выделить диапазон сообщений`}
                onClick={() => setFragSelect((cur) => (cur === k ? null : k))}
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
                fragments={seq.fragments}
                view={view}
                ghost
                selectMode={fragSelect}
                onSelectRange={(from, to) => {
                  setFragSelect((kind) => {
                    if (kind) { setPendingFrag({ kind, fromRow: from, toRow: to }); setFragGuard(""); }
                    return null;
                  });
                }}
                onFragmentClick={(fid) => setDelFrag(fid)}
                onConnect={(from, to) => setComposer({ from, to })}
                onSelfConnect={(nodeId) => { setSelfMsg(nodeId); setSelfCaption(""); }}
                onMessageClick={(mid) => setDelMsg(mid)}
                onDeleteParticipant={(nodeId) => {
                  const p = detail.participants.find((pp) => pp.node_id === nodeId);
                  if (p) requestRemoveParticipant(p);
                }}
              />
            </div>
          )}

          {/* Подсказка режима выбора диапазона под фрагмент */}
          {fragSelect && (
            <div style={fragHintBar}>
              <span>
                Протяните по сообщениям, чтобы выделить диапазон для фрагмента{" "}
                <b style={{ color: BPT.amber }}>«{fragSelect}»</b>
              </span>
              <button className="bp-btn-ghost" style={{ height: 26, padding: "0 10px" }} onClick={() => setFragSelect(null)}>
                Отмена
              </button>
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
                  onAdded={handleMessageAdded}
                />
              </div>
            </>
          )}

          {/* Самосообщение: ввод подписи внутренней операции */}
          {selfMsg && detail && (
            <>
              <div style={overlayDim} onClick={() => setSelfMsg(null)} />
              <div style={overlayCenter}>
                <div style={confirmCard}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head, marginBottom: 4 }}>
                    Внутренняя операция · {nameByNode[selfMsg] ?? selfMsg}
                  </div>
                  <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>
                    Действие участника над самим собой (без связи в C4) — самозамкнутая стрелка.
                  </div>
                  <input
                    value={selfCaption}
                    onChange={(e) => setSelfCaption(e.target.value)}
                    placeholder="напр. валидация заказа"
                    style={fragInput}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") void createSelfMessage(selfMsg, selfCaption); }}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                    <button className="bp-btn-ghost" onClick={() => setSelfMsg(null)}>Отмена</button>
                    <button className="bp-btn-primary" onClick={() => void createSelfMessage(selfMsg, selfCaption)}>
                      Добавить
                    </button>
                  </div>
                </div>
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

          {/* Фрагмент: ввод условия для ВЫБРАННОГО диапазона */}
          {pendingFrag && detail && (
            <>
              <div style={overlayDim} onClick={() => setPendingFrag(null)} />
              <div style={overlayCenter}>
                <div style={confirmCard}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head, marginBottom: 4 }}>
                    Фрагмент «{pendingFrag.kind}»
                  </div>
                  <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>
                    {pendingFrag.fromRow === pendingFrag.toRow
                      ? `Сообщение ${pendingFrag.fromRow + 1}`
                      : `Сообщения ${pendingFrag.fromRow + 1}–${pendingFrag.toRow + 1}`}
                    {" "}· условие (показывается у рамки)
                  </div>
                  <input
                    value={fragGuard}
                    onChange={(e) => setFragGuard(e.target.value)}
                    placeholder="напр. оплата прошла"
                    style={fragInput}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void createFragment(pendingFrag.kind, pendingFrag.fromRow, pendingFrag.toRow, fragGuard);
                    }}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                    <button className="bp-btn-ghost" onClick={() => setPendingFrag(null)}>Отмена</button>
                    <button
                      className="bp-btn-primary"
                      onClick={() => void createFragment(pendingFrag.kind, pendingFrag.fromRow, pendingFrag.toRow, fragGuard)}
                    >
                      Добавить
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Подтверждение удаления фрагмента (клик по его шапке) */}
          {delFrag && (
            <>
              <div style={overlayDim} onClick={() => setDelFrag(null)} />
              <div style={overlayCenter}>
                <div style={confirmCard}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head }}>Удалить фрагмент?</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                    <button className="bp-btn-ghost" onClick={() => setDelFrag(null)}>Отмена</button>
                    <button className="bp-btn-primary" style={{ background: "#dc2626", borderColor: "#dc2626" }} onClick={() => void removeFragment(delFrag)}>
                      Удалить
                    </button>
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

const fragHintBar: CSSProperties = {
  position: "absolute",
  top: 10,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 7,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "7px 8px 7px 14px",
  background: "#fffbeb",
  border: "1px solid #fcd9a8",
  borderRadius: 10,
  boxShadow: "0 6px 20px rgba(15,23,42,.12)",
  fontSize: 12.5,
  color: "#92591a",
  whiteSpace: "nowrap",
};
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
