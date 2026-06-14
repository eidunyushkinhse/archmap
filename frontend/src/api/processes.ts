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
};
