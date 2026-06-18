import { useState } from "react";
import type { CSSProperties } from "react";
import type { Project } from "../../types";
import { projectsApi } from "../../api/projects";
import Modal from "../../ui/Modal";
import { dangerBtn, input, primaryBtn, secondaryBtn } from "../../ui/styles";

/** Подтверждения управления проектом: архив (обратимо), восстановление, удаление
 * навсегда (необратимо, с вводом имени). Каждый при успехе зовёт onDone(). */

interface BaseProps {
  project: Project;
  onClose: () => void;
  onDone: () => void;
}

function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка");
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const title: CSSProperties = { margin: "0 0 10px", fontSize: 17, fontWeight: 700, color: "#0f172a" };
const lead: CSSProperties = { color: "#475569", margin: "0 0 16px", fontSize: 14, lineHeight: 1.5 };
const err: CSSProperties = { color: "#dc2626", fontSize: 13, margin: "8px 0 0" };
const row: CSSProperties = { display: "flex", gap: 8, marginTop: 8 };
// Нейтральная тёмная кнопка для обратимого архивирования (не красная).
const darkBtn: CSSProperties = { ...primaryBtn, background: "#334155" };

export function ArchiveDialog({ project, onClose, onDone }: BaseProps) {
  const { busy, error, run } = useAction(onDone);
  return (
    <Modal onClose={onClose} boxStyle={{ width: 440, padding: 24 }}>
      <h3 style={title}>Отправить «{project.name}» в архив?</h3>
      <p style={lead}>Схема сохранится — проект можно вернуть из архива в любой момент.</p>
      {error && <p style={err}>{error}</p>}
      <div style={row}>
        <button style={darkBtn} disabled={busy} onClick={() => run(() => projectsApi.archive(project.id))}>
          {busy ? "…" : "В архив"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

export function RestoreDialog({ project, onClose, onDone }: BaseProps) {
  const { busy, error, run } = useAction(onDone);
  return (
    <Modal onClose={onClose} boxStyle={{ width: 440, padding: 24 }}>
      <h3 style={title}>Вернуть «{project.name}» из архива?</h3>
      <p style={lead}>Проект снова появится среди активных.</p>
      {error && <p style={err}>{error}</p>}
      <div style={row}>
        <button style={primaryBtn} disabled={busy} onClick={() => run(() => projectsApi.restore(project.id))}>
          {busy ? "…" : "Вернуть"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

export function DeleteForeverDialog({ project, onClose, onDone }: BaseProps) {
  const { busy, error, run } = useAction(onDone);
  const [confirmName, setConfirmName] = useState("");
  const unlocked = confirmName === project.name && !busy;
  return (
    <Modal onClose={onClose} boxStyle={{ width: 460, padding: 24 }}>
      <h3 style={title}>Удалить «{project.name}» навсегда?</h3>
      <p style={lead}>
        Схема со всеми объектами, связями и процессами будет удалена безвозвратно.
        Это действие нельзя отменить. Для подтверждения введите имя проекта.
      </p>
      <input
        data-autofocus
        style={input}
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        placeholder={project.name}
      />
      {error && <p style={err}>{error}</p>}
      <div style={row}>
        <button
          style={{ ...dangerBtn, opacity: unlocked ? 1 : 0.5 }}
          disabled={!unlocked}
          onClick={() => run(() => projectsApi.remove(project.id, confirmName))}
        >
          {busy ? "Удаление…" : "Удалить навсегда"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}
