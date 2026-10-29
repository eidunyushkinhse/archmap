// Смена элемента архитектуры из свойств объекта (инспектор редактора и страница
// объекта, Р18): превью последствий → окно, если они есть → PATCH. Без последствий
// правка ложится в историю, как смена статуса; с последствиями истории нет (обратное
// действие — та же смена роли). Отказ превью или записи — плашка правок (useNodePatch).
import type { ReactNode } from "react";
import type { Node, NodeElement } from "../../types";
import type { useNodePatch } from "../../pages/useNodePatch";
import { ELEMENT_LABEL } from "../nodeTerms";
import { hasConsequences } from "./elementChange";
import { useConsequences } from "./useConsequences";

type NodePatch = ReturnType<typeof useNodePatch>;

// Что показывает строка «Элемент архитектуры»: выбор (узел с детьми, редактор), текст
// или ничего («Пользователь» — сам элемент C4 Person, строки нет).
export type ElementView =
  | { kind: "none" }
  | { kind: "pick"; value: NodeElement }
  | { kind: "text"; text: string };

export function elementView(node: Node, canEdit: boolean): ElementView {
  const effective = node.element_effective;
  if (effective === null) return { kind: "none" };
  if (effective === "component") {
    return {
      kind: "text",
      text: node.container_name ? `Компонент контейнера «${node.container_name}»` : "Компонент",
    };
  }
  // Лист — контейнер при любом хранимом значении (намерение у листа не показываем).
  if (!node.has_children) return { kind: "text", text: ELEMENT_LABEL.container };
  if (canEdit) return { kind: "pick", value: effective };
  return { kind: "text", text: ELEMENT_LABEL[effective] };
}

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
