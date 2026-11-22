// Окно «Новый проект» (редизайн, фаза 6б): одна колонка на общем каркасе окна (ui/ds.css,
// ds-win). Сверху «Название» и «Описание» строками «подпись — значение» — они общие для
// всех режимов и не двигаются при их смене; под ними режим текстовыми вкладками («Пустой»,
// «Копия», «Импорт», «ИИ-агент»), ниже содержимое режима; футер слева. Открывается с
// экрана «Проекты» и из списка проектов шапки — компонент один. Успех → onCreated(id).
//
// Состояние — useCreateProject (ввоз файлов — useUnifiedImport), режим «Копия» —
// CreateCopyList, режимы ввоза с агентом и без — CreateImport.
//
// Способа «Шаблон» больше нет (убран 2026-09-30; демо-пакет «Ярмарки» ждёт онбординга,
// tasks.md); отдельного режима «Из архива» тоже: архив — такой же вход ввоза, как YAML.
import { useId } from "react";
import type { KeyboardEvent } from "react";
import type { Project } from "../../types";
import Modal from "../../ui/Modal";
import GrowField from "../../ui/GrowField";
import { CloseIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import { useCreateProject } from "./useCreateProject";
import type { CreateProject, StartMode } from "./useCreateProject";
import CreateCopyList from "./CreateCopyList";
import CreateImport from "./CreateImport";
import "../../ui/ds.css";
import "./createProject.css";

interface Props {
  // активные проекты — образцы для режима «Копия»
  projects: Project[];
  onClose: () => void;
  onCreated: (id: string) => void;
}

const MODES: { mode: StartMode; label: string }[] = [
  { mode: "blank", label: "Пустой" },
  { mode: "copy", label: "Копия" },
  { mode: "import", label: "Импорт" },
  { mode: "repo", label: "ИИ-агент" },
];

export default function CreateProjectDialog({ projects, onClose, onCreated }: Props) {
  const uid = useId();
  const cp = useCreateProject(projects, onCreated, () => document.getElementById(`${uid}-name`)?.focus());
  const done = cp.imp.result !== null;

  return (
    // Окно прижато к верху экрана, а не по центру: высота окна у режимов разная (у
    // «Пустого» без содержимого, у «Импорта» с превью), и по центру поля и вкладки
    // прыгали бы по экрану при смене режима.
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 640, padding: 0, margin: "8vh auto auto" }}>
      {/* Файлы принимает всё окно, пока открыт режим ввоза. imp-res — область вида итога
          ввоза, общего с «Догрузить архив» (importResult.css). */}
      <div className="ds ds-win cp-win imp-res" {...(cp.importish ? cp.imp.inputs.drop.bind : {})}>
        <div className="ds-win-head">
          <h2 className="ds-win-title">Новый проект</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          {/* После применения ввоза проект уже создан: полей и режимов нет, только отчёт. */}
          {!done && (
            <div className="cp-top" data-tour="create-project">
              <Fields cp={cp} uid={uid} />
              <div className="ds-tabs cp-modes" role="group" aria-label="Способ создания">
                {MODES.map((m) => (
                  <button
                    key={m.mode}
                    type="button"
                    className={"ds-tab" + (cp.mode === m.mode ? " is-active" : "")}
                    aria-pressed={cp.mode === m.mode}
                    // Без проектов копировать нечего.
                    disabled={m.mode === "copy" && projects.length === 0}
                    onClick={() => cp.setMode(m.mode)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {cp.mode === "copy" && (
            <CreateCopyList projects={projects} selected={cp.sourceId} onSelect={cp.setSourceId} />
          )}
          {cp.importish && <CreateImport cp={cp} />}
        </div>

        <div className="ds-win-foot">
          {cp.error && <p className="ds-danger ds-win-err" role="alert">{cp.error}</p>}
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            data-tour="create-project-submit"
            disabled={!cp.canSubmit}
            onClick={() => void cp.submit()}
          >
            {cp.busy ? "Создаём" : done ? "Открыть проект" : "Создать проект"}
          </button>
          <button type="button" className="ds-btn" disabled={cp.busy} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * «Название» и «Описание». Значения — поля, растущие по тексту; пометки «(необязательно)»
 * нет. Единственный вход ввоза — архив: имя и описание приедут из его манифеста (П3),
 * поэтому вместо полей — сами значения из архива.
 */
function Fields({ cp, uid }: { cp: CreateProject; uid: string }) {
  const { fresh, fromManifest } = cp.imp;
  // Enter в названии создаёт проект (в описании — перевод строки). Через Modal.onSubmit
  // нельзя: в этом же окне живут поля вопросов ввоза, где Enter — не «создать проект».
  const onNameKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void cp.submit();
  };
  if (cp.importish && fromManifest) {
    return (
      <dl className="ds-props">
        <div className="ds-prop">
          <dt className="ds-prop-term">Название</dt>
          <dd className="ds-prop-value">
            {fresh?.manifest_name ?? "без имени"} <span className="cp-quiet">из архива</span>
          </dd>
        </div>
        {fresh?.manifest_description && (
          <div className="ds-prop">
            <dt className="ds-prop-term">Описание</dt>
            <dd className="ds-prop-value cp-fixed">{fresh.manifest_description}</dd>
          </div>
        )}
      </dl>
    );
  }
  return (
    <dl className="ds-props">
      <div className="ds-prop">
        <dt className="ds-prop-term"><label htmlFor={`${uid}-name`}>Название</label></dt>
        <dd className="ds-prop-value">
          <GrowField
            {...noAutofill("create-project-dialog-1")}
            id={`${uid}-name`}
            data-autofocus
            initial={cp.name}
            onValue={cp.setName}
            onCommit={cp.setName}
            onKeyDown={onNameKey}
            placeholder="например: Платёжная платформа"
          />
          {cp.nameMissing && (
            <p className="ds-danger cp-need" role="alert">
              Сначала введите название. Оно попадёт в задание агенту.
            </p>
          )}
        </dd>
      </div>
      <div className="ds-prop">
        <dt className="ds-prop-term"><label htmlFor={`${uid}-desc`}>Описание</label></dt>
        <dd className="ds-prop-value">
          <GrowField
            {...noAutofill("create-project-dialog-2")}
            id={`${uid}-desc`}
            multiline
            initial={cp.description}
            onValue={cp.setDescription}
            onCommit={cp.setDescription}
            placeholder="коротко о проекте"
          />
        </dd>
      </div>
    </dl>
  );
}
