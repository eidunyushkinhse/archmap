// Перенос объекта в лист (Р38 раздела 13 docs/plan-c4-elements.md): лист-сервис без
// хранимого элемента архитектуры, получив первый вложенный объект, становится системой
// или контейнером — и это меняет, кто ведёт его документацию и площадки. Создание это
// решает само (окно «Новый объект» задаёт родителя тем же запросом), а перенос
// спрашивает окном ДО переноса — со стороны переносимого: что такое «Y» внутри «X».
//
// Чистая часть без разметки: какой путь у переноса — окно, тихая запись «система» или
// ничего. Само окно и запись — useFirstChild.
import type { Node, NodeElement } from "../../types";
import { configParamsApi, nodesApi } from "../../api/nodes";
import { awaitsFirstChild } from "./elementView";

// То, что плану нужно от переносимого объекта (имя — для текста окна).
export type MovedChild = Pick<Node, "name" | "shape" | "element">;

export type FirstChildPlan =
  // Выбора нет: цели нет (корень), у неё уже есть дети или элемент, она не сервис или
  // лежит внутри контейнера (там всё — компоненты).
  | { kind: "proceed" }
  // Переносимый — база, брокер, «Пользователь» (контейнером цель стать не может, Р6) или
  // сервис с хранимым элементом (он уже система или контейнер, не компонент цели):
  // элемент «система» пишется цели явно, без окна.
  | { kind: "system"; parent: Node }
  // Спросить окном; preselect — предвыбор по фактам листа.
  | { kind: "ask"; parent: Node; preselect: NodeElement };

// Предвыбор «Компонент» (цель станет контейнером), если у листа есть факты процесса:
// спецификация, конфигурация или площадки. Иначе «Отдельное приложение» (цель станет
// системой). Конфигурацию спрашиваем, только если первых двух нет; сбой её загрузки
// предвыбор не решает — окно всё равно спросит.
async function preselectOf(parent: Node): Promise<NodeElement> {
  if ((parent.openapi_spec ?? "").trim() !== "" || parent.sites.length > 0) return "container";
  try {
    const params = await configParamsApi.list(parent.id);
    return params.length > 0 ? "container" : "system";
  } catch {
    return "system";
  }
}

// План переноса child под parentId (null — корень). Цель план получает сам: вызывающие
// знают только её id.
export async function planFirstChild(
  parentId: string | null, child: MovedChild,
): Promise<FirstChildPlan> {
  if (parentId === null) return { kind: "proceed" };
  const parent = await nodesApi.get(parentId);
  if (!awaitsFirstChild(parent)) return { kind: "proceed" };
  if (child.shape !== "service" || child.element !== null) return { kind: "system", parent };
  return { kind: "ask", parent, preselect: await preselectOf(parent) };
}
