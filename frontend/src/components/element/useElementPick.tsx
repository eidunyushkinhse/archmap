// Смена элемента архитектуры из свойств объекта (инспектор редактора и страница
// объекта, Р18): превью последствий → окно, если они есть → PATCH. Без последствий
// правка ложится в историю, как смена статуса; с последствиями истории нет (обратное
// действие — та же смена роли). Отказ превью или записи — плашка правок (useNodePatch).
import type { ReactNode } from "react";
import type { NodeElement } from "../../types";
import type { useNodePatch } from "../../pages/useNodePatch";
import { hasConsequences } from "./elementChange";
import { useConsequences } from "./useConsequences";

type NodePatch = ReturnType<typeof useNodePatch>;

export function useElementPick(patch: NodePatch): { pick: (value: NodeElement) => void; dialog: ReactNode } {
  const consequences = useConsequences();
  const pick = (value: NodeElement) => {
    const node = patch.node;
    if (value === node.element_effective) return;
    void (async () => {
      const preview = await patch.previewElement(value);
      if (!preview) return;
      if (!(await consequences.ask(preview, node.name))) return;
      await patch.pickElement(value, !hasConsequences(preview));
    })();
  };
  return { pick, dialog: consequences.dialog };
}
