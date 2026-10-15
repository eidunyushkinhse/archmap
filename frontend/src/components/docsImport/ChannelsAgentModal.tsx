// Модалка «Описать каналы с помощью ИИ-агента» (BYOA-дозаливка каналов брокера).
//
// Четвёртое окно того же семейства (схемы логики — DocsAgentModal, спека —
// SpecAgentPanel, структура БД — DataAgentModal): машинерия общая, контракт свой.
// Отличие от соседа по структуре — не в интерфейсе, а в честности подзаголовка: у
// брокера НЕТ репозитория-владельца, и промпт гоняют в КАЖДОМ репозитории, который
// ходит в брокер. Пользователь должен узнать это здесь, а не после первого пустого
// пакета, — иначе он запустит агента один раз «где-то» и решит, что фича не работает.
//
// Обращений («кто публикует / кто потребляет») здесь НЕТ: они приезжают пометками
// «публикует:/потребляет:» внутри схем логики, то есть окном дозаливки доков.
// Применение НЕ кладётся в undo — страховка та же: превью + дефолт «не перезаписывать».
import type { ChannelsImportReport } from "../../types";
import { channelsImportApi } from "../../api/docsImport";
import { ACTION_LABEL, countAction } from "./agentModalShared";
import FactAgentModal, { type FactAgentKind } from "./FactAgentModal";

const CHANNELS: FactAgentKind<ChannelsImportReport> = {
  api: channelsImportApi,
  title: "Описать каналы с помощью ИИ-агента",
  intro: (nodeName) => (
    <>
      У брокера нет «репозитория-владельца»: топики объявлены в коде тех, кто их
      публикует и потребляет. Запускайте агента с этим промптом в КАЖДОМ репозитории,
      который ходит в брокер, — пакеты доливаются друг к другу. Каналы из файла без
      адреса «# archmap-node:» приедут к объекту «{nodeName}».
    </>
  ),
  overwriteNote: (
    <>
      По умолчанию описанное раньше — вручную или пакетом другого репозитория —
      не трогается: пакет только добавляет недостающее, а расхождение меты
      попадает в замечания. Удалений нет ни при какой настройке: чего агент не
      увидел, то останется как есть.
    </>
  ),
  remarksFamily: "каналов",
  remarksItems: "Каналы и поля",
  autofillKey: "channels-agent-modal-1",
  count: (r) => r.channels.length,
  listTitle: "Каналы:",
  rows: (r) => r.channels.map((c) => ({
    key: `${c.node_path}#${c.group_name}.${c.name}`,
    text: `«${c.node_path}» · ${c.group_name ? `${c.group_name}.` : ""}${c.name} · полей ${c.fields}`,
    badge: ACTION_LABEL[c.action] ?? c.action,
    bad: c.fields === 0 ? "без полей — проверьте файл" : null,
    ok: c.fields > 0,
  })),
  applied: (r) => `каналов ${r.channels_written}, полей ${r.fields_written}`,
  summary: (r) => `Каналов: ${r.channels.length} (новых ${countAction(r.channels, "create")})`,
};

interface Props {
  // Объект, из окна которого открыта дозаливка: к нему уезжают каналы без адреса.
  nodeId: string;
  nodeName: string;
  onClose: () => void;
  // Дозаливка применена — родитель перечитывает каналы.
  onApplied: () => void;
}

export default function ChannelsAgentModal(props: Props) {
  return <FactAgentModal kind={CHANNELS} {...props} />;
}
