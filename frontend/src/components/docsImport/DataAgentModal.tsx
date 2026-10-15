// Модалка «Структура от агента» (BYOA-дозаливка) — только СТРУКТУРА БД.
//
// Третье окно того же семейства (схемы логики — DocsAgentModal, спека —
// SpecAgentPanel): сущности не смешиваются, у каждого свой контракт превью/применения.
// Здесь агент читает миграции и ORM-модели, а не рисует диаграммы, поэтому промпт один
// и без параметров — ни языка подписей, ни режимов «пакетом/по одной» тут нет.
//
// Обращений к данным здесь НЕТ (пивот §9 plan-db-docs.md): они приезжают пометками
// «читает:/пишет:» внутри схем логики, то есть окном дозаливки доков.
//
// Ручной ввод для базы с сорока таблицами непригоден, так что это основной путь
// наполнения структуры; редактор на странице базы остаётся для правок.
// Применение НЕ кладётся в undo — страховка та же: превью + дефолт «не перезаписывать».
import type { DataImportReport } from "../../types";
import { dataImportApi } from "../../api/docsImport";
import { ACTION_LABEL, countAction } from "./agentModalShared";
import FactAgentModal, { type FactAgentKind } from "./FactAgentModal";

const DATA: FactAgentKind<DataImportReport> = {
  api: dataImportApi,
  title: "Описать структуру с помощью ИИ-агента",
  intro: (nodeName) => (
    <>
      Агент прочитает миграции и ORM-модели репозитория и опишет таблицы и колонки.
      Таблицы из файла без адреса «# archmap-node:» приедут к объекту «{nodeName}».
      Скопируйте промпт, запустите агента и загрузите сюда полученные файлы.
    </>
  ),
  overwriteNote: (
    <>
      По умолчанию описанное вручную не трогается — пакет только добавляет
      недостающее. Удалений нет ни при какой настройке: чего агент не увидел, то
      останется как есть.
    </>
  ),
  remarksFamily: "данных",
  remarksItems: "Записи",
  autofillKey: "data-agent-modal-1",
  count: (r) => r.tables.length,
  listTitle: "Таблицы:",
  rows: (r) => r.tables.map((t) => ({
    key: `${t.node_path}#${t.schema_name}.${t.name}`,
    text: `«${t.node_path}» · ${t.schema_name ? `${t.schema_name}.` : ""}${t.name} · колонок ${t.columns}`,
    badge: ACTION_LABEL[t.action] ?? t.action,
    bad: t.columns === 0 ? "без колонок — проверьте файл" : null,
    ok: t.columns > 0,
  })),
  applied: (r) => `таблиц ${r.tables_written}, колонок ${r.columns_written}`,
  summary: (r) => `Таблиц: ${r.tables.length} (новых ${countAction(r.tables, "create")})`,
};

interface Props {
  // Объект, из окна которого открыта дозаливка: к нему уезжают записи без адреса.
  nodeId: string;
  nodeName: string;
  onClose: () => void;
  // Дозаливка применена — родитель перечитывает структуру.
  onApplied: () => void;
}

export default function DataAgentModal(props: Props) {
  return <FactAgentModal kind={DATA} {...props} />;
}
