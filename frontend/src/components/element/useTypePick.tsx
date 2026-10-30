// Смена типа из строки «Тип» (Р40 раздела 13 docs/plan-c4-elements.md; инспектор
// редактора и страница объекта). Тип — проекция формы и элемента, поэтому выбор ведёт к
// одной из двух прежних правок:
// • система ↔ контейнер у сервиса — смена элемента (Р18): превью последствий → окно, если
//   они есть → PATCH. Без последствий правка ложится в историю, как смена статуса; с
//   последствиями истории нет (обратное действие — та же смена типа);
// • база данных, брокер, «Пользователь» — смена формы с правилами сервера; база, брокер
//   или «Пользователь», ставшие системой или контейнером, становятся сервисом с этим
//   элементом одной правкой (превью элемента сервер считает только у сервиса).
// Компонентом объект делает место: внутри контейнера сервис уже компонент, поэтому
// «Компонент» у другой формы — это смена формы на сервис. Какие пункты серые, решает
// typeOptions; отказ превью или записи — плашка правок (useNodePatch).
import type { ReactNode } from "react";
import type { NodeElement } from "../../types";
import type { useNodePatch } from "../../pages/useNodePatch";
import { typeOf, type NodeType } from "../nodeTerms";
import { hasConsequences } from "./elementChange";
import { useConsequences } from "./useConsequences";

type NodePatch = ReturnType<typeof useNodePatch>;

export function useTypePick(patch: NodePatch): { pick: (type: NodeType) => void; dialog: ReactNode } {
  const consequences = useConsequences();

  const pickElement = (value: NodeElement) => {
    const node = patch.node;
    if (value === node.element_effective) return;
    void (async () => {
      const preview = await patch.previewElement(value);
      if (!preview) return;
      if (!(await consequences.ask(preview, node.name))) return;
      await patch.pickElement(value, !hasConsequences(preview));
    })();
  };

  const pick = (type: NodeType) => {
    const node = patch.node;
    if (type === typeOf(node)) return;
    if (type === "system" || type === "container") {
      if (node.shape === "service") pickElement(type);
      else patch.pickShape("service", type);
      return;
    }
    patch.pickShape(type === "component" ? "service" : type);
  };

  return { pick, dialog: consequences.dialog };
}
