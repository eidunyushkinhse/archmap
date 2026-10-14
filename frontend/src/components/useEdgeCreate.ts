// Создание связи из поповеров жеста: прямой (EdgeQuickCreate — концы заданы жестом) и
// межуровневой (CrossLevelEdgePicker — дальний конец выбирают в дереве). Поля, запрос и
// отказы у них были копиями (аудит F-15); выбор концов у каждого окна свой.
import { useState } from "react";
import type { Edge } from "../types";
import { edgesApi } from "../api/nodes";
import { limitMessage } from "./demo/demoLimits";
import type { LimitMessage } from "./demo/demoLimits";

export function useEdgeCreate(onCreated: (created: Edge) => void) {
  const [label, setLabel] = useState("");
  const [technology, setTechnology] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Демо-стенд: проект упёрся в предел связей или объёма текста.
  const [limit, setLimit] = useState<LimitMessage | null>(null);

  async function create(sourceId: string, targetId: string): Promise<void> {
    setSaving(true);
    setError(null);
    setLimit(null);
    try {
      const created = await edgesApi.create({
        source_id: sourceId,
        target_id: targetId,
        label: label || null,
        technology: technology || null,
      });
      onCreated(created);
    } catch (e: unknown) {
      const refusal = limitMessage(e, "edge");
      if (refusal) setLimit(refusal);
      else setError(e instanceof Error ? e.message : "Ошибка создания связи");
    } finally {
      setSaving(false);
    }
  }

  return { label, setLabel, technology, setTechnology, saving, error, setError, limit, create };
}
