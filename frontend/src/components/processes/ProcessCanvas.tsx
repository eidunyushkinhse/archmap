// Холст процесса для режима «Процессы» — тело редактора и просмотрщика, поднятое с
// модалки (ProcessEditorModal / ProcessViewerModal ретайрятся). Один компонент на обе
// роли: тумблер «Редактировать/Готово» (только архитектор) переключает inline-правку.
// Движок (SequenceDiagram), композитор и вся механика — переиспользованы как есть
// (drag-to-connect, хэндл «себе», покраска по статусу узла). Бэкенд/модель не трогаем.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { edgesApi, nodesApi } from "../../api/nodes";
import { processesApi } from "../../api/processes";
import type { BranchIn, FragmentKind, MessageCreate, NodeStatus, ProcessDetail, ProcessMessage, ProcessParticipant } from "../../types";
import { RedoIcon, UndoIcon } from "../../ui/icons";
import MessageComposer from "../MessageComposer";
import ParticipantDeleteConfirm from "./ParticipantDeleteConfirm";
import ParticipantPicker from "./ParticipantPicker";
import { C4Glyph, IcoBrokenLink, IcoClose, IcoEdit, IcoPlus } from "./icons";
import { SchemaViewSeg, ViewHint } from "./SchemaViewChrome";
import SequenceDiagram from "./SequenceDiagram";
import { deriveActivations, newBranchRow } from "./sequence/layout";
import { detailToSeq, orderedBranches } from "./sequence/fromDetail";
import { BPT, BROKEN } from "./tokens";
import { useProcessHistory } from "./useProcessHistory";
import { readSchemaView, writeSchemaView, type SchemaView } from "../schemaView";
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
  // Карточка ветви «иначе»: id фрагмента + номер ветви. index=null — заводим НОВУЮ
  // (границу ставим сами, см. saveBranch).
  const [branchEdit, setBranchEdit] = useState<{ fid: string; index: number | null } | null>(null);
  const [branchGuard, setBranchGuard] = useState("");
  // Привязка непривязанного участника: id участника, которому ищем узел.
  const [bindPart, setBindPart] = useState<string | null>(null);
  // Расхождение имён: узел выбран, но зовётся иначе, чем участник в диаграмме.
  // Спрашиваем до записи — иначе имя из диаграммы исчезло бы молча.
  const [bindConfirm, setBindConfirm] = useState<
    { participantId: string; nodeId: string; nodeName: string; partName: string } | null
  >(null);
  // Итог подхвата каналов — показываем строкой: молча подхватить и промолчать значит
  // скрыть, что часть шагов осталась сломанной.
  const [bindNote, setBindNote] = useState<string | null>(null);
  // Карточка шага: правка подписи + удаление. Клик по стрелке/подписи ведёт сюда —
  // раньше он открывал ТОЛЬКО «Удалить сообщение?», и задать подпись было нечем.
  const [msgEdit, setMsgEdit] = useState<string | null>(null);
  const [msgCaption, setMsgCaption] = useState("");
  const [delPart, setDelPart] = useState<ProcessParticipant | null>(null);
  const [delPartBusy, setDelPartBusy] = useState(false);
  const [delPartErr, setDelPartErr] = useState<string | null>(null);
  // Вид схемы — общий с C4-схемой ключ ЭТОГО проекта (в другом проекте свой).
  const [view, setView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { writeSchemaView(view); }, [view]);

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
  // Узел → участник в СВЕЖЕМ состоянии: нужен для восстановления сообщений после
  // undo (id участника при пересоздании меняется, node_id — нет). Непривязанных
  // участников тут нет: восстанавливать их шаги всё равно нечем.
  const freshPartByNode = useCallback(async () => {
    const fresh = await processesApi.get(id);
    const m: Record<string, string> = {};
    for (const p of fresh.participants) if (p.node_id) m[p.node_id] = p.id;
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
    // У непривязанного участника статуса нет — в бейдж вида он не попадает.
    if (detail) for (const p of detail.participants) if (p.status) c[p.status]++;
    return c;
  }, [detail]);
  const hasStatus = counts.planned + counts.deprecated > 0;
  // Сколько шагов кнопка «Восстановить связи» реально может починить: она ищет канал
  // ПОВИСШЕМУ шагу, поэтому считаем только их. Шаг, потерявший плечо (канал стал
  // асинхронным), тоже показан сломанным, но связь у него на месте — подхватывать
  // нечего, и попади он в счётчик, кнопка обещала бы починку, которой не умеет.
  // Самосообщения не попадают сами: у внутренней операции связи C4 не было.
  const danglingCount = useMemo(
    () => (detail ? detail.messages.filter((m) => m.invalid_reason === "edge_deleted").length : 0),
    [detail],
  );
  const nextOrder = useMemo(
    () => (detail ? detail.messages.reduce((mx, m) => Math.max(mx, m.order), -1) + 1 : 0),
    [detail],
  );
  // Участник по id и его узел: сообщения теперь ссылаются на УЧАСТНИКОВ.
  const partById = useMemo(() => {
    const m: Record<string, ProcessParticipant> = {};
    if (detail) for (const p of detail.participants) m[p.id] = p;
    return m;
  }, [detail]);
  const nodeOfPart = useCallback((pid: string) => partById[pid]?.node_id ?? null, [partById]);
  const delLinks = useMemo(() => {
    if (!detail || !delPart) return [];
    return detail.messages
      .filter((m) => m.from_participant_id === delPart.id || m.to_participant_id === delPart.id)
      .map((m) => {
        const outgoing = m.from_participant_id === delPart.id;
        const other = outgoing ? m.to_participant_id : m.from_participant_id;
        return {
          id: m.id,
          label: m.caption || m.technology || "сообщение",
          dir: (outgoing ? "к" : "от") as "к" | "от",
          other: partById[other]?.name ?? other,
        };
      });
  }, [detail, delPart, partById]);

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
  async function reorderParticipants(ids: string[]) {
    if (!detail) return;
    const prevIds = [...detail.participants].sort((a, b) => a.order - b.order).map((p) => p.id);
    const newIds = ids;
    if (newIds.length !== detail.participants.length) return; // страховка неполного порядка
    // Оптимистично: сразу пересобираем order в detail, чтобы диаграмма показала новый
    // порядок БЕЗ отката на старый (onRootUp синхронно сбрасывает reorder-состояние,
    // и без этого шапки мигнули бы на прежние места до прихода ответа). reload() после
    // API подтвердит порядок; ошибка — перечитает истинное состояние (БД не менялась).
    const orderById = new Map<string, number>(ids.map((pid, i) => [pid, i]));
    setDetail({
      ...detail,
      participants: detail.participants.map((p) => ({
        ...p,
        order: orderById.get(p.id) ?? p.order,
        // (order — number: Map строго типизирована ниже)
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
  // Перестановка ШАГОВ сценария. id сообщений стабильны (меняется только order),
  // поэтому undo/redo бьют по тем же id — как и у перестановки участников.
  // Границы фрагментов бэк намеренно не двигает: фрагмент — диапазон позиций.
  async function reorderMessages(ids: string[]) {
    if (!detail) return;
    const prevIds = [...detail.messages].sort((a, b) => a.order - b.order).map((m) => m.id);
    if (ids.length !== prevIds.length) return; // страховка неполного порядка
    // Оптимистично: сразу переписываем order в detail, иначе диаграмма мигнула бы
    // на прежний порядок между отпусканием и ответом API (onRootUp синхронно
    // сбрасывает состояние жеста).
    const orderById = new Map(ids.map((mid, i) => [mid, i]));
    setDetail({
      ...detail,
      messages: detail.messages.map((m) => ({ ...m, order: orderById.get(m.id) ?? m.order })),
    });
    try {
      await processesApi.reorderMessages(id, ids);
      hist.push({
        label: "Перестановка шагов",
        undo: async () => { await processesApi.reorderMessages(id, prevIds); },
        redo: async () => { await processesApi.reorderMessages(id, ids); },
      });
      reload();
    } catch (e: unknown) {
      reload(); // откат оптимистичного порядка к истинному (БД не изменилась)
      setError(e instanceof Error ? e.message : "Не удалось переставить шаги");
    }
  }

  // Снимок хранит УЗЛЫ, а не участников: при пересоздании участника его id меняется,
  // node_id — нет. Шаги непривязанных участников в снимок не попадают: восстановить
  // их всё равно нечем (узла, к которому цеплять, не существует).
  function captureMessages(nodeId: string): MessageSnapshot[] {
    return messagesThrough(nodeId).flatMap((m) => {
      const from = nodeOfPart(m.from_participant_id);
      const to = nodeOfPart(m.to_participant_id);
      if (!from || !to) return [];
      return [{ edge_id: m.edge_id, leg: m.leg, from_id: from, to_id: to, caption: m.caption, order: m.order }];
    });
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
    if (!detail) return [];
    return detail.messages.filter(
      (m) => nodeOfPart(m.from_participant_id) === nodeId || nodeOfPart(m.to_participant_id) === nodeId,
    );
  }
  // Узел выбран: если зовётся иначе — сперва показываем расхождение.
  async function requestBind(participantId: string, nodeId: string) {
    const partName = partById[participantId]?.name ?? "";
    try {
      const node = await nodesApi.get(nodeId);
      setBindPart(null);
      if (node.name !== partName) {
        setBindConfirm({ participantId, nodeId, nodeName: node.name, partName });
        return;
      }
    } catch {
      setBindPart(null); // узел не прочитался — привяжем и покажем ошибку бэка, если что
    }
    await bindParticipant(participantId, nodeId);
  }

  // Восстановление связей по всему процессу — после того как пользователь починил схему.
  // Кнопка появляется только когда чинить есть что: повисшие шаги видны на диаграмме.
  async function reattachChannels() {
    try {
      const res = await processesApi.reattach(id);
      setBindNote(
        res.attached === 0
          ? "Связей для шагов не нашлось — либо связи нет в схеме, либо подходящих несколько"
          : res.dangling === 0
            ? `Восстановлено связей: ${res.attached}`
            : `Восстановлено связей: ${res.attached}, осталось без связи: ${res.dangling}`,
      );
      if (res.attached_ids.length) {
        const ids = res.attached_ids;
        hist.push({
          label: "Восстановление связей",
          // Откат отцепляет РОВНО подхваченное: остальные шаги на своих каналах.
          undo: async () => { await processesApi.detachMessages(id, ids); },
          redo: async () => { await processesApi.reattach(id); },
        });
      }
      reload();
    } catch (e: unknown) {
      reload();
      setError(e instanceof Error ? e.message : "Не удалось подхватить каналы");
    }
  }

  async function bindParticipant(participantId: string, nodeId: string) {
    setBindPart(null);
    setBindConfirm(null);
    try {
      const res = await processesApi.bindParticipant(id, participantId, nodeId);
      setBindNote(
        res.attached === 0 && res.dangling === 0
          ? null
          : res.dangling === 0
            ? `Восстановлено связей: ${res.attached}`
            : `Восстановлено связей: ${res.attached}, осталось без связи: ${res.dangling}`,
      );
      hist.push({
        label: "Привязка участника",
        // Обратная операция — снятие привязки: id участника при этом не меняется,
        // поэтому откат бьёт точно по тому же участнику.
        undo: async () => { await processesApi.bindParticipant(id, participantId, null); },
        redo: async () => { await processesApi.bindParticipant(id, participantId, nodeId); },
      });
      reload();
    } catch (e: unknown) {
      reload();
      setError(e instanceof Error ? e.message : "Не удалось привязать участника к узлу");
    }
  }

  async function doRemoveParticipant(p: ProcessParticipant) {
    const { node_id, order } = p;
    if (!node_id) {
      // Непривязанного просто удаляем: undo пересоздал бы его через addParticipant,
      // а тому нужен узел. Восстановление таких — задача привязки, не истории.
      await processesApi.removeParticipant(id, p.id);
      return;
    }
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
    if (!p.node_id || messagesThrough(p.node_id).length === 0) {
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
  async function createSelfMessage(participantId: string, caption: string) {
    if (!detail) return;
    // Самосообщение — внутренняя операция участника: связи C4 у него нет, узел не
    // нужен вовсе. Поэтому адресуемся участником и работаем даже у непривязанного.
    const part = partById[participantId];
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
          // Участника могли пересоздать (undo его удаления) — тогда id сменился, а
          // node_id нет. У непривязанного узла нет, но и пересоздать его нечем:
          // держимся за его собственный id.
          const pid = part.node_id
            ? (await freshPartByNode())[part.node_id]
            : participantId;
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
  // Правка подписи шага. Подпись у шага всегда СВОЯ (вывод из канала снят), поэтому
  // пустое поле означает ровно «подписи нет», а не «взять метку связи».
  async function saveCaption(mid: string) {
    if (!detail) return;
    const m = detail.messages.find((x) => x.id === mid);
    if (!m) return;
    const next = msgCaption.trim() || null;
    setMsgEdit(null);
    if (next === m.caption) return; // ничего не меняли — не мусорим в истории
    const prev = m.caption;
    setDetail({
      ...detail,
      messages: detail.messages.map((x) => (x.id === mid ? { ...x, caption: next } : x)),
    });
    try {
      await processesApi.updateMessage(id, mid, { caption: next });
      hist.push({
        label: "Подпись шага",
        undo: async () => { await processesApi.updateMessage(id, mid, { caption: prev }); },
        redo: async () => { await processesApi.updateMessage(id, mid, { caption: next }); },
      });
      reload();
    } catch (e: unknown) {
      reload();
      setError(e instanceof Error ? e.message : "Не удалось изменить подпись шага");
    }
  }
  // Синхронность КАНАЛА под шагом. Живёт в карточке шага, а не в C4-модалке (решение
  // пользователя 2026-08-11): состав плеч — вопрос процесса, в схеме объекта этот
  // признак не нужен. Правит связь целиком, поэтому задевает все шаги на ней —
  // карточка про это говорит прямо.
  // ⚠️ Карточку тут НЕ закрываем: тумблер — контроль ВНУТРИ карточки, а не выход из
  // неё. Пока закрывали, набранная в поле подпись пропадала молча (её пишет только
  // «Сохранить»), а результат переключения было не увидеть — карточка исчезала вместе
  // с тумблером и предупреждением про плечи ответов (П3 челленджа 2026-08-16).
  async function setChannelSync(edgeId: string, next: boolean) {
    try {
      await edgesApi.update(edgeId, { is_synchronous: next });
      hist.push({
        label: next ? "Канал стал синхронным" : "Канал стал асинхронным",
        undo: async () => { await edgesApi.update(edgeId, { is_synchronous: !next }); },
        redo: async () => { await edgesApi.update(edgeId, { is_synchronous: next }); },
      });
      reload();
    } catch (e: unknown) {
      reload();
      setError(e instanceof Error ? e.message : "Не удалось изменить тип канала");
    }
  }
  async function removeMessage(mid: string) {
    const m = detail?.messages.find((x) => x.id === mid);
    try {
      await processesApi.removeMessage(id, mid);
      setMsgEdit(null);
      // Записываем в историю ТОЛЬКО восстановимое. Шаг без канала (связь удалили из
      // схемы) и шаг непривязанного участника воссоздать нечем: addMessage требует
      // edge_id у всего, кроме самосообщения. Прежде запись всё равно попадала в
      // историю, а её undo молча ничего не делал — кнопка обещала откат, которого нет.
      // ⚠️ Проверка обязана стоять ПОСЛЕ удаления, но НЕ прерывать функцию: до правки
      // ранний return уносил с собой reload(), и удалённый шаг оставался на экране —
      // выглядело как «шаг не удаляется вовсе».
      const fromNode = m && nodeOfPart(m.from_participant_id);
      const toNode = m && nodeOfPart(m.to_participant_id);
      const restorable = !!m && !!fromNode && !!toNode
        && (!!m.edge_id || m.from_participant_id === m.to_participant_id);
      if (m && restorable && fromNode && toNode) {
        const snap: MessageSnapshot = {
          edge_id: m.edge_id, leg: m.leg, from_id: fromNode, to_id: toNode, caption: m.caption, order: m.order,
        };
        let restoredId: string | null = null;
        hist.push({
          label: "Удаление сообщения",
          undo: async () => {
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
      kind, from_order: sorted[fromRow].order, to_order: sorted[toRow].order, guard: guard.trim() || null, branches: [],
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
  // Правка охвата фрагмента протягиванием грани. Диаграмма отдаёт индексы СТРОК —
  // переводим их в order сообщений (фрагмент хранит диапазон позиций, как и при
  // создании). Границы держит бэк: from_order ≤ to_order.
  async function resizeFragment(fid: string, fromRow: number, toRow: number) {
    if (!detail) return;
    const frag = detail.fragments.find((x) => x.id === fid);
    if (!frag) return;
    const sorted = [...detail.messages].sort((a, b) => a.order - b.order);
    if (fromRow < 0 || toRow >= sorted.length || fromRow > toRow) return;
    const next = { from_order: sorted[fromRow].order, to_order: sorted[toRow].order };
    const prev = { from_order: frag.from_order, to_order: frag.to_order };
    // Оптимистично: рамка остаётся на новом месте, не мигая обратно до ответа.
    setDetail({
      ...detail,
      fragments: detail.fragments.map((x) => (x.id === fid ? { ...x, ...next } : x)),
    });
    try {
      await processesApi.updateFragment(id, fid, next);
      hist.push({
        label: "Охват фрагмента",
        undo: async () => { await processesApi.updateFragment(id, fid, prev); },
        redo: async () => { await processesApi.updateFragment(id, fid, next); },
      });
      reload();
    } catch (e: unknown) {
      reload(); // откат оптимистичной рамки к истинной (БД не изменилась)
      setError(e instanceof Error ? e.message : "Не удалось изменить охват фрагмента");
    }
  }

  // Общая запись правки ветвей: и границы, и условия, и снятие. Ветви правятся
  // ЦЕЛИКОМ одним списком — тогда откат возвращает набор разом (иначе undo половинчатый).
  async function patchBranches(fid: string, branches: BranchIn[]) {
    if (!detail) return;
    const frag = detail.fragments.find((x) => x.id === fid);
    if (!frag) return;
    // Единственная точка записи — здесь же держим порядок: бэк требует строго
    // возрастающих границ, а новая ветвь не обязана быть последней.
    const next = orderedBranches(branches);
    const prev = frag.branches.map((b) => ({ start_order: b.start_order, guard: b.guard }));
    setDetail({
      ...detail,
      fragments: detail.fragments.map((x) =>
        x.id === fid ? { ...x, branches: next.map((b) => ({ start_order: b.start_order, guard: b.guard ?? null })) } : x,
      ),
    });
    try {
      await processesApi.updateFragment(id, fid, { branches: next });
      hist.push({
        label: "Ветки «иначе»",
        undo: async () => { await processesApi.updateFragment(id, fid, { branches: prev }); },
        redo: async () => { await processesApi.updateFragment(id, fid, { branches: next }); },
      });
      reload();
    } catch (e: unknown) {
      reload();
      setError(e instanceof Error ? e.message : "Не удалось изменить ветки «иначе»");
    }
  }

  // Перенос границы ветви: строка → order (как и у охвата). Остальные ветви на месте.
  async function moveBranch(fid: string, index: number, row: number) {
    if (!detail) return;
    const frag = detail.fragments.find((x) => x.id === fid);
    if (!frag || index < 0 || index >= frag.branches.length) return;
    const sorted = [...detail.messages].sort((a, b) => a.order - b.order);
    if (row < 0 || row >= sorted.length) return;
    await patchBranches(
      fid,
      frag.branches.map((b, k) => (k === index ? { ...b, start_order: sorted[row].order } : b)),
    );
  }

  // Сохранение карточки: заводим НОВУЮ ветвь либо правим условие существующей.
  async function saveBranch() {
    if (!branchEdit || !detail) return;
    const frag = detail.fragments.find((x) => x.id === branchEdit.fid);
    if (!frag) return;
    const sorted = [...detail.messages].sort((a, b) => a.order - b.order);
    // Строка = число сообщений с меньшим order — ровно как в проекции диаграммы
    // (fromDetail). findIndex здесь врал бы: order удалённого сообщения дал бы −1.
    const rowOf = (order: number) => sorted.filter((m) => m.order < order).length;
    const guard = branchGuard.trim() || null;
    if (branchEdit.index != null) {
      setBranchEdit(null);
      await patchBranches(
        branchEdit.fid,
        frag.branches.map((b, k) => (k === branchEdit.index ? { ...b, guard } : b)),
      );
      return;
    }
    const row = newBranchRow(
      rowOf(frag.from_order),
      rowOf(frag.to_order),
      frag.branches.map((b) => rowOf(b.start_order)),
    );
    if (row == null || row >= sorted.length) return;
    setBranchEdit(null);
    await patchBranches(branchEdit.fid, [
      ...frag.branches,
      { start_order: sorted[row].order, guard },
    ]);
  }

  async function removeFragment(fid: string) {
    const f = detail?.fragments.find((x) => x.id === fid);
    try {
      await processesApi.removeFragment(id, fid);
      setDelFrag(null);
      if (f) {
        const payload = {
          kind: f.kind, from_order: f.from_order, to_order: f.to_order, guard: f.guard,
          // Ветви восстанавливаем вместе с фрагментом: без них undo вернул бы alt
          // без ветвлений, и это выглядело бы как потеря работы.
          branches: f.branches.map((b) => ({ start_order: b.start_order, guard: b.guard })),
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
        {editing && danglingCount > 0 && (
          <>
            <button
              className="bp-btn-ghost"
              style={{ height: 26, padding: "0 10px", color: BROKEN.ink, borderColor: BROKEN.border }}
              title="Найти связи схемы для шагов без связи (например, после правки схемы)"
              onClick={() => void reattachChannels()}
            >
              Восстановить связи ({danglingCount})
            </button>
            <span style={divider} />
          </>
        )}
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
        {/* Итог подхвата каналов: гасится кликом — это не ошибка, а сводка. */}
        {bindNote && (
          <div
            onClick={() => setBindNote(null)}
            style={{ padding: "8px 14px 0", color: BROKEN.ink, fontSize: 12, cursor: "pointer" }}
          >
            {bindNote}
          </div>
        )}
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
              onResizeFragment={editing ? (fid, from, to) => void resizeFragment(fid, from, to) : undefined}
              onMoveBranch={editing ? (fid, index, row) => void moveBranch(fid, index, row) : undefined}
              onEditBranch={editing ? (fid, index) => {
                const frag = detail.fragments.find((x) => x.id === fid);
                setBranchGuard(index != null ? (frag?.branches[index]?.guard ?? "") : "");
                setBranchEdit({ fid, index });
              } : undefined}
              onConnect={editing ? (fromPid, toPid) => {
                // Граница слоёв: диаграмма говорит УЧАСТНИКАМИ, композитор и
                // направления — узлами C4. Перевод делаем здесь, в одном месте.
                const from = nodeOfPart(fromPid);
                const to = nodeOfPart(toPid);
                // У непривязанного участника узла нет, значит нет и каналов — открывать
                // композитор не на чем.
                if (from && to) setComposer({ from, to });
              } : undefined}
              canConnect={editing ? (fromPid, toPid) => {
                const from = nodeOfPart(fromPid);
                const to = nodeOfPart(toPid);
                return !!from && !!to && directions.has(`${from}>${to}`);
              } : undefined}
              onSelfConnect={editing ? (pid) => { setSelfMsg(pid); setSelfCaption(""); } : undefined}
              onMessageClick={editing ? (mid) => {
                setMsgCaption(detail?.messages.find((m) => m.id === mid)?.caption ?? "");
                setMsgEdit(mid);
              } : undefined}
              onBindParticipant={editing ? (pid) => setBindPart(pid) : undefined}
              onDeleteParticipant={editing ? (pid) => {
                const p = partById[pid];
                if (p) requestRemoveParticipant(p);
              } : undefined}
              onReorderParticipants={editing ? (nodeIds) => void reorderParticipants(nodeIds) : undefined}
              onReorderMessages={editing ? (ids) => void reorderMessages(ids) : undefined}
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
                  Рефлексивное сообщение · {partById[selfMsg]?.name ?? selfMsg}
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

        {/* Карточка шага: подпись + удаление (устройство то же, что у ветви «иначе») */}
        {msgEdit && detail && (
          <>
            <div style={overlayDim} onClick={() => setMsgEdit(null)} />
            <div style={overlayCenter}>
              <div style={confirmCard}>
                <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head, marginBottom: 4 }}>
                  Шаг сценария
                </div>
                <input
                  className="bp-input"
                  value={msgCaption}
                  onChange={(e) => setMsgCaption(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void saveCaption(msgEdit); }}
                  placeholder="что происходит на этом шаге"
                  data-card="caption"
                  maxLength={256}
                  autoFocus
                />
                {/* Тип КАНАЛА под шагом. Правит связь целиком, поэтому говорим об этом
                    прямо и предупреждаем, если уход в асинхронный сломает ответы:
                    у асинхронного канала плеча «ответ» нет (AL28). */}
                {(() => {
                  const m = detail.messages.find((x) => x.id === msgEdit);
                  const edgeId = m?.edge_id;
                  if (!edgeId || m.edge_synchronous == null) return null;
                  const sync = m.edge_synchronous;
                  const ответов = detail.messages.filter(
                    (x) => x.edge_id === m.edge_id && x.leg === "return",
                  ).length;
                  return (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 6 }}>
                        Канал в схеме — правка задевает все шаги на нём
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {([true, false] as const).map((v) => (
                          <button
                            key={String(v)}
                            className={sync === v ? "bp-btn-primary" : "bp-btn-ghost"}
                            onClick={() => { if (sync !== v) void setChannelSync(edgeId, v); }}
                          >
                            {v ? "Синхронный" : "Асинхронный"}
                          </button>
                        ))}
                      </div>
                      {sync && ответов > 0 && (
                        <div style={{ fontSize: 11.5, color: BROKEN.ink, marginTop: 6 }}>
                          У асинхронного канала нет плеча «ответ» —
                          {ответов === 1 ? " один шаг-ответ" : ` шагов-ответов: ${ответов}`} сломается.
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                  <button
                    className="bp-btn-ghost"
                    style={{ marginRight: "auto", color: "#dc2626" }}
                    onClick={() => void removeMessage(msgEdit)}
                  >
                    Удалить
                  </button>
                  <button className="bp-btn-ghost" onClick={() => setMsgEdit(null)}>Отмена</button>
                  <button className="bp-btn-primary" onClick={() => void saveCaption(msgEdit)}>
                    Сохранить
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

        {/* Ветвь «иначе»: условие + снятие ветви */}
        {branchEdit && detail && (
          <>
            <div style={overlayDim} onClick={() => setBranchEdit(null)} />
            <div style={overlayCenter}>
              <div style={confirmCard}>
                <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head, marginBottom: 4 }}>
                  {branchEdit.index == null ? "Добавить ветку «иначе»" : "Ветка «иначе»"}
                </div>
                <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>
                  {branchEdit.index == null
                    ? "Граница встанет в свободном месте охвата — потом её можно перетащить."
                    : `Ветка ${branchEdit.index + 2} у этого alt`}
                </div>
                <input
                  className="bp-input"
                  value={branchGuard}
                  onChange={(e) => setBranchGuard(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void saveBranch(); }}
                  placeholder="условие ветки, напр. «отказ»"
                  autoFocus
                />
                <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                  {branchEdit.index != null && (
                    <button
                      className="bp-btn-ghost"
                      style={{ marginRight: "auto", color: "#dc2626" }}
                      onClick={() => {
                        const { fid, index } = branchEdit;
                        const frag = detail.fragments.find((x) => x.id === fid);
                        setBranchEdit(null);
                        if (frag) void patchBranches(fid, frag.branches.filter((_, k) => k !== index));
                      }}
                    >
                      Убрать ветку
                    </button>
                  )}
                  <button className="bp-btn-ghost" onClick={() => setBranchEdit(null)}>Отмена</button>
                  <button className="bp-btn-primary" onClick={() => void saveBranch()}>
                    {branchEdit.index == null ? "Добавить" : "Сохранить"}
                  </button>
                </div>
              </div>
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
        {/* Расхождение имён: спрашиваем ДО записи, иначе имя из диаграммы пропало бы
            молча. После привязки действует имя узла — схема источник истины. */}
        {bindConfirm && (
          <>
            <div style={overlayDim} onClick={() => setBindConfirm(null)} />
            <div style={overlayCenter}>
              <div style={confirmCard}>
                <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head, marginBottom: 6 }}>
                  Имена расходятся
                </div>
                <div style={{ fontSize: 12.5, color: BPT.mut, marginBottom: 14, lineHeight: 1.5 }}>
                  В диаграмме участник назывался «{bindConfirm.partName}», а узел схемы —
                  «{bindConfirm.nodeName}». После привязки будет действовать имя узла:
                  схема — источник истины.
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button className="bp-btn-ghost" onClick={() => setBindConfirm(null)}>Отмена</button>
                  <button
                    className="bp-btn-primary"
                    onClick={() => void bindParticipant(bindConfirm.participantId, bindConfirm.nodeId)}
                  >
                    Привязать
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Привязка непривязанного участника: тот же пикер дерева, что и у добавления —
            выбранный узел не добавляет линию жизни, а достаётся существующей. */}
        {bindPart && detail && (
          <>
            <div style={overlayDim} onClick={() => setBindPart(null)} />
            <div style={overlayCenter}>
              <div style={{ ...confirmCard, width: 380, textAlign: "left" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: BPT.head }}>
                    Привязать «{partById[bindPart]?.name ?? "участника"}»
                  </div>
                  <button className="bp-iconbtn" style={{ width: 26, height: 26 }} onClick={() => setBindPart(null)}>
                    <IcoClose s={14} />
                  </button>
                </div>
                <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>
                  Участник пришёл из импорта или потерял узел при удалении. Выберите, какому
                  объекту схемы он соответствует.
                </div>
                <ParticipantPicker
                  added={new Set(detail.participants.flatMap((p) => (p.node_id ? [p.node_id] : [])))}
                  onAdd={(ids) => { if (ids[0]) void requestBind(bindPart, ids[0]); }}
                />
              </div>
            </div>
          </>
        )}

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
                          <span style={{ color: p.node_id ? (p.is_external ? BPT.mut : BPT.sec) : BROKEN.ink, display: "inline-flex" }}>
                            {p.shape ? <C4Glyph shape={p.shape} s={15} /> : <IcoBrokenLink s={13} />}
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
                  added={new Set(detail.participants.flatMap((p) => (p.node_id ? [p.node_id] : [])))}
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
