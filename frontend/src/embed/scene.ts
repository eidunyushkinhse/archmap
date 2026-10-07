// Сцена живой схемы лендинга: снимок графа уровня и составы контейнеров. Генератор
// scripts/landing-embed-scene.mjs пишет её в scene.gen.ts в том же контракте, что
// отдаёт бэкенд (GraphResponse, NodeResponse), поэтому холст получает её как есть.
import type { AncestorRef, GraphResponse, Node } from "../types";

export interface LandingScene {
  // Откуда снят снимок: подпись генерата и отладка
  source: { project: string; focus: string | null };
  // Граф уровня: context-graph страницы объекта либо граф корня
  graph: GraphResponse;
  // Структурный контейнер уровня: у страницы объекта — parent_id фокуса, у корня — null
  containerId: string | null;
  // Вид раскладки страницы объекта (id фокуса); у корня не задан
  layoutViewId?: string;
  // Предки уровня (корень → непосредственный родитель): подписи вложенных рамок
  ancestors: AncestorRef[];
  // Прямые дети каждого контейнера проекта: ответы GET /nodes?parent_id=
  children: Record<string, Node[]>;
}
