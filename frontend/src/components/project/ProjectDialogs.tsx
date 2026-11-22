import { useState } from "react";
import type { Project } from "../../types";
import { projectsApi } from "../../api/projects";
import ConfirmDialog from "../../ui/ConfirmDialog";
import { noAutofill } from "../../ui/noAutofill";
import { useBusyAction } from "../../ui/useBusyAction";
import "../../ui/ds.css";

/** Подтверждения управления проектом на общем ConfirmDialog: архив (обратимо, синяя
 * кнопка), возврат из архива, удаление навсегда (необратимо, красная кнопка, отперта
 * только после ввода имени проекта). Каждый при успехе зовёт onDone(). */

interface BaseProps {
  project: Project;
  onClose: () => void;
  onDone: () => void;
}

export function ArchiveDialog({ project, onClose, onDone }: BaseProps) {
  const { busy, error, run } = useBusyAction("Ошибка");
  return (
    <ConfirmDialog
      tone="neutral"
      title={`Отправить «${project.name}» в архив?`}
      lead="Схема сохранится, и проект можно вернуть из архива в любой момент."
      error={error}
      confirmLabel="В архив"
      busyLabel="Архивируем"
      busy={busy}
      onConfirm={() => void run(() => projectsApi.archive(project.id).then(onDone))}
      onCancel={onClose}
    />
  );
}

export function RestoreDialog({ project, onClose, onDone }: BaseProps) {
  const { busy, error, run } = useBusyAction("Ошибка");
  return (
    <ConfirmDialog
      tone="neutral"
      title={`Вернуть «${project.name}» из архива?`}
      lead="Проект снова появится среди активных."
      error={error}
      confirmLabel="Вернуть"
      busyLabel="Возвращаем"
      busy={busy}
      onConfirm={() => void run(() => projectsApi.restore(project.id).then(onDone))}
      onCancel={onClose}
    />
  );
}

export function DeleteForeverDialog({ project, onClose, onDone }: BaseProps) {
  const { busy, error, run } = useBusyAction("Ошибка");
  const [confirmName, setConfirmName] = useState("");
  const unlocked = confirmName === project.name && !busy;
  // Одно действие у кнопки и у Enter в поле имени: заперта кнопка — заперт и Enter.
  const remove = () => {
    if (unlocked) void run(() => projectsApi.remove(project.id, confirmName).then(onDone));
  };
  return (
    <ConfirmDialog
      title={`Удалить «${project.name}» навсегда?`}
      lead={<>
        Схема со всеми объектами, связями и процессами будет удалена безвозвратно.
        Это действие нельзя отменить. Для подтверждения введите имя проекта.
      </>}
      error={error}
      confirmLabel="Удалить навсегда"
      busyLabel="Удаляем"
      busy={busy}
      confirmDisabled={!unlocked}
      onConfirm={remove}
      onSubmit={remove}
      onCancel={onClose}
    >
      <input
        {...noAutofill("project-dialogs-1")}
        data-autofocus
        className="ds-input"
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        placeholder={project.name}
      />
    </ConfirmDialog>
  );
}
