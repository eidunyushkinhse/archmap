import { api } from "./client";
import type {
  Channel,
  FragmentCreate,
  FragmentUpdate,
  MessageCreate,
  MessageUpdate,
  ParticipantCreate,
  ProcessCreate,
  ProcessDetail,
  ProcessFragment,
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

  // Фрагменты (свободный слой)
  addFragment: (id: string, body: FragmentCreate): Promise<ProcessFragment> =>
    api.post<ProcessFragment>(`/processes/${id}/fragments`, body),
  updateFragment: (id: string, fragmentId: string, body: FragmentUpdate): Promise<ProcessFragment> =>
    api.patch<ProcessFragment>(`/processes/${id}/fragments/${fragmentId}`, body),
  removeFragment: (id: string, fragmentId: string): Promise<void> =>
    api.delete(`/processes/${id}/fragments/${fragmentId}`),

  // Композитор: каналы между парой участников (узлы a и b)
  channels: (id: string, a: string, b: string): Promise<Channel[]> =>
    api.get<Channel[]>(`/processes/${id}/channels?a=${a}&b=${b}`),

  // Дублирование процесса — оркестрация существующих эндпоинтов (не бизнес-логика):
  // копируем участников (запоминая node_id → новый participant_id), затем сообщения
  // (повисшие без edge_id не переносим — связи в схеме уже нет) и фрагменты.
  duplicate: async (id: string): Promise<ProcessDetail> => {
    const src = await processesApi.get(id);
    const copy = await processesApi.create({
      name: `${src.name} (копия)`,
      scope_node_id: src.scope_node_id,
    });
    const newPartByNode: Record<string, string> = {};
    for (const p of [...src.participants].sort((a, b) => a.order - b.order)) {
      const np = await processesApi.addParticipant(copy.id, { node_id: p.node_id, order: p.order });
      newPartByNode[p.node_id] = np.id;
    }
    for (const m of src.messages) {
      const isSelf = m.from_id === m.to_id;
      if (!m.edge_id && !isSelf) continue; // повисшее (не self) — переносить нечего
      await processesApi.addMessage(copy.id, {
        edge_id: m.edge_id,
        leg: m.leg,
        from_participant_id: newPartByNode[m.from_id],
        to_participant_id: newPartByNode[m.to_id],
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
        else_guard: f.else_guard,
        else_order: f.else_order,
      });
    }
    return processesApi.get(copy.id);
  },
};
