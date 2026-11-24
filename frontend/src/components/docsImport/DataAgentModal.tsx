// Окно «Описать структуру с помощью ИИ-агента» (BYOA-дозаливка) — только СТРУКТУРА БД.
//
// Третье окно того же семейства (схемы логики — DocsAgentModal, спецификация —
// SpecAgentPanel): сущности не смешиваются, у каждого свой контракт превью/применения.
// Здесь агент читает миграции и ORM-модели, а не рисует диаграммы, поэтому задание одно
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
  // Механика адреса и слияния файлов — за «?»: на виду только то, что нужно для запуска.
  help: (nodeName) => (
    <>
      <p>
        Объект указывается в начале файла строкой «# archmap-node: имя или путь объекта».
        Таблицы из файла без такой строки попадут к объекту «{nodeName}».
      </p>
      <p>
        Уже описанное вручную не меняется, новые файлы только добавляют недостающее. Чтобы
        заменить описанное, отметьте «Заменять уже описанное».
      </p>
      <p>Ничего не удаляется ни при какой настройке. Чего агент не увидел, то останется как есть.</p>
    </>
  ),
  overwriteNote: "По умолчанию уже описанное не меняется, новые файлы только добавляют недостающее.",
  remarksFamily: "структуры",
  remarksItems: "Записи",
  autofillKey: "data-agent-modal-1",
  count: (r) => r.tables.length,
  listTitle: "Таблицы:",
  rows: (r) => r.tables.map((t) => ({
    key: `${t.node_path}#${t.schema_name}.${t.name}`,
    path: t.node_path,
    name: `${t.schema_name ? `${t.schema_name}.` : ""}${t.name}`,
    detail: `колонок ${t.columns}`,
    action: ACTION_LABEL[t.action] ?? t.action,
    overwrite: t.action === "overwrite",
    bad: t.columns === 0 ? "без колонок, проверьте файл" : null,
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
