// Режимы ввоза окна «Новый проект». «Импорт»: файлы уже есть — зона файлов и итог превью.
// «ИИ-агент»: два блока, как в «Обновить из кода» — «Задание агенту» (язык описаний,
// подсказки, «Скопировать задание») и «Ответы агента» (та же зона и то же превью). В
// «Импорте» ни слова об агенте: окно ввоза не знает, откуда у пользователя файлы.
//
// После применения вместо всего этого — отчёт: что приехало и что придётся поправить
// руками; из него уходят в проект кнопкой «Открыть проект». Плашки пределов демо-стенда
// прежнего вида живут в legacy-root: область .ds окна держит их на прежних метриках
// (ui/tokens.css).
import { useId } from "react";
import type { ArchiveImportResult } from "../../types";
import GrowField from "../../ui/GrowField";
import { noAutofill } from "../../ui/noAutofill";
import LangChoice from "../docsImport/LangChoice";
import PromptCopyButton from "../docsImport/PromptCopyButton";
import { DemoExcessNotice, FileTooBigNotice } from "../demo/DemoLimitNotice";
import ImportPane from "./ImportPane";
import { FactLines, ReportTail } from "./ImportReportParts";
import type { CreateProject } from "./useCreateProject";
import "./createProject.css";

export default function CreateImport({ cp }: { cp: CreateProject }) {
  const uid = useId();
  const { imp } = cp;
  if (imp.result) return <ImportReport result={imp.result} />;
  const agent = cp.mode === "repo";

  const pane = (
    <>
      <ImportPane
        inputs={imp.inputs}
        text={agent ? "Перетащите сюда файлы YAML, по одному на репозиторий" : "Перетащите сюда файлы YAML или архивы .zip"}
        pastePlaceholder={agent ? "Вставьте сюда YAML от агента" : "Вставьте сюда YAML"}
        // Не помещается в демо — сводка и вопросы ни к чему: сначала уменьшить входы.
        summary={imp.excess ? null : (imp.fresh?.c4 ?? null)}
        remainder={imp.remainder}
      />
      {imp.tooBig && <div className="legacy-root"><FileTooBigNotice {...imp.tooBig} /></div>}
      {imp.excess && <div className="legacy-root"><DemoExcessNotice excess={imp.excess} scope="files" /></div>}
    </>
  );
  if (!agent) return <section className="ds-win-block">{pane}</section>;

  return (
    <>
      <section className="ds-win-block">
        <h3 className="ds-win-block-title">Задание агенту</h3>
        <dl className="ds-props">
          <div className="ds-prop">
            <dt className="ds-prop-term" id={`${uid}-lang`}>Язык описаний</dt>
            <dd className="ds-prop-value">
              <LangChoice value={cp.lang} onChange={cp.setLang} labelId={`${uid}-lang`} />
            </dd>
          </div>
          <div className="ds-prop">
            <dt className="ds-prop-term"><label htmlFor={`${uid}-hints`}>Подсказки агенту</label></dt>
            <dd className="ds-prop-value">
              <GrowField
                {...noAutofill("create-project-dialog-3")}
                id={`${uid}-hints`}
                multiline
                initial={cp.hints}
                onCommit={cp.setHints}
                placeholder="например: монорепо, сервисы в services/*"
              />
            </dd>
          </div>
        </dl>
        <PromptCopyButton
          label="Скопировать задание"
          copiedLabel="Скопировано"
          kind="secondary"
          disabled={cp.promptBusy}
          copy={cp.copyPrompt}
        />
      </section>
      <section className="ds-win-block">
        <h3 className="ds-win-block-title">Ответы агента</h3>
        {pane}
      </section>
    </>
  );
}

// Отчёт применения ввоза: сколько чего приехало и что не разрешилось. Строки фактов,
// процессов и свёртку делит с догрузкой архивов (ImportReportParts).
function ImportReport({ result }: { result: ArchiveImportResult }) {
  return (
    <section className="ds-win-block cp-report">
      <h3 className="ds-win-block-title">«{result.project_name}» создан</h3>
      <div>
        <div>Объектов: {result.nodes}</div>
        <div>Связей: {result.edges}</div>
        <div>Схем логики: {result.docs_created}</div>
        <div>Спецификаций: {result.specs_applied}</div>
        <FactLines result={result} />
        {result.config && <div>Параметров конфигурации: {result.config.params_written}</div>}
        <ReportTail result={result} />
      </div>
    </section>
  );
}
