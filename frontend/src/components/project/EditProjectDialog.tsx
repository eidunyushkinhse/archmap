import { useState } from "react";
import type { CSSProperties } from "react";
import type { Project } from "../../types";
import { projectsApi } from "../../api/projects";
import Modal from "../../ui/Modal";
import { errText, input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";
import { noAutofill } from "../../ui/noAutofill";
import { useBusyAction } from "../../ui/useBusyAction";

/**
 * Редактирование проекта: урезанная версия CreateProjectDialog — только «Название»
 * (обязательно) и «Описание», предзаполненные текущими значениями. Способ старта
 * у существующего проекта не меняется. Успех → onSaved().
 */

interface Props {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditProjectDialog({ project, onClose, onSaved }: Props) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const { busy, error, run } = useBusyAction("Не удалось сохранить проект");

  const canSubmit = name.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    await run(() => projectsApi.update(project.id, {
      name: name.trim(),
      description: description.trim() || null,
    }).then(onSaved));
  }

  return (
    <Modal onClose={onClose} boxStyle={{ width: 460, padding: 24 }}>
      <h3 style={title}>Редактировать проект</h3>

      <label style={labelStyle}>Название</label>
      <input
        {...noAutofill("edit-project-dialog-1")}
        data-autofocus
        style={input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />

      <label style={labelStyle}>Описание <span style={{ color: "#94a3b8", fontWeight: 400 }}>(необязательно)</span></label>
      <textarea
        {...noAutofill("edit-project-dialog-2")}
        style={{ ...input, minHeight: 60, resize: "vertical" }}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Коротко о схеме"
      />

      {error && <p style={errText}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button style={{ ...primaryBtn, opacity: canSubmit ? 1 : 0.55 }} disabled={!canSubmit} onClick={submit}>
          {busy ? "Сохранение…" : "Сохранить"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

const title: CSSProperties = { margin: "0 0 16px", fontSize: 18, fontWeight: 700, color: "#0f172a" };
