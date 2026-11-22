// Окно «Обновить из кода» — синхронизация ЖИВОГО проекта со свежим ответом ИИ-агента
// (docs/plan-arch-sync.md, Фаза 3). Отличие от импорта: импорт создаёт проект с нуля,
// здесь схема уже живёт — с раскладкой, схемами логики, спецификациями и ручными
// правками. Поэтому центр окна — ПЛАН: что появится, что изменится, что пропало.
//
// Вид — новый язык (редизайн, фаза 6а): одна колонка в порядке действий. «Задание
// агенту» (язык описаний и подсказки строками «подпись — значение», кнопка копирования)
// → «Ответы агента» (зона файлов, галочки «что обновлять», план) → «Применить». Каркас
// окна общий (ui/ds.css, ds-win). Состояние ввоза — useSyncImport, зона файлов —
// SyncFiles, план — SyncPlan.
import { useEffect, useId, useState } from "react";
import type { PromptVariant } from "../../types";
import { projectsApi } from "../../api/projects";
import { useSyncImport } from "./useSyncImport";
import PromptCopyButton from "./PromptCopyButton";
import SyncLangChoice from "./SyncLangChoice";
import SyncFiles from "./SyncFiles";
import SyncPlan from "./SyncPlan";
import Modal from "../../ui/Modal";
import GrowField from "../../ui/GrowField";
import { CloseIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import { copyText } from "../../lib/copyText";
import "../../ui/ds.css";
import "./syncRepo.css";

interface Props {
  projectId: string;
  onClose: () => void;
  /** Схема записана — родитель перезагружает граф и показывает тост. */
  onApplied: (message: string) => void;
}

export default function SyncRepoModal({ projectId, onClose, onApplied }: Props) {
  // Имя системы в задании = имя проекта: грузим здесь, а не тащим пропом через
  // оболочку — она его тоже не знает (в шапке имя рисует ProjectSwitcher).
  const [projectName, setProjectName] = useState("");
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [hints, setHints] = useState("");
  const imp = useSyncImport(projectId);
  const uid = useId();

  useEffect(() => {
    let alive = true;
    projectsApi
      .get(projectId)
      .then((p) => {
        if (alive) setProjectName(p.name);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId]);

  // Запрос задания + запись в буфер В ПРЕДЕЛАХ ЖЕСТА; «Скопировано» показывает
  // PromptCopyButton по разрешению этого обещания. Глубина у агента всегда просится одна
  // — два слоя, как и при создании проекта (решение пользователя 2026-08-16): синк и
  // создание обязаны просить одно и то же, иначе ответ агента предложит план по более
  // дробной схеме, чем построенная.
  const copyPrompt = (variant: PromptVariant): Promise<void> =>
    copyText(projectsApi
      .importPrompt({
        systemName: projectName, depth: 2, lang,
        hints: hints.trim() || undefined, variant,
        // Адрес ArchMap для агента: по нему он скачает сборщик фактов первым шагом.
        origin: window.location.origin,
      })
      .then((r) => r.prompt));

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 640, padding: 0 }}>
      <div className="ds ds-win sync-win" {...imp.drop.bind}>
        <div className="ds-win-head">
          <h2 className="ds-win-title">Обновить из кода</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <section className="sync-block">
            <h3 className="sync-block-title">Задание агенту</h3>
            <dl className="sync-props">
              <div className="sync-prop">
                <dt className="sync-term" id={`${uid}-lang`}>Язык описаний</dt>
                <dd className="sync-value">
                  <SyncLangChoice value={lang} onChange={setLang} labelId={`${uid}-lang`} />
                </dd>
              </div>
              <div className="sync-prop">
                <dt className="sync-term"><label htmlFor={`${uid}-hints`}>Подсказки агенту</label></dt>
                <dd className="sync-value">
                  <GrowField
                    {...noAutofill("sync-repo-hints")}
                    id={`${uid}-hints`}
                    multiline
                    initial=""
                    onCommit={setHints}
                    placeholder="например: игнорируй каталог legacy/"
                  />
                </dd>
              </div>
            </dl>
            <PromptCopyButton
              ds
              label="Скопировать задание"
              copiedLabel="Скопировано"
              kind="secondary"
              disabled={!projectName}
              copy={copyPrompt}
            />
          </section>

          <section className="sync-block">
            <h3 className="sync-block-title">Ответы агента</h3>
            <SyncFiles pkg={imp.pkg} over={imp.drop.over} dropError={imp.drop.error} />
            {imp.pkg.files.length > 0 && <SyncPlan imp={imp} />}
          </section>
        </div>

        <div className="ds-win-foot">
          {imp.applyError && <p className="ds-danger sync-err" role="alert">{imp.applyError}</p>}
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            disabled={!imp.canApply}
            onClick={() => imp.apply((message) => { onApplied(message); onClose(); })}
          >
            {imp.applying ? "Применяем" : "Применить"}
          </button>
          <button type="button" className="ds-btn" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
