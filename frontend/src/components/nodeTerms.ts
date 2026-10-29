// Подписи и порядок терминов узла и схемы — одним местом (аудит F-22). Копии жили на
// странице объекта, в панели свойств, в окне узла и в вопросах ввоза и уже разошлись
// («Брокер» в вопросах против «Брокер сообщений» везде остальном).
import type {
  NodeApproval, NodeDocKind, NodeElement, NodeShape, NodeStatus, SiteKind, VersionCategory,
  VersionItemStatus,
} from "../types";

export const SHAPE_LABEL: Record<NodeShape, string> = {
  service: "Сервис",
  database: "База данных",
  broker: "Брокер сообщений",
  person: "Пользователь",
};

// Элемент архитектуры словами — зеркало NODE_ELEMENT_LABELS бэка (domain_types).
export const ELEMENT_LABEL: Record<NodeElement, string> = {
  system: "Система",
  container: "Контейнер",
};

// Порядок типов в выпадашках — от самого частого (сервис) к самому редкому.
export const SHAPE_ORDER: NodeShape[] = ["service", "database", "broker", "person"];

export const STATUS_ORDER: NodeStatus[] = ["existing", "planned", "deprecated"];

// Вид площадки развёртывания (docs/tasks/deployment-view.md): выпадашки окон
// «Размещение» и «Площадки». Порядок — от облака к «другому» (ЦОД, стойка).
export const SITE_KIND_LABEL: Record<SiteKind, string> = {
  cloud: "Облако",
  kubernetes: "Kubernetes",
  vm: "Виртуальная машина",
  physical: "Физический сервер",
  other: "Другое",
};
export const SITE_KIND_ORDER: SiteKind[] = ["cloud", "kubernetes", "vm", "physical", "other"];

// Статус СТРАНИЦЫ объекта (docs/tasks/page-status.md) — пилюля у имени на странице.
// Подсказка — вторая строка пункта выпадашки у листа.
export const APPROVAL_LABEL: Record<NodeApproval, string> = {
  in_progress: "В работе",
  approved: "Согласовано",
};
export const APPROVAL_HINT: Record<NodeApproval, string> = {
  in_progress: "страница ещё правится",
  approved: "проверено редактором",
};
export const APPROVAL_ORDER: NodeApproval[] = ["in_progress", "approved"];

// Вид схемы логики в окнах, где его выбирают из списка. Строчная метка у имени схемы —
// своя, в docsList.ts.
export const DOC_KIND_LABEL: Record<NodeDocKind, string> = {
  operation: "Операция",
  worker: "Воркер",
};
export const DOC_KIND_ORDER: NodeDocKind[] = ["operation", "worker"];

// Категории дельты версий документации (docs/tasks/doc-versions.md §4, §7) — одна запись
// на категорию: подпись в списке элементов, форма внутри фразы «Есть изменения с v3:
// схема логики «Создать заказ», конфигурация» и слова статуса элемента в роде того, что
// элемент называет (объект, связь, схема, таблица, канал, процесс). Конфигурация — один
// элемент на объект, её добавленный или удалённый параметр — тоже «изменена» (подробность
// — в summary); размещение — тоже один элемент на объект: «указано» (своего не было),
// «снято» (своего не осталось), «изменено»; статус страницы бывает только изменён.
interface VersionCategoryTerms {
  label: string;
  inline: string;
  status: Record<VersionItemStatus, string>;
}

const MASC: Record<VersionItemStatus, string> = { added: "новый", removed: "удалён", changed: "изменён" };
const FEM: Record<VersionItemStatus, string> = { added: "новая", removed: "удалена", changed: "изменена" };

export const VERSION_CATEGORY: Record<VersionCategory, VersionCategoryTerms> = {
  props: { label: "Свойства", inline: "свойства", status: MASC },
  edges: { label: "Связи", inline: "связь", status: FEM },
  doc: { label: "Схема логики", inline: "схема логики", status: FEM },
  spec: { label: "OpenAPI", inline: "OpenAPI", status: FEM },
  db: { label: "Структура БД", inline: "таблица", status: FEM },
  channels: { label: "Каналы", inline: "канал", status: MASC },
  config: {
    label: "Конфигурация",
    inline: "конфигурация",
    status: { added: "изменена", removed: "изменена", changed: "изменена" },
  },
  placement: {
    label: "Размещение",
    inline: "размещение",
    status: { added: "указано", removed: "снято", changed: "изменено" },
  },
  approval: {
    label: "Статус страницы",
    inline: "статус страницы",
    status: { added: "изменён", removed: "изменён", changed: "изменён" },
  },
  process: { label: "Процесс", inline: "процесс", status: MASC },
};
