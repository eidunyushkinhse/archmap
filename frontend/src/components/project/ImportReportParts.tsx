// Общие строки отчётов применения ввоза: создание проекта (CreateProjectDialog) и
// догрузка архивов (ImportIntoModal). Шапка и счётчики узлов, доков и параметров у
// окон свои (у догрузки — «дополнено» и «заменено»), а факты, процессы и хвост
// отчёта были копиями (аудит F-16).
import type { ArchiveImportResult } from "../../types";
import { UnfixableFold } from "./remainder";

type Facts = Pick<ArchiveImportResult, "db" | "channels" | "channel_stubs">;
type Tail = Pick<ArchiveImportResult, "processes" | "resolved_conflicts" | "unfixable">;

// Таблицы БД, каналы брокеров и каналы, заведённые по связям схемы.
export function FactLines({ result }: { result: Facts }) {
  return (
    <>
      {result.db && <div>Таблиц БД: {result.db.tables_written}</div>}
      {result.channels && <div>Каналов брокеров: {result.channels.channels_written}</div>}
      {result.channel_stubs > 0 && (
        <div>Каналов брокеров заведено по связям схемы: {result.channel_stubs} (без описания)</div>
      )}
    </>
  );
}

// Процессы с привязками шагов, разрешённые споры и то, что придётся поправить руками.
export function ReportTail({ result }: { result: Tail }) {
  const linked = result.processes.reduce((s, p) => s + p.doc_linked, 0);
  const unresolved = result.processes.reduce((s, p) => s + p.doc_unresolved, 0);
  return (
    <>
      {result.processes.length > 0 && (
        <div>
          Процессов: {result.processes.length} · привязок шагов: {linked}
          {unresolved > 0 && (
            <span style={{ color: "#b45309" }}> · не разрешилось: {unresolved}</span>
          )}
        </div>
      )}
      {/* Споры рассудил пользователь — говорим об этом вслух: выбор был, и он учтён. */}
      {result.resolved_conflicts > 0 && (
        <div>Разрешено споров содержимого: {result.resolved_conflicts}</div>
      )}
      {/* Сырого списка «Замечания» нет (Ф2г-2): информация о сделанном видна по
          счётчикам выше, а то, что требует рук, — пунктами той же свёртки, что в
          превью. Сырые строки (result.warnings) остаются в ответе для MCP. */}
      <UnfixableFold items={result.unfixable} after />
    </>
  );
}
