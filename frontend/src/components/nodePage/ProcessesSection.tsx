// Раздел «Процессы» страницы объекта (аудит F-5: вынесен из NodePage).
import { useEffect, useState } from "react";
import type { ProcessListItem } from "../../types";
import { nodesApi } from "../../api/nodes";
import { DocRow, DocRowLabel } from "../docRow";
import Section from "../../ui/Section";
import "../../ui/ds.css";

// ── Раздел «Процессы» ───────────────────────────────────────────────
// Процессы, в которых участвует узел или его поддерево (GET /nodes/{id}/processes).
// Пустой раздел скрывается вовсе: участие в процессах — не обязательная мета. Строка —
// только имя процесса (редизайн, направление А): число сообщений ничего не говорит о
// роли объекта в процессе.
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
    <Section title="Процессы">
      <div className="ds-rows">
        {items.map((p) => (
          <DocRow key={p.id} onOpen={() => onNavigateProcess?.(p.id)} title={`Открыть процесс «${p.name}»`}>
            <DocRowLabel name={p.name} />
          </DocRow>
        ))}
      </div>
    </Section>
  );
}
