// Список «объект: площадки» подтверждения «Разместить контейнер целиком?»
// (placementConflicts): чьё своё размещение снимется. Общий для окна-подтверждения
// режима размещения (DeploymentPage) и второго шага окна «Размещение».
import { confirmList, confirmListBox } from "../../ui/styles";
import type { PlacementConflict } from "./placementConflicts";

export default function PlacementConflictList({ items }: { items: readonly PlacementConflict[] }) {
  return (
    <div style={confirmListBox}>
      <ul style={confirmList} aria-label="Объекты с другим размещением">
        {items.map((c) => (
          <li key={c.node.id}>{c.node.name}: {c.siteNames.join(", ")}</li>
        ))}
      </ul>
    </div>
  );
}
