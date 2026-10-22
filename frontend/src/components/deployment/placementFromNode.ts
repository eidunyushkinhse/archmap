// Объект окна «Размещение» из узла страницы (docs/tasks/deployment-view.md, Ф3).
// Окно PlacementDialog ждёт DeploymentNode — узел графа развёртывания со СВОИМИ
// экземплярами (instances) и действующими (effective). У NodeResponse есть только
// действующее размещение (sites), но своё из него выводится без запроса: у объекта со
// своими экземплярами действуют ровно они (inherited_from_id пуст у всех), иначе все
// строки унаследованы от одного предка и своих нет.
import type { DeploymentNode, Node } from "../../types";

export function placementFromNode(node: Node): DeploymentNode {
  return {
    ...node,
    instances: node.sites.filter((s) => !s.inherited_from_id).map((s) => s.id),
    effective: node.sites.map((s) => ({ site_id: s.id, inherited_from_id: s.inherited_from_id ?? null })),
  };
}
