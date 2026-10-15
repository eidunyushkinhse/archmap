import type { Node } from "../../types";
import type { DocStage } from "../inspector/OpenApiPane";

// Что открыть в окне документации страницы объекта. `child` задан, когда открываем
// доку/спеку РЕБЁНКА прямо со страницы контейнера (из объединённого списка) — тогда
// окно работает в контексте ребёнка (его id/имя/спека), а не контейнера. create — новая
// схема («+ Добавить → Вручную» в «Логике»), stage — с чего открыть окно спеки
// («+ Добавить → Вручную / Через ИИ-агента» в «OpenAPI»).
export interface DocTarget {
  mode: "flowchart" | "openapi";
  docId?: string;
  create?: boolean;
  stage?: DocStage;
  child?: Node;
}
