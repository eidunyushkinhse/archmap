// Подписи и порядок терминов узла и схемы — одним местом (аудит F-22). Копии жили на
// странице объекта, в панели свойств, в окне узла и в вопросах ввоза и уже разошлись
// («Брокер» в вопросах против «Брокер сообщений» везде остальном).
import type { NodeDocKind, NodeShape, NodeStatus } from "../types";

export const SHAPE_LABEL: Record<NodeShape, string> = {
  service: "Сервис",
  database: "База данных",
  broker: "Брокер сообщений",
  person: "Пользователь",
};

// Порядок типов в выпадашках — от самого частого (сервис) к самому редкому.
export const SHAPE_ORDER: NodeShape[] = ["service", "database", "broker", "person"];

export const STATUS_ORDER: NodeStatus[] = ["existing", "planned", "deprecated"];

// Вид схемы логики в окнах, где его выбирают из списка. Строчная метка у имени схемы —
// своя, в docsList.ts.
export const DOC_KIND_LABEL: Record<NodeDocKind, string> = {
  operation: "Операция",
  worker: "Воркер",
};
export const DOC_KIND_ORDER: NodeDocKind[] = ["operation", "worker"];
