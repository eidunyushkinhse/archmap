// Список «объект: площадки» подтверждения «Разместить контейнер целиком?»
// (placementConflicts): чьё своё размещение снимется. Общий для окна-подтверждения
// режима размещения (DeploymentPage) и второго шага окна «Размещение». Перечень нового
// вида: строка в одну линию, полный текст в подсказке.
import "../../ui/ds.css";
import type { PlacementConflict } from "./placementConflicts";

export default function PlacementConflictList({ items }: { items: readonly PlacementConflict[] }) {
  return (
    <ul className="ds-confirm-list" aria-label="Объекты с другим размещением">
      {items.map((c) => {
        const text = `${c.node.name}: ${c.siteNames.join(", ")}`;
        return <li key={c.node.id} title={text}>{text}</li>;
      })}
    </ul>
  );
}
