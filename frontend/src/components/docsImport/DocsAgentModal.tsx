// Окно «Описать схемы логики с помощью ИИ-агента» (BYOA-дозаливка) — ТОЛЬКО СХЕМЫ
// ЛОГИКИ (node_docs, mermaid). OpenAPI-спека узла — отдельное окно спеки
// (DocOverlay → SpecAgentPanel): сущности не смешиваются (include промпта и фильтр
// превью/применения зафиксированы на «logic»). Скоуп — ТЕКУЩИЙ УЗЕЛ, два режима:
// «Пакетом» — все схемы объекта за заход (микросервисы); «По одной схеме» — один
// воркер/эндпоинт (крупные монолиты), строка «Что описать» (target — блок фокуса в
// промпте). Одну схему со страницы правят не здесь, а в её окне («Изменить → Через
// ИИ-агента»): туда же ведёт и неописанная строка.
//
// Вид — новый язык (редизайн, фаза 6в): одна колонка на общем каркасе окна (ui/ds.css,
// ds-win) в порядке действий. Режим текстовыми вкладками (пояснение режима — в подсказке
// вкладки) → «Задание агенту» (строки «подпись — значение», «Скопировать задание») →
// «Ответы агента» (зона файлов, отчёт превью, галочка «Заменять уже описанное») → футер
// слева. Файлы принимает всё окно. Состояние пакета, превью и применения — useDocsAgent
// (то же у прежней панели окна одной схемы), зона файлов — DocsAgentFiles, отчёт —
// DocsAgentPlan.
//
// Окно прижато к верху экрана, а не стоит по центру: высота меняется со сменой режима и
// с файлами, а вкладки остаются на месте (как «Новый проект»). Закрытие после успешного
// применения — отсюда (onClose); родитель через onApplied только освежает мету узла.
import { useId, useState } from "react";
import type { PromptVariant } from "../../types";
import { docsImportApi, type DocsPromptParams } from "../../api/docsImport";
import { useDocsAgent } from "./useDocsAgent";
import { MAX_FILES } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import DocsAgentFiles from "./DocsAgentFiles";
import DocsAgentPlan from "./DocsAgentPlan";
import LangChoice from "./LangChoice";
import PromptCopyButton from "./PromptCopyButton";
import Modal from "../../ui/Modal";
import GrowField from "../../ui/GrowField";
import { CloseIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import { copyText } from "../../lib/copyText";
import "../../ui/ds.css";
import "./docsAgent.css";

type Mode = "batch" | "single";

// Пояснение режима — подсказкой на самой вкладке: на экране оно занимало строку рядом с
// переключателем.
const MODES: { mode: Mode; label: string; hint: string }[] = [
  {
    mode: "batch",
    label: "Пакетом",
    hint: "Агент отдаст пакет со всеми схемами объекта за один заход. Используйте этот режим в репозиториях микросервисов",
  },
  {
    mode: "single",
    label: "По одной схеме",
    hint: "Агент отдаст схему одного воркера или эндпоинта за один заход. Используйте этот режим в репозиториях крупных монолитов",
  },
];

interface Props {
  // Узел, для которого агент готовит документы (скоуп промпта и применения).
  nodeId: string;
  onClose: () => void;
  // Дозаливка применена — родитель освежает мету узла (docs/спека).
  onApplied: () => void;
}

export default function DocsAgentModal({ nodeId, onClose, onApplied }: Props) {
  const uid = useId();
  const [mode, setMode] = useState<Mode>("batch");
  const single = mode === "single";
  // ── параметры промпта (include зафиксирован на схемах логики) ──
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [hints, setHints] = useState("");
  const [target, setTarget] = useState(""); // «По одной»: воркер/эндпоинт
  // Поле адреса держит текст само (GrowField): после «Добавить ещё» его перемонтируем
  // пустым.
  const [targetEpoch, setTargetEpoch] = useState(0);

  // Пакет применён: «Добавить ещё» оставляет окно под следующую точку входа
  // (адрес очищаем здесь, пакет очищает useDocsAgent), остальное закрывает окно.
  const agent = useDocsAgent(nodeId, { kind: mode }, (more) => {
    onApplied();
    if (more) {
      setTarget("");
      setTargetEpoch((n) => n + 1);
    } else onClose();
  });
  const drop = useFileDrop({ onFiles: agent.pkg.pickFiles, disabled: agent.pkg.files.length >= MAX_FILES });
  const canApply = agent.willWrite && !agent.applying;

  // Запрос промпта + запись в буфер В ПРЕДЕЛАХ ЖЕСТА (промежуточных await между
  // кликом и writeText не добавляем). «Скопировано» показывает PromptCopyButton по
  // разрешению этого обещания.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    // include зафиксирован на схемах логики (OpenAPI-спека — окно спеки);
    // в режиме «по одной» target фокусирует агента на одном воркере/эндпоинте
    // (пустой target клиент не передаёт).
    const params: DocsPromptParams = { nodeId, include: "logic", lang, hints, target, variant };
    return copyText(docsImportApi.prompt(params).then(({ prompt }) => prompt));
  }

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 640, padding: 0, margin: "8vh auto auto" }}>
      <div className="ds ds-win dap-win" {...drop.bind}>
        <div className="ds-win-head">
          <h2 className="ds-win-title">Описать схемы логики с помощью ИИ-агента</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <div className="ds-tabs dap-modes" role="group" aria-label="Как описывать">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                className={"ds-tab" + (mode === m.mode ? " is-active" : "")}
                aria-pressed={mode === m.mode}
                title={m.hint}
                onClick={() => setMode(m.mode)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <section className="ds-win-block">
            <h3 className="ds-win-block-title">Задание агенту</h3>
            <dl className="ds-props">
              {single && (
                <div className="ds-prop">
                  <dt className="ds-prop-term"><label htmlFor={`${uid}-target`}>Что описать</label></dt>
                  <dd className="ds-prop-value">
                    <GrowField
                      key={targetEpoch}
                      {...noAutofill("docs-agent-modal-1")}
                      id={`${uid}-target`}
                      initial={target}
                      onValue={setTarget}
                      onCommit={setTarget}
                      placeholder="воркер или эндпоинт: OrderCreatedHandler, POST /orders"
                    />
                  </dd>
                </div>
              )}
              <div className="ds-prop">
                <dt className="ds-prop-term" id={`${uid}-lang`}>Язык подписей</dt>
                <dd className="ds-prop-value">
                  <LangChoice value={lang} onChange={setLang} labelId={`${uid}-lang`} />
                </dd>
              </div>
              <div className="ds-prop">
                <dt className="ds-prop-term"><label htmlFor={`${uid}-hints`}>Подсказки агенту</label></dt>
                <dd className="ds-prop-value">
                  <GrowField
                    {...noAutofill("docs-agent-modal-2")}
                    id={`${uid}-hints`}
                    multiline
                    initial={hints}
                    onValue={setHints}
                    onCommit={setHints}
                    placeholder="например: документируй только сервис billing"
                  />
                </dd>
              </div>
            </dl>
            <PromptCopyButton
              label="Скопировать задание"
              copiedLabel="Скопировано"
              kind="secondary"
              copy={copyPrompt}
            />
          </section>

          <section className="ds-win-block">
            <h3 className="ds-win-block-title">Ответы агента</h3>
            <DocsAgentFiles agent={agent} single={single} over={drop.over} dropError={drop.error} />
            {agent.pkg.files.length > 0 && (
              <>
                <DocsAgentPlan agent={agent} />
                <label
                  className="ds-check dap-check"
                  title="Если в ArchMap уже есть схема с таким именем, новая по умолчанию пропускается. Отметьте, чтобы новые схемы заменяли старые"
                >
                  <input
                    type="checkbox"
                    checked={agent.overwriteFlag}
                    onChange={(e) => agent.setOverwriteFlag(e.target.checked)}
                  />
                  <span>Заменять уже описанное</span>
                </label>
              </>
            )}
          </section>
        </div>

        {/* Главная кнопка первой, «Отмена» за ней (правило окон владельца). */}
        <div className="ds-win-foot">
          {agent.applyError && <p className="ds-danger ds-win-err" role="alert">{agent.applyError}</p>}
          {single ? (
            <>
              <button type="button" className="ds-btn ds-btn--primary" disabled={!canApply} onClick={() => agent.apply(false)}>
                {agent.applying ? "Применяем" : "Добавить"}
              </button>
              <button
                type="button"
                className="ds-btn"
                disabled={!canApply}
                title="Применить и подготовить поля к следующему воркеру/эндпоинту"
                onClick={() => agent.apply(true)}
              >
                Добавить ещё
              </button>
            </>
          ) : (
            <button type="button" className="ds-btn ds-btn--primary" disabled={!canApply} onClick={() => agent.apply(false)}>
              {agent.applying ? "Применяем" : "Применить"}
            </button>
          )}
          <button type="button" className="ds-btn" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
