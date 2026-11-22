import { useId, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Project } from "../../types";
import { projectsApi } from "../../api/projects";
import Modal from "../../ui/Modal";
import GrowField from "../../ui/GrowField";
import { CloseIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import { useBusyAction } from "../../ui/useBusyAction";
import "../../ui/ds.css";

/**
 * Окно «Редактировать проект» (редизайн, фаза 9г): каркас окна нового языка (ui/ds.css,
 * ds-win) и те же строки «подпись — значение», что «Название» и «Описание» окна «Новый
 * проект» (CreateProjectDialog), предзаполненные текущими значениями. Способ старта у
 * существующего проекта не меняется. «Сохранить» заперта при пустом названии; Enter в
 * названии сохраняет, в описании переносит строку (Ctrl+Enter там сохраняет, ui/Modal).
 * Успех → onSaved().
 */

interface Props {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditProjectDialog({ project, onClose, onSaved }: Props) {
  const uid = useId();
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

  // Однострочное по смыслу поле названия растёт по тексту (GrowField) и само гасит Enter,
  // поэтому сохранение по Enter — здесь, а не через Modal.onSubmit (тот погашенный Enter
  // не видит). Набор через IME Enter завершает подстановку, а не сохраняет.
  const onNameKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  };

  return (
    <Modal onClose={onClose} onSubmit={submit} closeButton={false} boxStyle={{ width: 480, padding: 0 }}>
      <div className="ds ds-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Редактировать проект</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <dl className="ds-props">
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor={`${uid}-name`}>Название</label></dt>
              <dd className="ds-prop-value">
                <GrowField
                  {...noAutofill("edit-project-dialog-1")}
                  id={`${uid}-name`}
                  data-autofocus
                  initial={project.name}
                  onValue={setName}
                  onCommit={setName}
                  onKeyDown={onNameKey}
                  placeholder="например: Платёжная платформа"
                />
              </dd>
            </div>
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor={`${uid}-desc`}>Описание</label></dt>
              <dd className="ds-prop-value">
                <GrowField
                  {...noAutofill("edit-project-dialog-2")}
                  id={`${uid}-desc`}
                  multiline
                  initial={project.description ?? ""}
                  onValue={setDescription}
                  onCommit={setDescription}
                  placeholder="коротко о проекте"
                />
              </dd>
            </div>
          </dl>
        </div>

        <div className="ds-win-foot">
          {error && <p className="ds-danger ds-win-err" role="alert">{error}</p>}
          <button type="button" className="ds-btn ds-btn--primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Сохраняем" : "Сохранить"}
          </button>
          <button type="button" className="ds-btn" disabled={busy} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
