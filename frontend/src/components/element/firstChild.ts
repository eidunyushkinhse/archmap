// Первый вложенный объект у листа (Р4 эпика docs/plan-c4-elements.md): лист-сервис без
// явного элемента архитектуры, получив первого ребёнка, становится системой или
// контейнером — и это меняет, кто ведёт его документацию и площадки. Сервер значение не
// выводит (null читается системой), поэтому спрашивает клиент — ДО создания или переноса,
// одним планом для всех путей: «+» в дереве (обе страницы), бросок шаблона на уровень
// листа, перенос объекта в лист.
//
// Чистая часть без разметки: какой путь у этого ребёнка — окно, тихая запись «система»
// или ничего. Само окно и запись — useFirstChild.
import type { Node, NodeElement, NodeShape } from "../../types";
import { configParamsApi, nodesApi } from "../../api/nodes";
import { isTourRunning } from "../tour/tourBus";

export type FirstChildPlan =
  // Выбора нет: родителя нет (корень), у него уже есть дети или элемент, он не сервис
  // или лежит внутри контейнера (там всё — компоненты).
  | { kind: "proceed" }
  // Контейнером родитель стать не может (ребёнок — база, брокер или «Пользователь»,
  // Р6) или идёт обучающий тур (его сюжет — «Моя система» становится системой):
  // элемент «система» пишется явно, без окна.
  | { kind: "system"; parent: Node }
  // Спросить окном; preselect — предвыбор по фактам листа.
  | { kind: "ask"; parent: Node; preselect: NodeElement };

// Ждёт ли родитель ответа на «что это такое» с первым ребёнком.
export function awaitsFirstChild(parent: Node): boolean {
  return parent.shape === "service"
    && parent.element === null
    && !parent.has_children
    && parent.element_effective !== "component";
}

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
  if (childShape !== "service" || isTourRunning()) return { kind: "system", parent };
  return { kind: "ask", parent, preselect: await preselectOf(parent) };
}
