import { useState } from "react";
import type { CSSProperties } from "react";
import type { Project } from "../../types";
import { projectsApi } from "../../api/projects";
import DialogTitle from "../../ui/DialogTitle";
import Modal from "../../ui/Modal";
import { dangerBtn, errText, input, primaryBtn, secondaryBtn } from "../../ui/styles";
import { noAutofill } from "../../ui/noAutofill";
import { useBusyAction } from "../../ui/useBusyAction";

/** Подтверждения управления проектом: архив (обратимо), восстановление, удаление
 * навсегда (необратимо, с вводом имени). Каждый при успехе зовёт onDone(). */

interface BaseProps {
  project: Project;
  onClose: () => void;
  onDone: () => void;
}

const row: CSSProperties = { display: "flex", gap: 8, marginTop: 8 };
// Нейтральная тёмная кнопка для обратимого архивирования (не красная).
const darkBtn: CSSProperties = { ...primaryBtn, background: "#334155" };

export function ArchiveDialog({ project, onClose, onDone }: BaseProps) {
  const { busy, error, run } = useBusyAction("Ошибка");
  return (
    <Modal onClose={onClose} boxStyle={{ width: 440, padding: 24 }}>
      <DialogTitle lead="Схема сохранится — проект можно вернуть из архива в любой момент.">
        Отправить «{project.name}» в архив?
      </DialogTitle>
      {error && <p style={errText}>{error}</p>}
      <div style={row}>
        <button style={darkBtn} disabled={busy} onClick={() => run(() => projectsApi.archive(project.id).then(onDone))}>
          {busy ? "…" : "В архив"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

export function RestoreDialog({ project, onClose, onDone }: BaseProps) {
  const { busy, error, run } = useBusyAction("Ошибка");
  return (
    <Modal onClose={onClose} boxStyle={{ width: 440, padding: 24 }}>
      <DialogTitle lead="Проект снова появится среди активных.">Вернуть «{project.name}» из архива?</DialogTitle>
      {error && <p style={errText}>{error}</p>}
      <div style={row}>
        <button style={primaryBtn} disabled={busy} onClick={() => run(() => projectsApi.restore(project.id).then(onDone))}>
          {busy ? "…" : "Вернуть"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
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
    <Modal onClose={onClose} onSubmit={remove} boxStyle={{ width: 460, padding: 24 }}>
      <DialogTitle lead={<>
        Схема со всеми объектами, связями и процессами будет удалена безвозвратно.
        Это действие нельзя отменить. Для подтверждения введите имя проекта.
      </>}>
        Удалить «{project.name}» навсегда?
      </DialogTitle>
      <input
        {...noAutofill("project-dialogs-1")}
        data-autofocus
        style={input}
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        placeholder={project.name}
      />
      {error && <p style={errText}>{error}</p>}
      <div style={row}>
        <button
          style={{ ...dangerBtn, opacity: unlocked ? 1 : 0.5 }}
          disabled={!unlocked}
          onClick={remove}
        >
          {busy ? "Удаление…" : "Удалить навсегда"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}
