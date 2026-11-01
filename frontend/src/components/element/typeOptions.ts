// Что показывает поле «Тип» (Р35, Р37 раздела 13 docs/plan-c4-elements.md) — чистая
// модель без разметки: какие из шести типов можно выбрать в этом месте, а какие серые и
// почему. Два режима: окно «Новый объект» (create — тип нового объекта под родителем) и
// строка «Тип» в свойствах (change — смена типа существующего объекта).
//
// Правила — зеркало отказов сервера (app/element_rules, app/reparent): серый пункт здесь
// — это то, на что сервер ответил бы отказом, только сказанное до выбора и словами места.
// Элемент считает сервер (element_effective); своей модели элементов здесь нет.
import type { AncestorRef, Node } from "../../types";
import { TYPE_ORDER, typeOf, type NodeType } from "../nodeTerms";
import { awaitsFirstChild, childIsComponent, containerOf } from "./elementView";

export interface TypeOption {
  type: NodeType;
  // Серый пункт: не выбирается, вместо подсказки показывает reason.
  disabled: boolean;
  reason?: string;
  // Строка под полем, когда пункт выбран (Р38: что станет с родителем).
  note?: string;
}

// То, что правилам нужно от объекта: у родителя в окне создания и у объекта в свойствах.
export type TypeSubject = Pick<
  Node, "name" | "shape" | "element" | "element_effective" | "has_children" | "container_name"
>;

export type TypeContext =
  // parent null — верхний уровень проекта.
  | { mode: "create"; parent: TypeSubject | null }
  // ancestors — предки объекта от корня: по ним называется контейнер компонента.
  | { mode: "change"; node: TypeSubject; ancestors: readonly AncestorRef[] };

// ── Тексты объяснений (с подстановкой имени) ─────────────────────────────────

const COMPONENT_ONLY = "Компонентом объект бывает только внутри контейнера.";
const componentInSystem = (system: string) =>
  `${COMPONENT_ONLY} Чтобы вложить компонент, сделайте «${system}» контейнером в его свойствах.`;
const componentMove = (name: string) =>
  `${COMPONENT_ONLY} Чтобы сделать «${name}» компонентом, перенесите его в контейнер.`;
const insideContainerCreate = (container: string) =>
  "Внутри контейнера все объекты — компоненты. Чтобы вложить контейнер, сделайте "
  + `«${container}» системой в его свойствах.`;
const insideContainerChange = (container: string) =>
  "Объект внутри контейнера всегда компонент. Чтобы сделать его контейнером, перенесите "
  + `его из «${container}».`;
// Р6: база данных и брокер не входят в состав контейнера (element_rules.STORE_CREATE).
const storeCreate: Record<"database" | "broker", (container: string) => string> = {
  database: (c) => `База данных не входит в состав контейнера, создайте её рядом с «${c}».`,
  broker: (c) => `Брокер не входит в состав контейнера, создайте его рядом с «${c}».`,
};
const storeChange: Record<"database" | "broker", (container: string) => string> = {
  database: (c) => `База данных не входит в состав контейнера, перенесите объект из «${c}».`,
  broker: (c) => `Брокер не входит в состав контейнера, перенесите объект из «${c}».`,
};
// «Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31,
// app/reparent.person_refusal): внутри объекта его не создают, а вложенный объект им не
// становится, пока его не вынесли наверх.
const PERSON_CREATE = "Пользователь живёт вне границ системы, создайте его на верхнем уровне.";
const PERSON_CHANGE = "Пользователь живёт вне границ системы, сначала перенесите объект на верхний уровень.";
// Вложенные объекты бывают только у сервиса (app/reparent.validate_shape_change).
const WITH_CHILDREN: Record<"database" | "broker" | "person", string> = {
  database: "Объект с вложенными объектами не может стать базой данных.",
  broker: "Объект с вложенными объектами не может стать брокером.",
  person: "Объект с вложенными объектами не может стать пользователем.",
};
const becomesContainer = (parent: string) => `«${parent}» станет контейнером.`;
const becomesSystem = (parent: string) => `«${parent}» станет системой.`;

// ── Режимы ────────────────────────────────────────────────────────────────────

const enabled = (type: NodeType): TypeOption => ({ type, disabled: false });
const grey = (type: NodeType, reason: string): TypeOption => ({ type, disabled: true, reason });

// Имя контейнера, в котором лежит объект (или сам контейнер): у компонента — из цепочки
// предков, а без неё — из ответа сервера (container_name).
function holderName(node: TypeSubject, ancestors: readonly AncestorRef[] = []): string {
  const holder = containerOf(ancestors);
  if (node.element_effective !== "component" && !holder) return node.name;
  return holder?.name ?? node.container_name ?? node.name;
}

function createOptions(parent: TypeSubject | null): TypeOption[] {
  // Внутри любого объекта «Пользователь» серый: он живёт только на верхнем уровне.
  // Лист-сервис без элемента ждёт первого вложенного объекта: выбор задаёт и его (Р38).
  if (parent && awaitsFirstChild(parent)) {
    return TYPE_ORDER.map((type) => type === "person" ? grey(type, PERSON_CREATE) : {
      type,
      disabled: false,
      note: type === "component" ? becomesContainer(parent.name) : becomesSystem(parent.name),
    });
  }
  // Внутри контейнера (и его компонента) всё — компоненты; база и брокер в контейнер не
  // входят.
  if (parent && parent.shape === "service" && childIsComponent(parent)) {
    const container = holderName(parent);
    return TYPE_ORDER.map((type) => {
      if (type === "system" || type === "container") return grey(type, insideContainerCreate(container));
      if (type === "database" || type === "broker") return grey(type, storeCreate[type](container));
      if (type === "person") return grey(type, PERSON_CREATE);
      return enabled(type);
    });
  }
  // Верхний уровень и система (с вложенными или пустая); база и брокер с детьми из старых
  // данных — как система. У «Пользователя» вложенных объектов не бывает (N4).
  const reason = parent && parent.shape === "service" && parent.has_children
    ? componentInSystem(parent.name)
    : COMPONENT_ONLY;
  return TYPE_ORDER.map((type) => {
    if (type === "component") return grey(type, reason);
    if (type === "person" && parent) return grey(type, PERSON_CREATE);
    return enabled(type);
  });
}

function changeOptions(node: TypeSubject, ancestors: readonly AncestorRef[]): TypeOption[] {
  const current = typeOf(node);
  // Внутри контейнера: компонент — по ответу сервера; у «Пользователя» элемента нет, его
  // место видно по цепочке предков.
  const inside = node.element_effective === "component" || containerOf(ancestors) !== null;
  // Вложен ли объект вообще: предки от корня — крошки уровня и раскрытая рамка.
  const nested = inside || ancestors.length > 0;
  const container = holderName(node, ancestors);
  return TYPE_ORDER.map((type) => {
    if (type === current) return enabled(type);
    if (type === "system" || type === "container") {
      return inside ? grey(type, insideContainerChange(container)) : enabled(type);
    }
    if (type === "component") return inside ? enabled(type) : grey(type, componentMove(node.name));
    // Форма без вложенных объектов: у объекта с детьми — отказ сервера.
    if (node.has_children) return grey(type, WITH_CHILDREN[type]);
    if (type === "person") return nested ? grey(type, PERSON_CHANGE) : enabled(type);
    if (inside) return grey(type, storeChange[type](container));
    return enabled(type);
  });
}

// Варианты поля «Тип» в порядке TYPE_ORDER.
export function typeOptions(ctx: TypeContext): TypeOption[] {
  return ctx.mode === "create" ? createOptions(ctx.parent) : changeOptions(ctx.node, ctx.ancestors);
}

// Предвыбор окна «Новый объект» (Р36): тип шаблона из палитры, если он возможен в этом
// месте; внутри контейнера и компонента — «Компонент»; иначе тип последнего созданного
// соседа, если он возможен здесь. На верхнем уровне и в системе без соседей предвыбора
// нет: «Создать» ждёт, пока тип выберут.
export function preselectType(
  options: readonly TypeOption[],
  parent: TypeSubject | null,
  siblings: readonly Pick<Node, "shape" | "element_effective" | "created_at">[],
  template: NodeType | null,
): NodeType | null {
  const can = (type: NodeType) => options.some((o) => o.type === type && !o.disabled);
  if (template && can(template)) return template;
  if (parent && parent.shape === "service" && childIsComponent(parent)) return "component";
  let last: (typeof siblings)[number] | null = null;
  for (const s of siblings) if (!last || s.created_at > last.created_at) last = s;
  if (!last) return null;
  const type = typeOf(last);
  return can(type) ? type : null;
}
