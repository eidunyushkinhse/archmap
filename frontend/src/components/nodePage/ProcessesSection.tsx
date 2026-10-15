// Секция «Участвует в процессах» страницы объекта (аудит F-5: вынесена из NodePage).
import { useEffect, useState } from "react";
import type { ProcessListItem } from "../../types";
import { nodesApi } from "../../api/nodes";
import { DocRowLabel } from "../docRow";
import { plural } from "../../ui/plural";

// ── Секция «Участвует в процессах» ─────────────────────────────────
// Процессы, в которых участвует узел или его поддерево (GET /nodes/{id}/processes).
// Пустая секция скрывается вовсе: участие в процессах — не обязательная мета.
export default function ProcessesSection({ nodeId, onNavigateProcess }: {
  nodeId: string;
  onNavigateProcess?: (processId: string) => void;
}) {
  const [items, setItems] = useState<ProcessListItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    nodesApi.getNodeProcesses(nodeId)
      .then((ps) => { if (alive) setItems(ps); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [nodeId]);
  if (!items || items.length === 0) return null;
  return (
    <div className="np-card">
      <h3 className="np-card-title">Участвует в процессах</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((p) => (
          <button
            key={p.id}
            className="np-doc-row"
            onClick={() => onNavigateProcess?.(p.id)}
            title={`Открыть процесс «${p.name}»`}
          >
            <DocRowLabel
              name={p.name}
              note={`${p.message_count} ${plural(p.message_count, ["сообщение", "сообщения", "сообщений"])}`}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
