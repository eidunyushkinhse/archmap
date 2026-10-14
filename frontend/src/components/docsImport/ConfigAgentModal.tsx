// Модалка «Описать конфигурацию с помощью ИИ-агента» (BYOA-дозаливка параметров).
//
// Пятое окно того же семейства (схемы логики — DocsAgentModal, спека — SpecAgentPanel,
// структура БД — DataAgentModal, каналы — ChannelsAgentModal): машинерия общая,
// контракт свой. Два отличия, и оба про честность подзаголовка:
//   • владелец однозначен, в отличие от каналов, — параметр читает КОД СЕРВИСА, и
//     промпт гоняют в репозитории этого сервиса, а не «в каждом, кто ходит»;
//   • ЗНАЧЕНИЯ НЕ ЕДУТ. Об этом пользователь должен узнать ДО запуска агента: он
//     собирается натравить модель на репозиторий с `.env`, и вправе знать, что
//     ArchMap хранит только перечень ручек.
//
// Зависимости («какая развилка от ручки зависит») здесь НЕ приезжают: они живут
// пометками «зависит от:» внутри схем логики, то есть окном дозаливки доков.
// Применение НЕ кладётся в undo — страховка та же: превью + дефолт «не перезаписывать».
import type { ConfigImportReport } from "../../types";
import { configImportApi } from "../../api/docsImport";
import { ACTION_LABEL, countAction } from "./agentModalShared";
import FactAgentModal, { type FactAgentKind } from "./FactAgentModal";

const CONFIG: FactAgentKind<ConfigImportReport> = {
  api: configImportApi,
  title: "Описать конфигурацию с помощью ИИ-агента",
  intro: () => (
    <>
      Запустите агента с этим промптом в репозитории сервиса. Агент вернет список
      параметров конфигурации по коду: имена, типы, назначения и дефолты.
    </>
  ),
  overwriteNote: (
    <>
      Если активировать флаг, то параметры с теми же именами будут перезаписаны
      значениями из нового списка, а остальные старые параметры сохранятся. Если
      оставить флаг пустым, то старые параметры сохранятся без изменений, а новые
      будут добавлены к ним.
    </>
  ),
  remarksFamily: "конфигурации",
  remarksItems: "Параметры",
  autofillKey: "config-agent-modal-1",
  count: (r) => r.params.length,
  listTitle: "Параметры:",
  rows: (r) => r.params.map((p) => ({
    key: `${p.node_path}#${p.name}`,
    text: `«${p.node_path}» · ${p.name}${p.value_type ? ` · ${p.value_type}` : ""}${p.required ? " · обяз." : ""}`,
    badge: ACTION_LABEL[p.action] ?? p.action,
    bad: null,
    ok: true,
  })),
  applied: (r) => `параметров ${r.params_written}`,
  summary: (r) => `Параметров: ${r.params.length} (новых ${countAction(r.params, "create")})`,
};

interface Props {
  // Объект, из окна которого открыта дозаливка: к нему уедут параметры без адреса.
  nodeId: string;
  onClose: () => void;
  // Дозаливка применена — родитель перечитывает конфигурацию.
  onApplied: () => void;
}

// Подзаголовок без адресации: владелец однозначен — параметры читает код сервиса.
export default function ConfigAgentModal(props: Props) {
  return <FactAgentModal kind={CONFIG} nodeName="" {...props} />;
}
