import { nodesApi } from "../../api/nodes";
import { processesApi } from "../../api/processes";
import type { ProcessParticipant } from "../../types";
import type { ProcessEditCtx } from "./editCtx";
import { addFromSnap, freshPartByNode, type MessageSnapshot } from "./stepSnapshot";

// Правки участников процесса (аудит F-2): добавление, перестановка, привязка к узлу и
// подхват связей, удаление со снимком его шагов — каждая с командой истории. Зовётся на
// каждом рендере холста: замыкания видят свежий процесс, как и раньше, когда функции
// жили в теле ProcessCanvas. setBindNote — строка итога подхвата связей над холстом.
export function participantEdits(
  { id, proc, hist, overlays }: ProcessEditCtx,
  setBindNote: (note: string | null) => void,
) {
  const { detail, reload, setOptimistic, runMutation, partById, nodeOfPart } = proc;
  const { open: openOverlay, close: closeOverlay, update: updateOverlay } = overlays;

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

  return {
    addParticipants, reorderParticipants, requestBind, bindParticipant, reattachChannels,
    requestRemoveParticipant, confirmRemoveParticipant,
  };
}
