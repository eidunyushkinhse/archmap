// Первый вложенный объект у листа (Р4 эпика docs/plan-c4-elements.md): лист-сервис без
// явного элемента архитектуры, получив первого ребёнка, становится системой или
// контейнером — и это меняет, кто ведёт его документацию и площадки. Сервер значение не
// выводит (null читается системой), поэтому спрашивает клиент — ДО переноса объекта в
// лист. Создание первого вложенного объекта это окно не спрашивает: окно «Новый объект»
// задаёт родителя тем же запросом (Р38 раздела 13 плана).
//
// Чистая часть без разметки: какой путь у этого ребёнка — окно, тихая запись «система»
// или ничего. Само окно и запись — useFirstChild.
import type { Node, NodeElement, NodeShape } from "../../types";
import { configParamsApi, nodesApi } from "../../api/nodes";
import { awaitsFirstChild } from "./elementView";

export type FirstChildPlan =
  // Выбора нет: родителя нет (корень), у него уже есть дети или элемент, он не сервис
  // или лежит внутри контейнера (там всё — компоненты).
  | { kind: "proceed" }
  // Контейнером родитель стать не может (ребёнок — база, брокер или «Пользователь»,
  // Р6): элемент «система» пишется явно, без окна.
  | { kind: "system"; parent: Node }
  // Спросить окном; preselect — предвыбор по фактам листа.
  | { kind: "ask"; parent: Node; preselect: NodeElement };

// Предвыбор «Контейнер», если у листа есть факты процесса: спецификация, конфигурация
// или площадки. Иначе «Система». Конфигурацию спрашиваем, только если первых двух нет;
// сбой её загрузки предвыбор не решает — окно всё равно спросит.
async function preselectOf(parent: Node): Promise<NodeElement> {
  if ((parent.openapi_spec ?? "").trim() !== "" || parent.sites.length > 0) return "container";
  try {
    const params = await configParamsApi.list(parent.id);
    return params.length > 0 ? "container" : "system";
  } catch {
    return "system";
  }
}

// План для ребёнка формы childShape под parentId (null — корень). Родителя план
// получает сам: вызывающие знают только его id.
export async function planFirstChild(
  parentId: string | null, childShape: NodeShape,
): Promise<FirstChildPlan> {
  if (parentId === null) return { kind: "proceed" };
  const parent = await nodesApi.get(parentId);
  if (!awaitsFirstChild(parent)) return { kind: "proceed" };
  if (childShape !== "service") return { kind: "system", parent };
  return { kind: "ask", parent, preselect: await preselectOf(parent) };
}
