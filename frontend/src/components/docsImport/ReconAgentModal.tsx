// Окно «Составить список операций с помощью ИИ-агента» (BYOA) — НУЛЕВОЙ шаг
// документирования монолита.
//
// Окно того же семейства, что схемы логики, спецификация, структура БД и каналы, но
// принимает оно не документацию, а ОГЛАВЛЕНИЕ: агент обходит репозиторий и возвращает
// перечень операций API и фоновых воркеров одним файлом. Строки перечня становятся
// ЗАГЛУШКАМИ (схемами с пустым телом), и дальше документирование идёт по списку:
// адресно, порциями, с видимым остатком (docs/plan-recon.md).
//
// Чего здесь НЕТ намеренно: галочки «Заменять уже описанное» (у потока нет политики
// перезаписи вовсе — применение только создаёт), правок строк превью (перечень правит
// агент, а не человек), выбора языка и режимов «пакетом/по одной».
//
// Вид — новый язык (редизайн, фаза 6г): одна колонка на общем каркасе окна (ui/ds.css,
// ds-win), как окно схем логики. «Задание агенту» со знаком «?» («Зачем нужен список»:
// два вида схем и зачем сначала список — бывшее вступление) и кнопкой задания → «Ответы
// агента» (зона файлов, отчёт по разделам) → футер слева: «Применить», «Отмена», отказ
// применения строкой над ними. Файлы принимает всё окно. Состояние — useReconAgent,
// зона — AgentFiles, отчёт — ReconAgentPlan.
import type { PromptVariant } from "../../types";
import { reconApi } from "../../api/docsImport";
import { useReconAgent } from "./useReconAgent";
import { MAX_FILES } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import AgentFiles from "./AgentFiles";
import ReconAgentPlan from "./ReconAgentPlan";
import PromptCopyButton from "./PromptCopyButton";
import Modal from "../../ui/Modal";
import InfoPopover from "../../ui/InfoPopover";
import { CloseIcon } from "../../ui/icons";
import { copyText } from "../../lib/copyText";
import "../../ui/ds.css";
import "./reconAgent.css";

interface Props {
  // Объект, из окна которого открыт список: к нему уедет перечень без строки node.
  nodeId: string;
  onClose: () => void;
  // Заглушки созданы — родитель перечитывает объект (раздел «Логика»).
  onApplied: () => void;
}

export default function ReconAgentModal({ nodeId, onClose, onApplied }: Props) {
  const agent = useReconAgent(nodeId, () => { onApplied(); onClose(); });
  const drop = useFileDrop({ onFiles: agent.pkg.pickFiles, disabled: agent.pkg.files.length >= MAX_FILES });

  // Запрос задания + запись в буфер В ПРЕДЕЛАХ ЖЕСТА (иначе Chrome отбирает
  // разрешение); «Скопировано» показывает PromptCopyButton.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    return copyText(reconApi.prompt(nodeId, variant).then(({ prompt }) => prompt));
  }

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 640, padding: 0, margin: "8vh auto auto" }}>
      <div className="ds ds-win rcn-win" {...drop.bind}>
        <div className="ds-win-head">
          <h2 className="ds-win-title">Составить список операций с помощью ИИ-агента</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <section className="ds-win-block">
            <div className="ds-win-block-head">
              <h3 className="ds-win-block-title">Задание агенту</h3>
              <InfoPopover label="Зачем нужен список" width={380}>
                <p>
                  Схемы логики бывают двух видов: операции (работают по запросу) и воркеры
                  (работают сами, в фоне или по расписанию). Чтобы агент описал каждую,
                  сначала нужен их список.
                </p>
              </InfoPopover>
            </div>
            <PromptCopyButton ds label="Скопировать задание" copiedLabel="Скопировано" kind="secondary" copy={copyPrompt} />
          </section>

          <section className="ds-win-block">
            <h3 className="ds-win-block-title">Ответы агента</h3>
            <AgentFiles
              pkg={agent.pkg}
              text="Перетащите сюда список операций от агента"
              over={drop.over}
              dropError={drop.error}
              onRemove={agent.removeFile}
              autofill="recon-agent-modal-1"
            />
            {agent.pkg.files.length > 0 && <ReconAgentPlan agent={agent} />}
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
