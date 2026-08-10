import { api } from "./client";
import type {
  BindResult,
  ReattachResult,
  Channel,
  FragmentCreate,
  FragmentUpdate,
  MessageCreate,
  MessageDirection,
  MessageUpdate,
  ParticipantCreate,
  ProcessCreate,
  ProcessDetail,
  ProcessFragment,
  ProcessImportApply,
  ProcessImportIn,
  ProcessImportPreview,
  ProcessImportResult,
  ProcessListItem,
  ProcessMessage,
  ProcessParticipant,
  ProcessUpdate,
} from "../types";

// Клиент бизнес-процессов. Раскладку диаграммы считаем на фронте; бизнес-логику
// (легальность плеч) не дублируем — доверяем бэку, ошибку показываем.
export const processesApi = {
  list: (): Promise<ProcessListItem[]> => api.get<ProcessListItem[]>(`/processes`),
  get: (id: string): Promise<ProcessDetail> => api.get<ProcessDetail>(`/processes/${id}`),
  create: (body: ProcessCreate): Promise<ProcessDetail> =>
    api.post<ProcessDetail>(`/processes`, body),
  update: (id: string, body: ProcessUpdate): Promise<ProcessDetail> =>
    api.patch<ProcessDetail>(`/processes/${id}`, body),
  remove: (id: string): Promise<void> => api.delete(`/processes/${id}`),

  // Участники
  addParticipant: (id: string, body: ParticipantCreate): Promise<ProcessParticipant> =>
    api.post<ProcessParticipant>(`/processes/${id}/participants`, body),
  // Привязка непривязанного участника к узлу схемы (node_id = null — снятие, для undo).
  bindParticipant: (id: string, participantId: string, nodeId: string | null): Promise<BindResult> =>
    api.patch<BindResult>(`/processes/${id}/participants/${participantId}`, { node_id: nodeId }),
  removeParticipant: (id: string, participantId: string): Promise<void> =>
    api.delete(`/processes/${id}/participants/${participantId}`),
  reorderParticipants: (id: string, ids: string[]): Promise<ProcessParticipant[]> =>
    api.patch<ProcessParticipant[]>(`/processes/${id}/participants/reorder`, { ids }),

  // Сообщения
  addMessage: (id: string, body: MessageCreate): Promise<ProcessMessage> =>
    api.post<ProcessMessage>(`/processes/${id}/messages`, body),
  updateMessage: (id: string, messageId: string, body: MessageUpdate): Promise<ProcessMessage> =>
    api.patch<ProcessMessage>(`/processes/${id}/messages/${messageId}`, body),
  removeMessage: (id: string, messageId: string): Promise<void> =>
    api.delete(`/processes/${id}/messages/${messageId}`),
  // Новый порядок шагов одной транзакцией: ids сверху вниз → order 0..N-1. Бэк
  // требует ПОЛНЫЙ перечень (по позициям фрагменты держат свой диапазон).
  reorderMessages: (id: string, ids: string[]): Promise<ProcessMessage[]> =>
    api.patch<ProcessMessage[]>(`/processes/${id}/messages/reorder`, { ids }),

  // Фрагменты (свободный слой)
  addFragment: (id: string, body: FragmentCreate): Promise<ProcessFragment> =>
    api.post<ProcessFragment>(`/processes/${id}/fragments`, body),
  updateFragment: (id: string, fragmentId: string, body: FragmentUpdate): Promise<ProcessFragment> =>
    api.patch<ProcessFragment>(`/processes/${id}/fragments/${fragmentId}`, body),
  removeFragment: (id: string, fragmentId: string): Promise<void> =>
    api.delete(`/processes/${id}/fragments/${fragmentId}`),

  // Подхват каналов для повисших шагов процесса — после правки схемы. detach —
  // компенсация для undo: отцепляет ровно то, что прицепил подхват.
  reattach: (id: string): Promise<ReattachResult> =>
    api.post<ReattachResult>(`/processes/${id}/reattach`, {}),
  detachMessages: (id: string, ids: string[]): Promise<void> =>
    api.post(`/processes/${id}/messages/detach`, { ids }),

  // Импорт процесса из mermaid: превью ничего не пишет, применение создаёт НОВЫЙ
  // процесс (слияние с существующим — отдельная задача).
  importPreview: (body: ProcessImportIn): Promise<ProcessImportPreview> =>
    api.post<ProcessImportPreview>(`/processes/import/preview`, body),
  importProcess: (body: ProcessImportApply): Promise<ProcessImportResult> =>
    api.post<ProcessImportResult>(`/processes/import`, body),

  // Композитор: каналы между парой участников (узлы a и b)
  channels: (id: string, a: string, b: string): Promise<Channel[]> =>
    api.get<Channel[]>(`/processes/${id}/channels?a=${a}&b=${b}`),
  // Куда МОЖНО завести сообщение — сразу по всем парам участников. Считает бэк:
  // проекция концов связи через предков живёт там, и вторая реализация на клиенте
  // неизбежно разошлась бы с валидатором.
  directions: (id: string): Promise<MessageDirection[]> =>
    api.get<MessageDirection[]>(`/processes/${id}/directions`),

  // Дублирование процесса — оркестрация существующих эндпоинтов (не бизнес-логика):
  // копируем участников (запоминая node_id → новый participant_id), затем сообщения
  // (повисшие без edge_id не переносим — связи в схеме уже нет) и фрагменты.
  duplicate: async (id: string): Promise<ProcessDetail> => {
    const src = await processesApi.get(id);
    const copy = await processesApi.create({
      name: `${src.name} (копия)`,
      scope_node_id: src.scope_node_id,
    });
    // Старый участник → новый. Непривязанных не переносим: addParticipant требует
    // узел, а у них его нет (перенос таких — задача импорта, не дублирования).
    const newPartByOld: Record<string, string> = {};
    for (const p of [...src.participants].sort((a, b) => a.order - b.order)) {
      if (!p.node_id) continue;
      const np = await processesApi.addParticipant(copy.id, { node_id: p.node_id, order: p.order });
      newPartByOld[p.id] = np.id;
    }
    for (const m of src.messages) {
      const isSelf = m.from_participant_id === m.to_participant_id;
      if (!m.edge_id && !isSelf) continue; // повисшее (не self) — переносить нечего
      const from = newPartByOld[m.from_participant_id];
      const to = newPartByOld[m.to_participant_id];
      if (!from || !to) continue; // конец был непривязанным — переносить нечего
      await processesApi.addMessage(copy.id, {
        edge_id: m.edge_id,
        leg: m.leg,
        from_participant_id: from,
        to_participant_id: to,
        caption: m.caption,
        order: m.order,
      });
    }
    for (const f of src.fragments) {
      await processesApi.addFragment(copy.id, {
        kind: f.kind,
        from_order: f.from_order,
        to_order: f.to_order,
        guard: f.guard,
        branches: f.branches.map((b) => ({ start_order: b.start_order, guard: b.guard })),
      });
    }
    return processesApi.get(copy.id);
  },
};
