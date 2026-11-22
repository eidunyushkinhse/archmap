// Общее окно «… с помощью ИИ-агента» для ТАБЛИЧНЫХ семей фактов: структура базы
// (DataAgentModal), каналы брокера (ChannelsAgentModal), конфигурация сервиса
// (ConfigAgentModal). Окна были копиями с отличиями только в контракте и словах (аудит F-9,
// фаза 7); у каждой семьи — описание FactAgentKind, а машинерия одна: задание агенту →
// пакет файлов → превью с отсрочкой → применение.
//
// Вид — новый язык (редизайн, фаза 6г): одна колонка на общем каркасе окна (ui/ds.css,
// ds-win) в порядке действий, как окно схем логики. «Задание агенту» (кнопка задания) →
// «Ответы агента» со знаком «?» (механика адреса и слияния файлов — help семьи), зона
// файлов, отчёт и галочка «Заменять уже описанное» (пояснение семьи — в подсказке галочки)
// → футер слева: «Применить», «Отмена», отказ применения строкой над ними. Файлы принимает
// всё окно. Состояние — useFactAgent, зона — AgentFiles, отчёт — FactAgentPlan.
//
// Обращений к фактам эти окна не несут: пометки «читает:/пишет:», «публикует:/
// потребляет:», «зависит от:» приезжают внутри схем логики, окном дозаливки доков.
import type { ReactNode } from "react";
import type { PromptVariant } from "../../types";
import { useFactAgent } from "./useFactAgent";
import type { FactApi, FactReport } from "./useFactAgent";
import type { FactPlanWords } from "./FactAgentPlan";
import { MAX_FILES } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import AgentFiles from "./AgentFiles";
import FactAgentPlan from "./FactAgentPlan";
import PromptCopyButton from "./PromptCopyButton";
import Modal from "../../ui/Modal";
import InfoPopover from "../../ui/InfoPopover";
import { CloseIcon } from "../../ui/icons";
import { copyText } from "../../lib/copyText";
import "../../ui/ds.css";
import "./factAgent.css";

// Чем семьи отличаются: контракт и слова. Остальное у окон общее.
export interface FactAgentKind<R extends FactReport> extends FactPlanWords<R> {
  api: FactApi<R>;
  title: string;
  // Механика за «?» у «Ответов агента»: адрес «# archmap-node:» и слияние файлов; без
  // неё «?» у окна нет.
  help?: (nodeName: string) => ReactNode;
  // Пояснение галочки «Заменять уже описанное» — в её подсказке.
  overwriteNote: string;
  // «ArchMap проверил файлы {remarksFamily}…» и «{remarksItems} чини по замечаниям…».
  remarksFamily: string;
  remarksItems: string;
  autofillKey: string;
}

interface Props<R extends FactReport> {
  kind: FactAgentKind<R>;
  // Объект, из окна которого открыта дозаливка: к нему уезжают записи без адреса.
  nodeId: string;
  nodeName: string;
  onClose: () => void;
  // Дозаливка применена — родитель перечитывает факты объекта.
  onApplied: () => void;
}

export default function FactAgentModal<R extends FactReport>({
  kind, nodeId, nodeName, onClose, onApplied,
}: Props<R>) {
  const agent = useFactAgent({
    api: kind.api,
    nodeId,
    count: kind.count,
    remarksFamily: kind.remarksFamily,
    remarksItems: kind.remarksItems,
    onApplied: () => { onApplied(); onClose(); },
  });
  const drop = useFileDrop({ onFiles: agent.pkg.pickFiles, disabled: agent.pkg.files.length >= MAX_FILES });

  // Запрос задания + запись в буфер В ПРЕДЕЛАХ ЖЕСТА; «Скопировано» показывает
  // PromptCopyButton по разрешению этого обещания.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    return copyText(kind.api.prompt(variant).then(({ prompt }) => prompt));
  }

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 640, padding: 0, margin: "8vh auto auto" }}>
      <div className="ds ds-win fact-win" {...drop.bind}>
        <div className="ds-win-head">
          <h2 className="ds-win-title">{kind.title}</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <section className="ds-win-block">
            <h3 className="ds-win-block-title">Задание агенту</h3>
            <PromptCopyButton ds label="Скопировать задание" copiedLabel="Скопировано" kind="secondary" copy={copyPrompt} />
          </section>

          <section className="ds-win-block">
            <div className="ds-win-block-head">
              <h3 className="ds-win-block-title">Ответы агента</h3>
              {kind.help && (
                <InfoPopover ds label="Как ArchMap разбирает файлы" width={380}>
                  {kind.help(nodeName)}
                </InfoPopover>
              )}
            </div>
            <AgentFiles
              pkg={agent.pkg}
              text="Перетащите сюда файлы от агента"
              over={drop.over}
              dropError={drop.error}
              onRemove={agent.removeFile}
              autofill={kind.autofillKey}
            />
            {agent.pkg.files.length > 0 && (
              <>
                <FactAgentPlan agent={agent} words={kind} />
                <label className="ds-check fact-check" title={kind.overwriteNote}>
                  <input
                    type="checkbox"
                    checked={agent.overwrite}
                    onChange={(e) => agent.setOverwrite(e.target.checked)}
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
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            disabled={!agent.willWrite || agent.applying}
            onClick={agent.apply}
          >
            {agent.applying ? "Применяем" : "Применить"}
          </button>
          <button type="button" className="ds-btn" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
