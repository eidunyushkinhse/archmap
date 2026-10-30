// Что показывает строка «Тип» (Р40 раздела 13 docs/plan-c4-elements.md: инспектор
// редактора, «Свойства» страницы объекта, инспектор гостя) и как страница читает объект —
// чистая часть без разметки. Элемент считает сервер (element_effective); здесь только тип
// (nodeTerms.typeOf) и поиск контейнера компонента.
//
// Id контейнера сервер не отдаёт (Р24 эпика docs/plan-c4-elements.md: новых полей API нет),
// его даёт цепочка предков, которая у вызывающего уже есть: крошки страницы, крошки
// редактора, путь гостя. Контейнер в цепочке ровно один (контейнер внутри контейнера
// запрещён), поэтому ближайший предок-контейнер и есть контейнер компонента.
import type { AncestorRef, Node } from "../../types";
import { nodeNesting } from "../../types";
import { typeOf, type NodeType } from "../nodeTerms";

// Ближайший (последний) предок с элементом «контейнер»; null — в цепочке его нет
// (узел не компонент или цепочка неполная).
export function containerOf(ancestors: readonly AncestorRef[]): AncestorRef | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].element_effective === "container") return ancestors[i];
  }
  return null;
}

// Контейнер компонента для текста и ссылки.
export interface ContainerLink {
  // id из цепочки предков; null — цепочка разошлась с сервером (ссылки нет).
  id: string | null;
  name: string;
}

// Контейнер компонента: из цепочки предков, а без него — имя из ответа сервера.
function componentContainer(
  subject: { container_name?: string | null }, ancestors: readonly AncestorRef[],
): ContainerLink {
  const found = containerOf(ancestors);
  return found ? { id: found.id, name: found.name } : { id: null, name: subject.container_name ?? "" };
}

// Строка «Тип»: значение из шести и, у компонента, его контейнер (ссылкой рядом).
export interface TypeView {
  value: NodeType;
  container: ContainerLink | null;
}

// То, что строке нужно от объекта: у узла и у гостя эти поля есть (у гостя нет имени
// контейнера — его даёт путь предков).
export type TypeSubject = Pick<Node, "shape" | "element_effective"> & { container_name?: string | null };

export function typeView(subject: TypeSubject, ancestors: readonly AncestorRef[]): TypeView {
  const value = typeOf(subject);
  return { value, container: value === "component" ? componentContainer(subject, ancestors) : null };
}

// ── Страница объекта по элементу (Ф8, Р34) ─────────────────────────────────────
// Как страница читает объект: от этого зависят секции «Логика», «OpenAPI»,
// «Конфигурация» и строка «Размещение».
// • leaf — без вложенных объектов и не компонент: контейнер без компонентов, а также
//   база, брокер и «Пользователь» (их секции решает форма, types/shapeDocs);
// • system — система, в том числе пустая (лист с хранимым «система», Р39): сама не
//   запускается, документации потомков не собирает (Р34);
// • container — контейнер с компонентами: собирает схемы и спецификации компонентов;
// • component — компонент без вложенных; composite — составной компонент (собирает
//   документацию вложенных, как контейнер). У обоих контейнер — для текста и ссылки.
export type PageElement =
  | { kind: "leaf" | "system" | "container" }
  | { kind: "component" | "composite"; container: ContainerLink };

export function pageElement(
  node: Pick<Node, "shape" | "has_children" | "element_effective" | "container_name">,
  ancestors: readonly AncestorRef[],
): PageElement {
  const nested = nodeNesting(node) === "group";
  if (node.element_effective === "component") {
    return { kind: nested ? "composite" : "component", container: componentContainer(node, ancestors) };
  }
  // Лист — «leaf», кроме пустой системы: она читается системой (Р39).
  if (!nested) return { kind: node.element_effective === "system" ? "system" : "leaf" };
  // Узел с детьми без явного значения — система (норма эпика).
  return { kind: node.element_effective === "container" ? "container" : "system" };
}

// Станет ли новый вложенный объект компонентом: у контейнера (в том числе пока без
// компонентов — элемент хранится явно) и внутри контейнера. Иначе первый вложенный
// объект у листа задаёт элемент листу (Р38), а у системы он — её контейнер или подсистема.
export const childIsComponent = (node: Pick<Node, "element" | "element_effective">): boolean =>
  node.element === "container" || node.element_effective === "component";

// Ждёт ли объект первого вложенного объекта, который задаст его элемент (Р38): лист-сервис
// без хранимого элемента и не компонент. Пустая система (хранимое «система», Р39) и лист
// с хранимым «контейнер» уже ответили.
export function awaitsFirstChild(
  node: Pick<Node, "shape" | "element" | "has_children" | "element_effective">,
): boolean {
  return node.shape === "service"
    && node.element === null
    && !node.has_children
    && node.element_effective !== "component";
}
