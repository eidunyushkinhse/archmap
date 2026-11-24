import { edgesApi } from "../../api/nodes";
import { processesApi } from "../../api/processes";
import type { MessageCreate, ProcessMessage } from "../../types";
import type { ProcessEditCtx } from "./editCtx";
import { addFromSnap, freshPartByNode, type MessageSnapshot } from "./stepSnapshot";

// Правки шагов процесса (аудит F-2): добавление из композитора и шаг внутри участника,
// подпись, привязка схемы, тип канала, удаление, перестановка — каждая с командой
// истории. Зовётся на каждом рендере холста: замыкания видят свежий процесс, как и
// раньше, когда функции жили в теле ProcessCanvas. Подпись, схему, тип связи и удаление
// правит панель шага (StepPanel): она не окно, закрывать после правки нечего.
export function messageEdits({ id, proc, hist, overlays }: ProcessEditCtx) {
  const { detail, reload, setOptimistic, runMutation, sortedMessages, msgById, partById, nodeOfPart, nextOrder } = proc;
  const closeOverlay = overlays.close;

  // Перестановка ШАГОВ сценария. id сообщений стабильны (меняется только order),
  // поэтому undo/redo бьют по тем же id — как и у перестановки участников.
  // Границы фрагментов бэк намеренно не двигает: фрагмент — диапазон позиций.
  async function reorderMessages(ids: string[]) {
    if (!detail) return;
    const prevIds = sortedMessages.map((m) => m.id);
    if (ids.length !== prevIds.length) return; // страховка неполного порядка
    // Оптимистично: сразу переписываем order в detail, иначе диаграмма мигнула бы
    // на прежний порядок между отпусканием и ответом API (onRootUp синхронно
    // сбрасывает состояние жеста).
    const orderById = new Map(ids.map((mid, i) => [mid, i]));
    setOptimistic({
      ...detail,
      messages: detail.messages.map((m) => ({ ...m, order: orderById.get(m.id) ?? m.order })),
    });
    await runMutation(async () => {
      await processesApi.reorderMessages(id, ids);
      hist.push({
        label: "Перестановка шагов",
        undo: async () => { await processesApi.reorderMessages(id, prevIds); },
        redo: async () => { await processesApi.reorderMessages(id, ids); },
      });
    }, "Не удалось переставить шаги");
  }

  function handleMessageAdded(created: ProcessMessage, payload: MessageCreate) {
    let mid = created.id;
    hist.push({
      label: "Добавление шага",
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
    await runMutation(async () => {
      const created = await processesApi.addMessage(id, payload);
      let mid = created.id;
      hist.push({
        label: "Шаг внутри участника",
        undo: () => processesApi.removeMessage(id, mid),
        redo: async () => {
          // Участника могли пересоздать (undo его удаления) — тогда id сменился, а
          // node_id нет. У непривязанного узла нет, но и пересоздать его нечем:
          // держимся за его собственный id.
          const pid = part.node_id
            ? (await freshPartByNode(id))[part.node_id]
            : participantId;
          if (!pid) return;
          const r = await processesApi.addMessage(id, { ...payload, from_participant_id: pid, to_participant_id: pid });
          mid = r.id;
        },
      });
      closeOverlay("self");
    }, "Не удалось добавить шаг");
  }
  // Правка подписи шага. Подпись у шага всегда СВОЯ (вывод из канала снят), поэтому
  // пустое поле означает ровно «подписи нет», а не «взять метку связи».
  async function saveCaption(mid: string, caption: string) {
    if (!detail) return;
    const m = msgById.get(mid);
    if (!m) return;
    const next = caption.trim() || null;
    if (next === m.caption) return; // ничего не меняли — не мусорим в истории
    const prev = m.caption;
    setOptimistic({
      ...detail,
      messages: detail.messages.map((x) => (x.id === mid ? { ...x, caption: next } : x)),
    });
    await runMutation(async () => {
      // CAS (Д9): правка от устаревшего шага не затирает чужую — бэк ответит 409,
      // catch перечитает процесс и покажет detail. Undo/redo идут БЕЗ base_version:
      // компенсация переигрывается поверх любого текущего состояния (паттерн узлов).
      await processesApi.updateMessage(id, mid, { caption: next, base_version: m.version });
      hist.push({
        label: "Подпись шага",
        undo: async () => { await processesApi.updateMessage(id, mid, { caption: prev }); },
        redo: async () => { await processesApi.updateMessage(id, mid, { caption: next }); },
      });
    }, "Не удалось изменить подпись шага");
  }
  // Привязка шага к схеме логики: человек привязал схему и тут же видит результат строкой
  // панели шага.
  async function linkDoc(mid: string, docId: string | null) {
    if (!detail) return;
    const m = msgById.get(mid);
    if (!m || m.doc_id === docId) return;
    const prev = m.doc_id ?? null;
    await runMutation(async () => {
      // CAS (Д9) — как у подписи: конфликт → 409 → reload + detail в баннере.
      await processesApi.updateMessage(id, mid, { doc_id: docId, base_version: m.version });
      hist.push({
        label: docId ? "Привязка схемы к шагу" : "Схема отвязана от шага",
        undo: async () => { await processesApi.updateMessage(id, mid, { doc_id: prev }); },
        redo: async () => { await processesApi.updateMessage(id, mid, { doc_id: docId }); },
      });
    }, "Не удалось привязать схему");
  }
  // Синхронность КАНАЛА под шагом. Живёт в панели шага, а не в C4-модалке (решение
  // пользователя 2026-08-11): состав плеч — вопрос процесса, в схеме объекта этот
  // признак не нужен. Правит связь целиком, поэтому задевает все шаги на ней —
  // подсказка строки «Тип» про это говорит прямо. Набранная подпись не теряется: уход
  // из поля к выбору типа её записывает (П3 челленджа 2026-08-16).
  async function setChannelSync(edgeId: string, next: boolean) {
    await runMutation(async () => {
      await edgesApi.update(edgeId, { is_synchronous: next });
      hist.push({
        label: next ? "Связь стала синхронной" : "Связь стала асинхронной",
        undo: async () => { await edgesApi.update(edgeId, { is_synchronous: !next }); },
        redo: async () => { await edgesApi.update(edgeId, { is_synchronous: next }); },
      });
    }, "Не удалось изменить тип связи");
  }
  async function removeMessage(mid: string) {
    const m = msgById.get(mid);
    await runMutation(async () => {
      await processesApi.removeMessage(id, mid);
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
          edge_id: m.edge_id, leg: m.leg, from_id: fromNode, to_id: toNode, caption: m.caption, order: m.order, doc_id: m.doc_id ?? null,
        };
        let restoredId: string | null = null;
        hist.push({
          label: "Удаление шага",
          undo: async () => {
            const partByNode = await freshPartByNode(id);
            const fromP = partByNode[snap.from_id];
            const toP = partByNode[snap.to_id];
            if (!fromP || !toP) return;
            const created = await addFromSnap(id, snap, fromP, toP);
            restoredId = created.id;
          },
          redo: async () => {
            if (restoredId) await processesApi.removeMessage(id, restoredId);
          },
        });
      }
    }, "Не удалось удалить шаг");
  }

  return { handleMessageAdded, createSelfMessage, saveCaption, linkDoc, setChannelSync, removeMessage, reorderMessages };
}
