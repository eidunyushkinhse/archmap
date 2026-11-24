// Тост внизу холста, когда добавление упирается в предел демо-стенда
// (docs/tasks/demo-mode.md, экран 4 прототипа): «Не получилось добавить объект.
// Демо-проект поддерживает до 100 объектов…». Для записей без своего окна: отмена
// и повтор удаления или создания, «Новый процесс», дубль процесса. Родитель —
// позиционированный контейнер холста. Вид — тост нового языка внизу холста (ui/ds.css).
import type { LimitMessage } from "./demoLimits";
import "../../ui/ds.css";

export default function DemoLimitToast({ message }: { message: LimitMessage | null }) {
  if (!message) return null;
  return (
    <div className="ds-toast ds-toast--canvas" role="status">
      <b>{message.head}</b> {message.text}
    </div>
  );
}

/** Текст отказа строкой с жирным началом — для окон, где ошибка показывается
 *  абзацем (окно «Новый объект», новая связь, импорт процесса). */
export function LimitText({ message }: { message: LimitMessage }) {
  return <><b>{message.head}</b> {message.text}</>;
}
