// Что показывает строка «Элемент архитектуры» (инспектор редактора, «Свойства» страницы
// объекта, инспектор гостя) — чистая часть без разметки. Элемент считает сервер
// (element_effective); здесь только выбор вида строки и поиск контейнера компонента.
//
// Id контейнера сервер не отдаёт (Р24 эпика docs/plan-c4-elements.md: новых полей API нет),
// его даёт цепочка предков, которая у вызывающего уже есть: крошки страницы, крошки
// редактора, путь гостя. Контейнер в цепочке ровно один (контейнер внутри контейнера
// запрещён), поэтому ближайший предок-контейнер и есть контейнер компонента.
import type { AncestorRef, Node, NodeElement } from "../../types";
import { nodeNesting } from "../../types";
import { ELEMENT_LABEL } from "../nodeTerms";

// Ближайший (последний) предок с элементом «контейнер»; null — в цепочке его нет
// (узел не компонент или цепочка неполная).
export function containerOf(ancestors: readonly AncestorRef[]): AncestorRef | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].element_effective === "container") return ancestors[i];
  }
  return null;
}

// Строка «Элемент архитектуры»: выбор (узел с детьми, редактор), текст, текст со ссылкой
// на контейнер (компонент) или ничего («Пользователь» — сам элемент C4 Person, строки нет).
export type ElementView =
  | { kind: "none" }
  | { kind: "pick"; value: NodeElement }
  | { kind: "text"; text: string }
  | { kind: "link"; lead: string; name: string; containerId: string };

// То, что строке нужно от объекта: у узла и у гостя эти поля есть (у гостя нет имени
// контейнера — его даёт путь предков).
export type ElementSubject = Pick<Node, "element_effective" | "has_children" | "is_external">
  & { container_name?: string | null };

const COMPONENT_LEAD = "Компонент контейнера";

export function elementView(
  subject: ElementSubject, canEdit: boolean, ancestors: readonly AncestorRef[],
): ElementView {
  const effective = subject.element_effective;
  if (effective === null || effective === undefined) return { kind: "none" };
  if (effective === "component") {
    // Ссылка — только на контейнер из цепочки; цепочка разошлась с сервером — имя текстом.
    const container = containerOf(ancestors);
    if (container) return { kind: "link", lead: COMPONENT_LEAD, name: container.name, containerId: container.id };
    const name = subject.container_name;
    return { kind: "text", text: name ? `${COMPONENT_LEAD} «${name}»` : "Компонент" };
  }
  // Лист — контейнер при любом хранимом значении (намерение у листа не показываем);
  // внешний лист — чужая система, а не наш контейнер.
  if (!subject.has_children) {
    return { kind: "text", text: subject.is_external ? "Внешняя система" : ELEMENT_LABEL.container };
  }
  if (canEdit) return { kind: "pick", value: effective };
  return { kind: "text", text: ELEMENT_LABEL[effective] };
}

// ── Страница объекта по элементу (Ф8, Р34) ─────────────────────────────────────
// Как страница читает объект: от этого зависят секции «Логика», «OpenAPI»,
// «Конфигурация» и строка «Размещение».
// • leaf — без вложенных объектов и не компонент: контейнер без компонентов, а также
//   база, брокер и «Пользователь» (их секции решает форма, types/shapeDocs);
// • system — система: сама не запускается, документации потомков не собирает (Р34);
// • container — контейнер с компонентами: собирает схемы и спецификации компонентов;
// • component — компонент без вложенных; composite — составной компонент (собирает
//   документацию вложенных, как контейнер). У обоих контейнер — для текста и ссылки.
export interface ContainerLink {
  // id из цепочки предков; null — цепочка разошлась с сервером (ссылки нет).
  id: string | null;
  name: string;
}
export type PageElement =
  | { kind: "leaf" | "system" | "container" }
  | { kind: "component" | "composite"; container: ContainerLink };

export function pageElement(
  node: Pick<Node, "shape" | "has_children" | "element_effective" | "container_name">,
  ancestors: readonly AncestorRef[],
): PageElement {
  const nested = nodeNesting(node) === "group";
  if (node.element_effective === "component") {
    const found = containerOf(ancestors);
    const container = found ? { id: found.id, name: found.name } : { id: null, name: node.container_name ?? "" };
    return { kind: nested ? "composite" : "component", container };
  }
  if (!nested) return { kind: "leaf" };
  // Узел с детьми без явного значения — система (норма эпика).
  return { kind: node.element_effective === "container" ? "container" : "system" };
}

// Станет ли новый вложенный объект компонентом: у контейнера (в том числе пока без
// компонентов — элемент хранится явно) и внутри контейнера. Иначе первый вложенный
// объект у листа спросит окно (Р4), а у системы он — её контейнер или подсистема.
export const childIsComponent = (node: Pick<Node, "element" | "element_effective">): boolean =>
  node.element === "container" || node.element_effective === "component";
