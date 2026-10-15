// Холст процесса для режима «Процессы» — тело редактора и просмотрщика, поднятое с
// модалки (ProcessEditorModal / ProcessViewerModal ретайрятся). Один компонент на обе
// роли: тумблер «Редактировать/Готово» (только архитектор) переключает inline-правку.
// Движок (SequenceDiagram), композитор и вся механика — переиспользованы как есть
// (drag-to-connect, хэндл «себе», покраска по статусу узла). Бэкенд/модель не трогаем.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { nodesApi } from "../../api/nodes";
import { processesApi } from "../../api/processes";
import type { FragmentKind, NodeStatus, ProcessParticipant } from "../../types";
import MessageComposer from "../MessageComposer";
import DocOverlay from "../inspector/DocOverlay";
import { stepDoc } from "./stepDoc";
import MessageCard from "./MessageCard";
import ParticipantDeleteConfirm from "./ParticipantDeleteConfirm";
import ParticipantPicker from "./ParticipantPicker";
import { C4Glyph, IcoBrokenLink, IcoClose } from "./icons";
import { ViewHint } from "./SchemaViewChrome";
import ProcessToolbar from "./ProcessToolbar";
import SequenceDiagram from "./SequenceDiagram";
import { deriveActivations } from "./sequence/layout";
import { detailToSeq } from "./sequence/fromDetail";
import { BPT, BROKEN } from "./tokens";
import { useProcessDetail } from "./useProcessDetail";
import type { ProcessEditCtx } from "./editCtx";
import { fragmentEdits } from "./fragmentEdits";
import { messageEdits } from "./messageEdits";
import { addFromSnap, freshPartByNode, type MessageSnapshot } from "./stepSnapshot";
import { useProcessHistory } from "./useProcessHistory";
import { useOverlayStack, type Overlay, type OverlayKind } from "./useOverlayStack";
import { readSchemaView, writeSchemaView, type SchemaView } from "../schemaView";
import "./processes.css";
import { noAutofill } from "../../ui/noAutofill";

interface Props {
  id: string;
  isArchitect: boolean;
  editing: boolean;
  onToggleEditing: (v: boolean) => void;
  // Дёргается после успешной мутации (число сообщений/статусы могли смениться) —
  // воркспейс обновляет список в рейле.
  onChanged: () => void;
  // Переход на страницу объекта с линии жизни участника (id — УЗЛА). Зеркало
  // обратного перехода со страницы объекта в процесс.
  onOpenNode?: (nodeId: string) => void;
  // Счётчик чужих правок (Д9): поллинг воркспейса заметил рост process_rev —
  // канвас перечитывает процесс. Растёт только на ЧУЖИЕ изменения.
  syncRev?: number;
}

export default function ProcessCanvas({ id, isArchitect, editing, onToggleEditing, onChanged, onOpenNode, syncRev }: Props) {
  const proc = useProcessDetail(id, onChanged, syncRev);
  const {
    detail, error, reload, setOptimistic, runMutation,
    msgById, fragById, partById, nodeOfPart, nextOrder,
  } = proc;
  // Куда можно завести сообщение — ключи «откуда>куда». Ответ БЭКА: проекция
  // концов связи через предков живёт там, и вторая реализация на клиенте
  // разошлась бы с валидатором. Обновляем, когда картина могла измениться:
  // вход в правку, закрытие композитора (там же переключают тип канала),
  // перезагрузка процесса.
  const [directions, setDirections] = useState<Set<string>>(new Set());
  // Режим выбора диапазона под фрагмент: выбран тип, ждём протягивания по сообщениям.
  const [fragSelect, setFragSelect] = useState<FragmentKind | null>(null);
  // Итог подхвата каналов — показываем строкой: молча подхватить и промолчать значит
  // скрыть, что часть шагов осталась сломанной.
  const [bindNote, setBindNote] = useState<string | null>(null);
  // Ревизия каталога схем карточки: правка в оверлее меняет имена/состав схем.
  const [docCatalogRev, setDocCatalogRev] = useState(0);
  // Окна поверх холста — одним стеком в порядке открытия (композитор, карточки шага,
  // ветки, фрагмента, подтверждения, привязка, панель участников, схема логики).
  // Провал из карточки шага в схему логики (У7) ложится выше карточки: закрывается
  // схема, карточка остаётся.
  const { stack: overlayStack, get: overlay, open: openOverlay, close: closeOverlay, update: updateOverlay } =
    useOverlayStack();
  // Вид схемы — общий с C4-схемой ключ ЭТОГО проекта (в другом проекте свой).
  const [view, setView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { writeSchemaView(view); }, [view]);

  // Undo/Redo: каждая мутация регистрирует обратимую команду (компенсирующий вызов API).
  const hist = useProcessHistory(reload);
  const editCtx: ProcessEditCtx = {
    id, proc, hist, overlays: { open: openOverlay, close: closeOverlay, update: updateOverlay },
  };
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
  const delPart = overlay("delPart")?.part ?? null;
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
    await runMutation(async () => {
      for (const nid of nodeIds) {
        await addParticipant(nid, order);
        order++;
      }
    }, "Не удалось добавить участника");
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
    setOptimistic({
      ...detail,
      participants: detail.participants.map((p) => ({
        ...p,
        order: orderById.get(p.id) ?? p.order,
        // (order — number: Map строго типизирована ниже)
      })),
    });
    await runMutation(async () => {
      await processesApi.reorderParticipants(id, newIds);
      hist.push({
        label: "Перестановка участников",
        undo: async () => { await processesApi.reorderParticipants(id, prevIds); },
        redo: async () => { await processesApi.reorderParticipants(id, newIds); },
      });
    }, "Не удалось переставить участников");
  }
  // Снимок хранит УЗЛЫ, а не участников: при пересоздании участника его id меняется,
  // node_id — нет. Шаги непривязанных участников в снимок не попадают: восстановить
  // их всё равно нечем (узла, к которому цеплять, не существует).
  function captureMessages(nodeId: string): MessageSnapshot[] {
    return messagesThrough(nodeId).flatMap((m) => {
      const from = nodeOfPart(m.from_participant_id);
      const to = nodeOfPart(m.to_participant_id);
      if (!from || !to) return [];
      return [{ edge_id: m.edge_id, leg: m.leg, from_id: from, to_id: to, caption: m.caption, order: m.order, doc_id: m.doc_id ?? null }];
    });
  }
  async function restoreMessages(snaps: MessageSnapshot[]) {
    if (snaps.length === 0) return;
    const partByNode = await freshPartByNode(id);
    for (const m of snaps) {
      const isSelf = m.from_id === m.to_id;
      if (!m.edge_id && !isSelf) continue;
      const fromP = partByNode[m.from_id];
      const toP = partByNode[m.to_id];
      if (!fromP || !toP) continue;
      await addFromSnap(id, m, fromP, toP);
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
      closeOverlay("bindPart");
      if (node.name !== partName) {
        // Расхождение имён: спрашиваем до записи — иначе имя из диаграммы исчезло бы молча.
        openOverlay({ kind: "bindConfirm", participantId, nodeId, nodeName: node.name, partName });
        return;
      }
    } catch {
      closeOverlay("bindPart"); // узел не прочитался — привяжем и покажем ошибку бэка, если что
    }
    await bindParticipant(participantId, nodeId);
  }

  // Восстановление связей по всему процессу — после того как пользователь починил схему.
  // Кнопка появляется только когда чинить есть что: повисшие шаги видны на диаграмме.
  async function reattachChannels() {
    await runMutation(async () => {
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
    }, "Не удалось подхватить каналы");
  }

  async function bindParticipant(participantId: string, nodeId: string) {
    closeOverlay("bindPart");
    closeOverlay("bindConfirm");
    await runMutation(async () => {
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
    }, "Не удалось привязать участника к узлу");
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
        const partByNode = await freshPartByNode(id);
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
    openOverlay({ kind: "delPart", part: p, busy: false, error: null });
  }
  async function removeParticipant(p: ProcessParticipant) {
    await runMutation(async () => {
      await doRemoveParticipant(p);
    }, "Не удалось удалить участника");
  }
  async function confirmRemoveParticipant(p: ProcessParticipant) {
    updateOverlay("delPart", (o) => ({ ...o, busy: true, error: null }));
    try {
      await doRemoveParticipant(p);
      closeOverlay("delPart");
      reload();
    } catch (e: unknown) {
      const text = e instanceof Error ? e.message : "Не удалось удалить участника";
      updateOverlay("delPart", (o) => ({ ...o, busy: false, error: text }));
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

  // Закрыть окно — ровно то же, что его «Отмена» и клик по подложке; второй логики
  // закрытия не заводим. Композитор при закрытии перечитывает направления: в нём
  // переключают тип канала.
  const dismiss = useCallback((kind: OverlayKind) => {
    closeOverlay(kind);
    if (kind === "composer") reloadDirections();
  }, [closeOverlay, reloadDirections]);

  // Escape закрывает верхний оверлей — как все окна проекта (ui/Modal.tsx получает это
  // даром от нативного <dialog>). Здесь оверлеи — обычные div: вложенные <dialog> в
  // проекте запрещены (их cancel всплывает и гасит соседа), поэтому клавишу ловим сами.
  // ⚠️ Ведём себя ровно как <dialog>: закрываем и когда фокус в поле ввода — иначе
  // Escape не работал бы почти нигде, у всех карточек поле autoFocus. Исключение одно
  // и то же, что у браузера: во время IME-композиции Escape отменяет НАБОР и до окна
  // не доходит. С Ctrl+Z не спорим: там обработчик требует Ctrl/Cmd, здесь — нет.
  // Схема логики сверху — сама ui/Modal, и Escape принадлежит ей: несохранённая правка
  // спрашивает, прежде чем закрыться (решение 2026-09-29). Перехват здесь гасил её
  // cancel (preventDefault) и закрывал окно молча. Идущее удаление участника Escape не
  // бросает — как и клик по подложке.
  const topOverlay = overlayStack.at(-1) ?? null;
  useEffect(() => {
    if (!topOverlay || topOverlay.kind === "doc") return;
    const { kind } = topOverlay;
    const held = topOverlay.kind === "delPart" && topOverlay.busy;
    function onEsc(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      if (!held) dismiss(kind);
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [topOverlay, dismiss]);

  const { handleMessageAdded, createSelfMessage, saveCaption, linkDoc, setChannelSync, removeMessage, reorderMessages } =
    messageEdits(editCtx);
  const { createFragment, resizeFragment, patchBranches, moveBranch, saveBranch, removeFragment } =
    fragmentEdits(editCtx);

  // Одно окно стека. Закрытие любого — dismiss/closeOverlay его вида: «Отмена», клик по
  // подложке и Escape делают одно и то же.
  function renderOverlay(o: Overlay): ReactNode {
    switch (o.kind) {
      // Композитор сообщения — по центру видимой области.
      case "composer":
        if (!detail) return null;
        return (
          <>
            <div style={overlayDim} onClick={() => dismiss("composer")} />
            <div style={overlayCenter}>
              <MessageComposer
                processId={id}
                participants={detail.participants}
                fromNode={o.from}
                toNode={o.to}
                defaultOrder={nextOrder}
                onClose={() => dismiss("composer")}
                onAdded={handleMessageAdded}
              />
            </div>
          </>
        );
      // Самосообщение: ввод подписи внутренней операции.
      case "self":
        if (!detail) return null;
        return (
          <PromptCard
            title={`Рефлексивное сообщение · ${partById[o.pid]?.name ?? o.pid}`}
            hint="Действие участника над самим собой (без связи в C4) — внутренняя операция."
            autofillKey="process-canvas-1"
            value={o.caption}
            onChange={(caption) => updateOverlay("self", (x) => ({ ...x, caption }))}
            placeholder="напр. валидация заказа"
            inputStyle={fragInput}
            submitLabel="Добавить"
            onSubmit={() => void createSelfMessage(o.pid, o.caption)}
            onCancel={() => closeOverlay("self")}
          />
        );
      // Карточка шага — свой модуль: у неё есть состояние (каталог схем, поиск), а холст
      // и без того велик.
      case "msg": {
        const m = msgById.get(o.mid);
        if (!detail || !m) return null;
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("msg")} />
            <div style={overlayCenter}>
              <MessageCard
                processId={id}
                msg={m}
                participants={detail.participants}
                returnLegs={detail.messages.filter(
                  (x) => x.edge_id === m.edge_id && x.leg === "return",
                ).length}
                caption={o.caption}
                onCaptionChange={(caption) => updateOverlay("msg", (x) => ({ ...x, caption }))}
                onSaveCaption={() => void saveCaption(o.mid, o.caption)}
                onSetChannelSync={(edgeId, next) => void setChannelSync(edgeId, next)}
                onLinkDoc={(docId) => void linkDoc(o.mid, docId)}
                onOpenDoc={(doc) => openOverlay({ kind: "doc", ...doc })}
                catalogRev={docCatalogRev}
                onRemove={() => void removeMessage(o.mid)}
                onClose={() => closeOverlay("msg")}
              />
            </div>
          </>
        );
      }
      // Провал в схему логики (У7/У8): окно открывается просмотром, правка — его же
      // «Изменить» (Вручную | Через ИИ-агента). Колбэки настоящие, не заглушки (ловушка
      // У8): onDocEvent и onApplied перечитывают процесс (имя схемы в шаге, SET NULL при
      // удалении) и каталог карточки. Спекой этот оверлей не занимается — колбэка записи
      // спеки нет.
      case "doc":
        return (
          <DocOverlay
            mode="flowchart"
            nodeId={o.nodeId}
            nodeName={o.nodeName}
            isArchitect={isArchitect}
            initialDocId={o.docId}
            onDocEvent={() => { setDocCatalogRev((r) => r + 1); reload(); }}
            onApplied={() => { setDocCatalogRev((r) => r + 1); reload(); }}
            onClose={() => closeOverlay("doc")}
          />
        );
      // Подтверждение удаления участника (со списком связей на схеме). Идущее удаление
      // клик по подложке не бросает.
      case "delPart":
        return (
          <>
            <div style={overlayDim} onClick={() => { if (!o.busy) closeOverlay("delPart"); }} />
            <div style={overlayCenter}>
              <ParticipantDeleteConfirm
                name={o.part.name}
                links={delLinks}
                deleting={o.busy}
                error={o.error}
                onConfirm={() => void confirmRemoveParticipant(o.part)}
                onCancel={() => closeOverlay("delPart")}
              />
            </div>
          </>
        );
      // Ветвь «иначе»: условие + снятие ветви.
      case "branch":
        if (!detail) return null;
        return (
          <PromptCard
            title={o.index == null ? "Добавить ветку «иначе»" : "Ветка «иначе»"}
            hint={o.index == null
              ? "Граница встанет в свободном месте охвата — потом её можно перетащить."
              : `Ветка ${o.index + 2} у этого alt`}
            autofillKey="process-canvas-2"
            value={o.guard}
            onChange={(guard) => updateOverlay("branch", (x) => ({ ...x, guard }))}
            placeholder="условие ветки, напр. «отказ»"
            inputClassName="bp-input"
            submitLabel={o.index == null ? "Добавить" : "Сохранить"}
            onSubmit={() => void saveBranch(o)}
            onCancel={() => closeOverlay("branch")}
            extra={o.index != null && (
              <button
                className="bp-btn-ghost"
                style={{ marginRight: "auto", color: "#dc2626" }}
                onClick={() => {
                  const frag = fragById.get(o.fid);
                  closeOverlay("branch");
                  if (frag) void patchBranches(o.fid, frag.branches.filter((_, k) => k !== o.index));
                }}
              >
                Убрать ветку
              </button>
            )}
          />
        );
      // Фрагмент: ввод условия для ВЫБРАННОГО диапазона.
      case "frag":
        if (!detail) return null;
        return (
          <PromptCard
            title={`Фрагмент «${o.frag}»`}
            hint={`${o.fromRow === o.toRow
              ? `Сообщение ${o.fromRow + 1}`
              : `Сообщения ${o.fromRow + 1}–${o.toRow + 1}`} · условие (показывается у рамки)`}
            autofillKey="process-canvas-3"
            value={o.guard}
            onChange={(guard) => updateOverlay("frag", (x) => ({ ...x, guard }))}
            placeholder="напр. оплата прошла"
            inputStyle={fragInput}
            submitLabel="Добавить"
            onSubmit={() => void createFragment(o.frag, o.fromRow, o.toRow, o.guard)}
            onCancel={() => closeOverlay("frag")}
          />
        );
      // Подтверждение удаления фрагмента (клик по его шапке).
      case "delFrag":
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("delFrag")} />
            <div style={overlayCenter}>
              <div style={confirmCard}>
                <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head }}>Удалить фрагмент?</div>
                <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                  <button className="bp-btn-ghost" onClick={() => closeOverlay("delFrag")}>Отмена</button>
                  <button className="bp-btn-primary" style={{ background: "#dc2626", borderColor: "#dc2626" }} onClick={() => void removeFragment(o.fid)}>
                    Удалить
                  </button>
                </div>
              </div>
            </div>
          </>
        );
      // Расхождение имён: спрашиваем ДО записи, иначе имя из диаграммы пропало бы
      // молча. После привязки действует имя узла — схема источник истины.
      case "bindConfirm":
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("bindConfirm")} />
            <div style={overlayCenter}>
              <div style={confirmCard}>
                <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head, marginBottom: 6 }}>
                  Имена расходятся
                </div>
                <div style={{ fontSize: 12.5, color: BPT.mut, marginBottom: 14, lineHeight: 1.5 }}>
                  В диаграмме участник назывался «{o.partName}», а узел схемы —
                  «{o.nodeName}». После привязки будет действовать имя узла:
                  схема — источник истины.
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button className="bp-btn-ghost" onClick={() => closeOverlay("bindConfirm")}>Отмена</button>
                  <button
                    className="bp-btn-primary"
                    onClick={() => void bindParticipant(o.participantId, o.nodeId)}
                  >
                    Привязать
                  </button>
                </div>
              </div>
            </div>
          </>
        );
      // Привязка непривязанного участника: тот же пикер дерева, что и у добавления —
      // выбранный узел не добавляет линию жизни, а достаётся существующей.
      case "bindPart":
        if (!detail) return null;
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("bindPart")} />
            <div style={overlayCenter}>
              <div style={{ ...confirmCard, width: 380, textAlign: "left" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: BPT.head }}>
                    Привязать «{partById[o.pid]?.name ?? "участника"}»
                  </div>
                  <button className="bp-iconbtn" style={{ width: 26, height: 26 }} onClick={() => closeOverlay("bindPart")}>
                    <IcoClose s={14} />
                  </button>
                </div>
                <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>
                  Участник пришёл из импорта или потерял узел при удалении. Выберите, какому
                  объекту схемы он соответствует.
                </div>
                <ParticipantPicker
                  added={new Set(detail.participants.flatMap((p) => (p.node_id ? [p.node_id] : [])))}
                  onAdd={(ids) => { if (ids[0]) void requestBind(o.pid, ids[0]); }}
                />
              </div>
            </div>
          </>
        );
      // Управление участниками.
      case "parts":
        if (!detail) return null;
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("parts")} />
            <div style={overlayCenter}>
              <div style={{ ...confirmCard, width: 380, textAlign: "left" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: BPT.head }}>Участники</div>
                  <button className="bp-iconbtn" style={{ width: 26, height: 26 }} onClick={() => closeOverlay("parts")}>
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
        );
    }
  }

  // ── Тулбар над диаграммой ─────────────────────────────────────────
  const toolbar = (
    <ProcessToolbar
      name={detail?.name ?? "Процесс"}
      scopeName={detail?.scope_name ?? "Вся схема"}
      isArchitect={isArchitect}
      editing={editing}
      onToggleEditing={onToggleEditing}
      danglingCount={danglingCount}
      onReattach={() => void reattachChannels()}
      fragSelect={fragSelect}
      onFragSelect={(k) => setFragSelect((cur) => (cur === k ? null : k))}
      canFragment={!!detail && detail.messages.length > 0}
      onAddParticipant={() => openOverlay({ kind: "parts" })}
      history={hist}
      hasStatus={hasStatus}
      view={view}
      onViewChange={setView}
    />
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
          // data-tour: диаграмма процесса — вторая цель шага «Бизнес-процессы» тура демо
          <div style={{ padding: "8px 12px 18px", width: "max-content" }} data-tour="process-diagram">
            <SequenceDiagram
              participants={seq.participants}
              messages={seq.messages}
              activations={activations}
              fragments={seq.fragments}
              view={view}
              ghost={editing}
              selectMode={editing ? fragSelect : null}
              onSelectRange={editing ? (from, to) => {
                // Диапазон выбран (индексы строк) — ждём ввода условия перед созданием.
                if (fragSelect) openOverlay({ kind: "frag", frag: fragSelect, fromRow: from, toRow: to, guard: "" });
                setFragSelect(null);
              } : undefined}
              onFragmentClick={editing ? (fid) => openOverlay({ kind: "delFrag", fid }) : undefined}
              onResizeFragment={editing ? (fid, from, to) => void resizeFragment(fid, from, to) : undefined}
              onMoveBranch={editing ? (fid, index, row) => void moveBranch(fid, index, row) : undefined}
              onEditBranch={editing ? (fid, index) => {
                const frag = fragById.get(fid);
                const guard = index != null ? (frag?.branches[index]?.guard ?? "") : "";
                openOverlay({ kind: "branch", fid, index, guard });
              } : undefined}
              onConnect={editing ? (fromPid, toPid) => {
                // Граница слоёв: диаграмма говорит УЧАСТНИКАМИ, композитор и
                // направления — узлами C4. Перевод делаем здесь, в одном месте.
                const from = nodeOfPart(fromPid);
                const to = nodeOfPart(toPid);
                // У непривязанного участника узла нет, значит нет и каналов — открывать
                // композитор не на чем.
                if (from && to) openOverlay({ kind: "composer", from, to });
              } : undefined}
              canConnect={editing ? (fromPid, toPid) => {
                const from = nodeOfPart(fromPid);
                const to = nodeOfPart(toPid);
                return !!from && !!to && directions.has(`${from}>${to}`);
              } : undefined}
              onSelfConnect={editing ? (pid) => openOverlay({ kind: "self", pid, caption: "" }) : undefined}
              // Карточка шага: правка подписи и удаление.
              onMessageClick={editing ? (mid) => {
                openOverlay({ kind: "msg", mid, caption: msgById.get(mid)?.caption ?? "" });
              } : undefined}
              // Просмотр: шаг со схемой логики открывает её — тем же оверлеем, что
              // провал из карточки шага в правке.
              onOpenDoc={editing ? undefined : (mid) => {
                const m = msgById.get(mid);
                const doc = m ? stepDoc(m, detail?.participants ?? []) : null;
                if (doc) openOverlay({ kind: "doc", ...doc });
              }}
              onBindParticipant={editing ? (pid) => openOverlay({ kind: "bindPart", pid }) : undefined}
              // Переход на страницу объекта — не правка: доступен и в просмотре.
              onOpenNode={onOpenNode}
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

        {/* Окна поверх холста — в порядке открытия: открытое позже ложится сверху. */}
        {overlayStack.map((o) => <Fragment key={o.kind}>{renderOverlay(o)}</Fragment>)}
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
// Карточка «одно поле» поверх холста: рефлексивное сообщение, ветка «иначе», условие
// фрагмента (аудит F-2: три копии одной разметки). Enter — то же, что основная кнопка;
// extra — кнопка слева от «Отмена» (у ветки — «Убрать ветку»).
function PromptCard({
  title, hint, autofillKey, value, onChange, placeholder, inputStyle, inputClassName,
  submitLabel, onSubmit, onCancel, extra,
}: {
  title: string;
  hint: string;
  autofillKey: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  inputStyle?: CSSProperties;
  inputClassName?: string;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  return (
    <>
      <div style={overlayDim} onClick={onCancel} />
      <div style={overlayCenter}>
        <div style={confirmCard}>
          <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head, marginBottom: 4 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>{hint}</div>
          <input
            {...noAutofill(autofillKey)}
            className={inputClassName}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            style={inputStyle}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
            {extra}
            <button className="bp-btn-ghost" onClick={onCancel}>Отмена</button>
            <button className="bp-btn-primary" onClick={onSubmit}>{submitLabel}</button>
          </div>
        </div>
      </div>
    </>
  );
}

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
