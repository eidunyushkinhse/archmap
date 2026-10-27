// Объект окна «Размещение» из узла страницы (docs/tasks/deployment-view.md, Ф3).
// Окно PlacementDialog ждёт DeploymentNode — узел графа развёртывания с instances.
// У NodeResponse есть sites: у объекта — его площадки, у контейнера — площадки его
// объектов (partial — стоит часть); instances контейнера — где стоят все.
import type { DeploymentNode, Node } from "../../types";

export function placementFromNode(node: Node): DeploymentNode {
  return { ...node, instances: node.sites.filter((s) => !s.partial).map((s) => s.id) };
}
