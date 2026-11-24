// Стадия «Через ИИ-агента» окна документа (DocOverlay): у схемы логики и у спецификации
// OpenAPI. Вид — новый язык (редизайн, фаза 7в), образец — окна «Описать схемы логики с
// помощью ИИ-агента» и окна фактов: одна колонка 640 px на каркасе окна (ui/ds.css, ds-win)
// в порядке действий. Шапка (имя объекта тихим цветом, название, крестик) → «Задание агенту»
// («Скопировать задание») → «Ответы агента» (общая зона файлов AgentFiles, отчёт превью под
// ней вместе с файлом) → подвал слева: «Применить», «Отмена», отказ применения строкой над
// ними. Файлы принимает всё окно. Инструкции шагами и примечания под окном нет.
//
// Это тот же <dialog> окна документа: стадия рисует себя корнем .doc-agentwin, и окно
// сужается селектором :has() по этому корню (docOverlay.css). При возврате к чтению корня
// нет, и окно снова большое; вложенного окна и пересоздания нет.
//
// Состояние пакета, превью и применения — хуки docsImport: у схемы useDocsAgent в режиме
// «doc» (пакет ОБНОВЛЯЕТ открытую схему), отчёт — DocsAgentPlan того же окна 6в; у
// спецификации useSpecAgent и отчёт SpecAgentPlan на тех же классах. Стадия монтируется
// заново при каждом входе: пакет прошлого захода в окно не возвращается.
//
// Компоненты объявлены на верхнем уровне модуля: объявленный внутри другого ремаунтится
// каждый рендер (ловушка проекта).
import type { ReactNode } from "react";
import type { PromptVariant } from "../../types";
import type { DocsFilesApi } from "../docsImport/useDocsFiles";
import { MAX_FILES } from "../docsImport/useDocsFiles";
import { useFileDrop } from "../docsImport/useFileDrop";
import { useDocsAgent } from "../docsImport/useDocsAgent";
import { useSpecAgent } from "../docsImport/useSpecAgent";
import AgentFiles from "../docsImport/AgentFiles";
import DocsAgentPlan from "../docsImport/DocsAgentPlan";
import SpecAgentPlan from "../docsImport/SpecAgentPlan";
import PromptCopyButton from "../docsImport/PromptCopyButton";
import MermaidRenderer from "../MermaidRenderer";
import { CloseIcon } from "../../ui/icons";
import "../../ui/ds.css";
import "./docOverlay.css";

/** Общее у стадии обоих документов: что рисует каркас окна. */
interface StageWindowProps {
  objectName: string;
  /** Название документа: имя схемы или «OpenAPI». */
  title: string;
  /** Строка предупреждения от страницы (конфликт сессий) — над блоками. */
  notice?: string | null;
  /** Крестик: окно само решит, спросить ли о несохранённом (в этой стадии не спросит). */
  onClose: () => void;
  copy: (variant: PromptVariant) => Promise<void>;
  pkg: DocsFilesApi;
  onRemove: (i: number) => void;
  /** Строка в зоне файлов: что сюда класть. */
  zoneText: string;
  /** Ключ имени поля вставки для noAutofill. */
  autofill: string;
  /** Отчёт превью под зоной; показывается вместе с файлами. */
  report: ReactNode;
  applyError: string | null;
  canApply: boolean;
  applying: boolean;
  onApply: () => void;
  /** «Отмена»: к чтению, а если читать нечего — закрыть окно. */
  onCancel: () => void;
}

function AgentStageWindow({
  objectName, title, notice, onClose, copy, pkg, onRemove, zoneText, autofill, report,
  applyError, canApply, applying, onApply, onCancel,
}: StageWindowProps) {
  const drop = useFileDrop({ onFiles: pkg.pickFiles, disabled: pkg.files.length >= MAX_FILES });
  return (
    <div className="ds-win doc-agentwin" {...drop.bind}>
      {/* Шапка как у окна документа: имя объекта тихим цветом и название в одну строку. */}
      <div className="ds-win-head doc-agenthead">
        <span className="doc-headobj" title={objectName}>{objectName}</span>
        <h2 className="ds-win-title doc-headtitle" title={title}>{title}</h2>
      </div>
      <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
        <CloseIcon />
      </button>

      <div className="ds-win-body">
        {notice && <p className="ds-warn doc-agentnotice" role="status">{notice}</p>}
        <section className="ds-win-block">
          <h3 className="ds-win-block-title">Задание агенту</h3>
          <PromptCopyButton label="Скопировать задание" copiedLabel="Скопировано" kind="secondary" copy={copy} />
        </section>

        <section className="ds-win-block">
          <h3 className="ds-win-block-title">Ответы агента</h3>
          <AgentFiles
            pkg={pkg}
            text={zoneText}
            over={drop.over}
            dropError={drop.error}
            onRemove={onRemove}
            autofill={autofill}
          />
          {pkg.files.length > 0 && report}
        </section>
      </div>

      {/* Главная кнопка первой, «Отмена» за ней (правило окон владельца). */}
      <div className="ds-win-foot">
        {applyError && <p className="ds-danger ds-win-err" role="alert">{applyError}</p>}
        <button type="button" className="ds-btn ds-btn--primary" disabled={!canApply} onClick={onApply}>
          {applying ? "Применяем" : "Применить"}
        </button>
        <button type="button" className="ds-btn" onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}

/** Стадия агента у схемы логики: пакет обновляет открытую схему (имя — её). */
export function FlowchartAgentStage({ nodeId, nodeName, docName, copy, onClose, onCancel, onApplied }: {
  nodeId: string;
  nodeName: string;
  /** Схема, которую обновляет пакет: её имя уходит в превью и применение. */
  docName: string;
  copy: (variant: PromptVariant) => Promise<void>;
  onClose: () => void;
  onCancel: () => void;
  /** Пакет записан: окно перечитывает схему и возвращается к чтению. */
  onApplied: () => void;
}) {
  const agent = useDocsAgent(nodeId, { kind: "doc", docName }, () => onApplied());
  const { incoming } = agent;
  return (
    <AgentStageWindow
      objectName={nodeName}
      title={docName}
      onClose={onClose}
      copy={copy}
      pkg={agent.pkg}
      onRemove={agent.removeFile}
      zoneText="Перетащите сюда файл схемы от агента"
      autofill="flowchart-agent-paste"
      report={
        <>
          <DocsAgentPlan agent={agent} />
          {/* Что изменится: рисунок схемы, которую получит окно, до применения. */}
          {!agent.checking && incoming !== null && incoming.mermaid.trim() !== "" && (
            <div className="doc-incoming">
              <MermaidRenderer chart={incoming.mermaid} />
            </div>
          )}
        </>
      }
      applyError={agent.applyError}
      canApply={agent.willWrite && !agent.applying}
      applying={agent.applying}
      onApply={() => agent.apply(false)}
      onCancel={onCancel}
    />
  );
}

/** Стадия агента у спецификации: спецификация у объекта одна, перезапись всегда. */
export function SpecAgentStage({ nodeId, nodeName, notice, copy, onClose, onCancel, onApplied }: {
  nodeId: string;
  nodeName: string;
  /** Конфликт с другой сессией от страницы. */
  notice?: string | null;
  copy: (variant: PromptVariant) => Promise<void>;
  onClose: () => void;
  /** «Отмена»: к чтению; спецификации у объекта нет — окно закрывается. */
  onCancel: () => void;
  /** Спецификация записана: окно перечитывает её и возвращается к чтению. */
  onApplied: () => void;
}) {
  const agent = useSpecAgent(nodeId, onApplied);
  return (
    <AgentStageWindow
      objectName={nodeName}
      title="OpenAPI"
      notice={notice}
      onClose={onClose}
      copy={copy}
      pkg={agent.pkg}
      // Снятие файла — как в прежней панели: отчёт прячется производно, без уборки.
      onRemove={agent.pkg.removeFile}
      zoneText="Перетащите сюда файл спецификации от агента"
      autofill="spec-agent-paste"
      report={<SpecAgentPlan agent={agent} />}
      applyError={agent.applyError}
      canApply={agent.willWrite && !agent.applying}
      applying={agent.applying}
      onApply={agent.apply}
      onCancel={onCancel}
    />
  );
}
