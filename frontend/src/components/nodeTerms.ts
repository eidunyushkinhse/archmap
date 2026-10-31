// Подписи и порядок терминов узла и схемы — одним местом (аудит F-22). Копии жили на
// странице объекта, в панели свойств, в окне узла и в вопросах ввоза и уже разошлись
// («Брокер» в вопросах против «Брокер сообщений» везде остальном).
import type {
  Node, NodeApproval, NodeDocKind, NodeElement, NodeShape, NodeStatus, SiteKind, VersionCategory,
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

// Тип объекта в интерфейсе (Р35 раздела 13 docs/plan-c4-elements.md) — проекция формы и
// действующего элемента: первые три — сервис с элементом «система», «контейнер» или
// «компонент». В файлах YAML и в MCP словарь прежний: shape: service и поле element.
// Элемент считает сервер (element_effective); здесь только его название.
export type NodeType = "system" | "container" | "component" | "database" | "broker" | "person";
export const TYPE_ORDER: NodeType[] = ["system", "container", "component", "database", "broker", "person"];
export const TYPE_LABEL: Record<NodeType, string> = {
  system: "Система",
  container: "Контейнер",
  component: "Компонент",
  database: "База данных",
  broker: "Брокер",
  person: "Пользователь",
};
// Подпись значения строки «Тип» у внешнего объекта (Р42, 2026-10-31): тип тот же, меняется
// только слово — чужой продукт по C4 внешняя система или внешний контейнер. У базы,
// брокера и пользователя подпись прежняя.
export const EXTERNAL_TYPE_LABEL: Partial<Record<NodeType, string>> = {
  system: "Внешняя система",
  container: "Внешний контейнер",
};
// Вторая строка пункта поля «Тип»: простыми словами, без слов C4 сверх названий.
export const TYPE_HINT: Record<NodeType, string> = {
  system: "Группа контейнеров: сама не запускается",
  container: "Одно приложение, которое запускается целиком",
  component: "Часть кода контейнера, отдельно не запускается",
  database: "Хранилище: таблицы и колонки",
  broker: "Очереди и каналы сообщений",
  person: "Человек или внешняя роль",
};

// Тип объекта по ответу сервера. У сервиса действующий элемент задан всегда (с пустой
// системой, Р39); null бывает только у «Пользователя» — запасной путь «контейнер» для
// чужих данных, где поля нет.
export function typeOf(node: Pick<Node, "shape" | "element_effective">): NodeType {
  if (node.shape !== "service") return node.shape;
  return node.element_effective ?? "container";
}

// Форма, которой тип записывается в модели: система, контейнер и компонент — сервис.
export function shapeOfType(type: NodeType): NodeShape {
  return type === "database" || type === "broker" || type === "person" ? type : "service";
}

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
