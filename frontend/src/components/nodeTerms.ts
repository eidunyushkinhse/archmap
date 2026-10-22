// Подписи и порядок терминов узла и схемы — одним местом (аудит F-22). Копии жили на
// странице объекта, в панели свойств, в окне узла и в вопросах ввоза и уже разошлись
// («Брокер» в вопросах против «Брокер сообщений» везде остальном).
import type { NodeApproval, NodeDocKind, NodeShape, NodeStatus } from "../types";

export const SHAPE_LABEL: Record<NodeShape, string> = {
  service: "Сервис",
  database: "База данных",
  broker: "Брокер сообщений",
  person: "Пользователь",
};

// Порядок типов в выпадашках — от самого частого (сервис) к самому редкому.
export const SHAPE_ORDER: NodeShape[] = ["service", "database", "broker", "person"];

export const STATUS_ORDER: NodeStatus[] = ["existing", "planned", "deprecated"];

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
