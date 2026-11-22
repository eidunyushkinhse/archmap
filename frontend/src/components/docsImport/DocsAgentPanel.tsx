// Панель дозаливки схем логики от агента (BYOA) прежнего вида: файлы пакета, живое
// превью, отчёт и применение одной колонкой. Живёт в окне одной схемы (DocOverlay →
// «Изменить → Через ИИ-агента», режим «doc»): пакет ОБНОВЛЯЕТ открытую схему. Окно
// «Описать схемы логики с помощью ИИ-агента» собрано на новом языке из того же состояния
// (DocsAgentModal); режимы «Пакетом» и «По одной схеме» панель держит для него же.
// Промпт и его параметры — забота окна (левая колонка), панели они не нужны.
//
// Разрез по ответственности (редизайн, фаза 6в): состояние пакета, превью и применения —
// useDocsAgent, отчёт — DocsAgentReport, здесь только сборка и кнопки применения.
import { useDocsAgent } from "./useDocsAgent";
import type { DocsAgentPanelMode } from "./useDocsAgent";
import { rightCol, radioRow, footRow } from "./agentModalShared";
import AgentPackageInput from "./AgentPackageInput";
import DocsAgentReport from "./DocsAgentReport";
import { primaryBtn, secondaryBtn } from "../../ui/styles";

interface Props {
  // Узел, для которого агент готовит документы (скоуп превью и применения).
  nodeId: string;
  mode: DocsAgentPanelMode;
  // Пакет применён. more=true — «Добавить ещё» (режим «по одной»): окно остаётся
  // открытым, адрес следующей точки входа очищает окно, пакет панель очищает сама.
  onApplied: (more: boolean) => void;
}

export default function DocsAgentPanel({ nodeId, mode, onApplied }: Props) {
  const agent = useDocsAgent(nodeId, mode, onApplied);
  const { pkg, docName, willWrite, applying, apply } = agent;
  const applyStyle = { ...primaryBtn, opacity: willWrite && !applying ? 1 : 0.55 };

  return (
    <div style={rightCol}>
      <AgentPackageInput
        pkg={pkg}
        onRemove={agent.removeFile}
        dropText={
          docName !== null
            ? "Перетащите сюда файл схемы, который подготовил агент, или нажмите, чтобы выбрать его на диске. Содержимое можно и вставить текстом."
            : "Перетащите сюда файлы схем, которые создал агент, или нажмите, чтобы выбрать их на диске. Схему можно и вставить текстом."
        }
        pasteTitle="Добавить схему вставкой текста"
      />

      {/* Отчёт превью / применения */}
      <DocsAgentReport agent={agent} />

      <div style={footRow}>
        {docName === null && (
          <label
            style={{ ...radioRow, marginRight: "auto" }}
            title="Если в ArchMap уже есть схема с таким именем, новая по умолчанию пропускается. Отметьте, чтобы новые схемы заменяли старые"
          >
            <input type="checkbox" checked={agent.overwriteFlag} onChange={(e) => agent.setOverwriteFlag(e.target.checked)} />
            Заменять уже описанное
          </label>
        )}
        {mode.kind === "single" ? (
          <>
            {/* Главная кнопка слева, вторичная правее (правило окон владельца). */}
            <button type="button" style={applyStyle} disabled={!willWrite || applying} onClick={() => apply(false)}>
              {applying ? "Применяем" : "Добавить"}
            </button>
            <button
              type="button"
              style={{ ...secondaryBtn, opacity: willWrite && !applying ? 1 : 0.55 }}
              disabled={!willWrite || applying}
              title="Применить и подготовить поля к следующему воркеру/эндпоинту"
              onClick={() => apply(true)}
            >
              Добавить ещё
            </button>
          </>
        ) : (
          <button
            type="button"
            style={{ ...applyStyle, marginLeft: docName !== null ? "auto" : undefined }}
            disabled={!willWrite || applying}
            onClick={() => apply(false)}
          >
            {applying ? "Применяем" : "Применить"}
          </button>
        )}
      </div>
    </div>
  );
}
