import { ApiError } from "../api/client";

// Текст отказа загрузки для человека (аудит R-2, R-9, R-10): раньше ошибки загрузки
// глотались, и страница вечно показывала «Загрузка…» или пустой холст.
export function loadErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "Не найдено — возможно, объект удалили или ссылка устарела.";
    if (e.status === 403) return "Нет доступа к этому проекту.";
    return e.message || `Сервер ответил ошибкой ${e.status}.`;
  }
  // fetch отклоняет TypeError, когда до сервера не достучаться.
  if (e instanceof TypeError) return "Нет связи с сервером — проверьте сеть и повторите.";
  return e instanceof Error && e.message ? e.message : "Неизвестная ошибка.";
}
