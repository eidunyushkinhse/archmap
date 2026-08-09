// Холст процесса для режима «Процессы» — тело редактора и просмотрщика, поднятое с
// модалки (ProcessEditorModal / ProcessViewerModal ретайрятся). Один компонент на обе
// роли: тумблер «Редактировать/Готово» (только архитектор) переключает inline-правку.
// Движок (SequenceDiagram), композитор и вся механика — переиспользованы как есть
// (drag-to-connect, хэндл «себе», покраска по статусу узла). Бэкенд/модель не трогаем.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { processesApi } from "../../api/processes";
import type { FragmentKind, MessageCreate, NodeStatus, ProcessDetail, ProcessMessage, ProcessParticipant } from "../../types";
import { RedoIcon, UndoIcon } from "../../ui/icons";
import MessageComposer from "../MessageComposer";
import ParticipantDeleteConfirm from "./ParticipantDeleteConfirm";
import ParticipantPicker from "./ParticipantPicker";
import { C4Glyph, IcoClose, IcoEdit, IcoPlus } from "./icons";
import { SchemaViewSeg, ViewHint } from "./SchemaViewChrome";
import SequenceDiagram from "./SequenceDiagram";
import { deriveActivations } from "./sequence/layout";
import { detailToSeq } from "./sequence/fromDetail";
import { BPT } from "./tokens";
import { useProcessHistory } from "./useProcessHistory";
import { readSchemaView, SCHEMA_VIEW_KEY, type SchemaView } from "../schemaView";
import "./processes.css";

interface Props {
  id: string;
  isArchitect: boolean;
  editing: boolean;
  onToggleEditing: (v: boolean) => void;
  // Дёргается после успешной мутации (число сообщений/статусы могли смениться) —
  // воркспейс обновляет список в рейле.
  onChanged: () => void;
}

const FRAGMENTS: FragmentKind[] = ["alt", "opt", "loop", "par"];

// Снимок сообщения для восстановления при undo (как в прежнем редакторе).
interface MessageSnapshot {
  edge_id: string | null;
  leg: ProcessMessage["leg"];
  from_id: string;
  to_id: string;
  caption: string | null;
  order: number;
}

// Глиф «галочка» для тумблера «Готово» (в icons.tsx чека нет).
function IcoCheck({ s = 15 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12 L10 17 L19 7" />
    </svg>
  );
}

export default function ProcessCanvas({ id, isArchitect, editing, onToggleEditing, onChanged }: Props) {
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Пара для композитора задаётся drag-to-connect на схеме (node_id источника/цели).
  const [composer, setComposer] = useState<{ from: string; to: string } | null>(null);
  // Куда можно завести сообщение — ключи «откуда>куда». Ответ БЭКА: проекция
  // концов связи через предков живёт там, и вторая реализация на клиенте
  // разошлась бы с валидатором. Обновляем, когда картина могла измениться:
  // вход в правку, закрытие композитора (там же переключают тип канала),
  // перезагрузка процесса.
  const [directions, setDirections] = useState<Set<string>>(new Set());
  // Самосообщение (внутренняя операция): node_id участника, на котором его создаём.
  const [selfMsg, setSelfMsg] = useState<string | null>(null);
  const [selfCaption, setSelfCaption] = useState("");
  const [partPanel, setPartPanel] = useState(false);
  // Режим выбора диапазона под фрагмент: выбран тип, ждём протягивания по сообщениям.
  const [fragSelect, setFragSelect] = useState<FragmentKind | null>(null);
  // Диапазон выбран (индексы строк), ждём ввода условия перед созданием.
  const [pendingFrag, setPendingFrag] = useState<{ kind: FragmentKind; fromRow: number; toRow: number } | null>(null);
  const [fragGuard, setFragGuard] = useState("");
  const [delFrag, setDelFrag] = useState<string | null>(null);
  const [delMsg, setDelMsg] = useState<string | null>(null);
  const [delPart, setDelPart] = useState<ProcessParticipant | null>(null);
  const [delPartBusy, setDelPartBusy] = useState(false);
  const [delPartErr, setDelPartErr] = useState<string | null>(null);
  // Вид схемы — общая привычка пользователя (тот же ключ, что у C4-схемы).
  const [view, setView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { localStorage.setItem(SCHEMA_VIEW_KEY, view); }, [view]);

  const reload = useCallback(() => {
    processesApi
      .get(id)
      .then((d) => { setDetail(d); onChanged(); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Не удалось загрузить процесс"));
  }, [id, onChanged]);

  // Первичная загрузка. Смену процесса воркспейс делает через key-remount (свежее
  // состояние оверлеев/истории), поэтому id за время жизни компонента не меняется —
  // [id] здесь эквивалентно «только маунт». Без синхронного setState в эффекте:
  // setDetail только в .then; начальный fetch без onChanged (изменений ещё нет).
  useEffect(() => {
    processesApi
      .get(id)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Не удалось загрузить процесс"));
  }, [id]);

  // Undo/Redo: каждая мутация регистрирует обратимую команду (компенсирующий вызов API).
  const hist = useProcessHistory(reload);
  const freshPartByNode = useCallback(async () => {
    const fresh = await processesApi.get(id);
    const m: Record<string, string> = {};
    for (const p of fresh.participants) m[p.node_id] = p.id;
    return m;
  }, [id]);
  // Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) — только в режиме правки. Не перехватываем в полях.
  useEffect(() => {
    if (!editing) return;
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
  }, [hist, editing]);

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
  const nameByNode = useMemo(() => {
    const m: Record<string, string> = {};
    if (detail) for (const p of detail.participants) m[p.node_id] = p.name;
    return m;
  }, [detail]);
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

  async function addParticipant(nodeId: string, order: number) {
    let pid = (await processesApi.addParticipant(id, { node_id: nodeId, order })).id;
    hist.push({
      label: "Добавление участника",
      undo: () => processesApi.removeParticipant(id, pid),
      redo: async () => {
        const r = await processesApi.addParticipant(id, { node_id: nodeId, order });
        pid = r.id;
      },
    });
  }
  async function addParticipants(nodeIds: string[]) {
    if (!detail) return;
    let order = detail.participants.length;
    try {
      for (const nid of nodeIds) {
        await addParticipant(nid, order);
        order++;
      }
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось добавить участника");
    }
  }
  // Перестановка участников (живой reorder в SequenceDiagram): новый порядок node_id
  // маппим на participant.id и персистим существующим reorder-эндпоинтом. id участников
  // стабильны (reorder меняет только поле order), поэтому undo/redo бьют по тем же id.
  async function reorderParticipants(nodeIds: string[]) {
    if (!detail) return;
    const prevIds = [...detail.participants].sort((a, b) => a.order - b.order).map((p) => p.id);
    const idByNode = new Map(detail.participants.map((p) => [p.node_id, p.id]));
    const newIds = nodeIds.flatMap((nid) => {
      const pid = idByNode.get(nid);
      return pid ? [pid] : [];
    });
    if (newIds.length !== detail.participants.length) return; // страховка неполного порядка
    // Оптимистично: сразу пересобираем order в detail, чтобы диаграмма показала новый
    // порядок БЕЗ отката на старый (onRootUp синхронно сбрасывает reorder-состояние,
    // и без этого шапки мигнули бы на прежние места до прихода ответа). reload() после
    // API подтвердит порядок; ошибка — перечитает истинное состояние (БД не менялась).
    const orderByNode = new Map(nodeIds.map((nid, i) => [nid, i]));
    setDetail({
      ...detail,
      participants: detail.participants.map((p) => ({
        ...p,
        order: orderByNode.get(p.node_id) ?? p.order,
      })),
    });
    try {
      await processesApi.reorderParticipants(id, newIds);
      hist.push({
        label: "Перестановка участников",
        undo: async () => { await processesApi.reorderParticipants(id, prevIds); },
        redo: async () => { await processesApi.reorderParticipants(id, newIds); },
      });
      reload();
    } catch (e: unknown) {
      reload(); // откат оптимистичного порядка к истинному (БД не изменилась)
      setError(e instanceof Error ? e.message : "Не удалось переставить участников");
    }
  }
  function captureMessages(nodeId: string): MessageSnapshot[] {
    return messagesThrough(nodeId).map((m) => ({
      edge_id: m.edge_id, leg: m.leg, from_id: m.from_id, to_id: m.to_id, caption: m.caption, order: m.order,
    }));
  }
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
        edge_id: m.edge_id, leg: m.leg, from_participant_id: fromP, to_participant_id: toP, caption: m.caption, order: m.order,
      });
    }
  }
  function messagesThrough(nodeId: string) {
    return detail ? detail.messages.filter((m) => m.from_id === nodeId || m.to_id === nodeId) : [];
  }
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
  // Перечитать карту направлений. Вне режима правки индикация не нужна — не ходим.
  const reloadDirections = useCallback(() => {
    if (!editing) return;
    processesApi
      .directions(id)
      .then((rows) => setDirections(new Set(rows.map((r) => `${r.from_id}>${r.to_id}`))))
      .catch(() => setDirections(new Set()));
  }, [editing, id]);

  useEffect(() => { reloadDirections(); }, [reloadDirections, detail]);

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
      setError(e instanceof Error ? e.message : "Не удалось добавить рефлексивное сообщение");
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
            if (!snap.edge_id && !isSelf) return;
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
  async function createFragment(kind: FragmentKind, fromRow: number, toRow: number, guard: string) {
    if (!detail) return;
    const sorted = [...detail.messages].sort((a, b) => a.order - b.order);
    if (fromRow < 0 || toRow >= sorted.length || fromRow > toRow) return;
    const payload = {
      kind, from_order: sorted[fromRow].order, to_order: sorted[toRow].order, guard: guard.trim() || null, else_guard: null, else_order: null,
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

  // ── Тулбар над диаграммой ─────────────────────────────────────────
  const toolbar = (
    <div style={toolbarRow} className="bp">
      <b style={{ fontSize: 15, color: BPT.head }}>{detail?.name ?? "Процесс"}</b>
      <span style={scopeChip}>область: {detail?.scope_name ?? "Вся схема"}</span>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        {editing && (
          <>
            <span style={{ fontSize: 11, color: BPT.mut }}>Фрагмент:</span>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
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
            </div>
            <span style={divider} />
            <button className="bp-addpart" onClick={() => setPartPanel(true)}>
              <IcoPlus s={14} />
              <span>Участник</span>
            </button>
            <span style={divider} />
            <div style={{ display: "inline-flex", gap: 4 }}>
              <button className="bp-iconbtn" onClick={hist.undo} disabled={!hist.canUndo || hist.busy} title="Отменить · Ctrl+Z" aria-label="Отменить">
                <UndoIcon size={16} />
              </button>
              <button className="bp-iconbtn" onClick={hist.redo} disabled={!hist.canRedo || hist.busy} title="Вернуть · Ctrl+Shift+Z" aria-label="Вернуть">
                <RedoIcon size={16} />
              </button>
            </div>
            <span style={{ fontSize: 12, color: "#0e9f6e", display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: "#0e9f6e" }} />
              сохранено
            </span>
          </>
        )}
        {hasStatus && <SchemaViewSeg view={view} onChange={setView} />}
        {isArchitect && (
          <button
            className="bp-btn-ghost"
            style={editing ? { background: BPT.wash, borderColor: "#bfdbfe", color: BPT.accent } : undefined}
            onClick={() => onToggleEditing(!editing)}
          >
            {editing ? <IcoCheck s={15} /> : <IcoEdit s={14} />}
            <span style={{ marginLeft: 6 }}>{editing ? "Готово" : "Редактировать"}</span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div style={canvasShell} className="bp">
      {toolbar}
      {hasStatus && <ViewHint view={view} />}
      <div className="bp-canvas" style={{ flex: 1, overflow: "auto", position: "relative" }}>
        {error && <div style={{ padding: "8px 14px 0", color: "#dc2626", fontSize: 12 }}>{error}</div>}
        {!detail || !seq ? (
          <div style={{ padding: 24, color: BPT.mut, fontSize: 14 }}>Загрузка…</div>
        ) : seq.participants.length === 0 ? (
          <div style={{ padding: 24, color: BPT.mut, fontSize: 14 }}>
            {editing
              ? "Добавьте участников (узлы схемы) кнопкой «Участник», затем сообщения между ними."
              : "В процессе пока нет участников и сообщений."}
          </div>
        ) : (
          <div style={{ padding: "8px 12px 18px", width: "max-content" }}>
            <SequenceDiagram
              participants={seq.participants}
              messages={seq.messages}
              activations={activations}
              fragments={seq.fragments}
              view={view}
              ghost={editing}
              selectMode={editing ? fragSelect : null}
              onSelectRange={editing ? (from, to) => {
                setFragSelect((kind) => {
                  if (kind) { setPendingFrag({ kind, fromRow: from, toRow: to }); setFragGuard(""); }
                  return null;
                });
              } : undefined}
              onFragmentClick={editing ? (fid) => setDelFrag(fid) : undefined}
              onConnect={editing ? (from, to) => setComposer({ from, to }) : undefined}
              canConnect={editing ? (from, to) => directions.has(`${from}>${to}`) : undefined}
              onSelfConnect={editing ? (nodeId) => { setSelfMsg(nodeId); setSelfCaption(""); } : undefined}
              onMessageClick={editing ? (mid) => setDelMsg(mid) : undefined}
              onDeleteParticipant={editing ? (nodeId) => {
                const p = detail.participants.find((pp) => pp.node_id === nodeId);
                if (p) requestRemoveParticipant(p);
              } : undefined}
              onReorderParticipants={editing ? (nodeIds) => void reorderParticipants(nodeIds) : undefined}
            />
          </div>
        )}

        {/* Подсказка режима выбора диапазона под фрагмент */}
        {editing && fragSelect && (
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

        {/* Композитор сообщения — оверлей по центру видимой области */}
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
                onClose={() => { setComposer(null); reloadDirections(); }}
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
                  Рефлексивное сообщение · {nameByNode[selfMsg] ?? selfMsg}
                </div>
                <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>
                  Действие участника над самим собой (без связи в C4) — внутренняя операция.
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
              <div style={{ ...confirmCard, width: 380, textAlign: "left" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: BPT.head }}>Участники</div>
                  <button className="bp-iconbtn" style={{ width: 26, height: 26 }} onClick={() => setPartPanel(false)}>
                    <IcoClose s={14} />
                  </button>
                </div>
                {detail.participants.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10, maxHeight: 140, overflow: "auto" }}>
                    {[...detail.participants]
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
                      ))}
                  </div>
                )}
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: BPT.mut, marginBottom: 6 }}>
                  Добавить из дерева схемы
                </div>
                <ParticipantPicker
                  added={new Set(detail.participants.map((p) => p.node_id))}
                  onAdd={(ids) => void addParticipants(ids)}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const canvasShell: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
const toolbarRow: CSSProperties = {
  height: 50,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0 18px",
  borderBottom: "1px solid " + BPT.line,
  background: "#fff",
};
const scopeChip: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: BPT.micro,
  background: "#f1f5f9",
  borderRadius: 6,
  padding: "3px 9px",
};
const divider: CSSProperties = { width: 1, height: 22, background: BPT.line, margin: "0 3px" };
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
const overlayDim: CSSProperties = { position: "fixed", inset: 0, background: "rgba(15,23,42,.06)", zIndex: 50 };
const overlayCenter: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  zIndex: 51,
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
