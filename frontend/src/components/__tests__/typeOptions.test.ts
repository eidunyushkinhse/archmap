// Поле «Тип» (Р35, Р37 раздела 13 docs/plan-c4-elements.md): какие из шести типов
// доступны в каждом месте и почему серые остальные. Чистая модель — без DOM.
import { describe, it, expect } from "vitest";
import type { AncestorRef } from "../../types";
import { TYPE_HINT, TYPE_LABEL, TYPE_ORDER, shapeOfType, typeOf } from "../nodeTerms";
import { preselectType, typeOptions, type TypeOption, type TypeSubject } from "../element/typeOptions";

function subject(over: Partial<TypeSubject> = {}): TypeSubject {
  return {
    name: "orders", shape: "service", element: null, element_effective: "container",
    has_children: false, container_name: null, ...over,
  };
}
const ancestor = (id: string, name: string, element: AncestorRef["element_effective"]): AncestorRef =>
  ({ id, name, is_external: false, element_effective: element });

// Доступные типы и серые с причинами — в порядке поля.
const free = (opts: TypeOption[]) => opts.filter((o) => !o.disabled).map((o) => o.type);
const reasonOf = (opts: TypeOption[], type: string) => opts.find((o) => o.type === type)?.reason;

describe("словарь типов", () => {
  it("шесть типов в порядке поля, подписи без слова «Сервис»", () => {
    expect(TYPE_ORDER).toEqual(["system", "container", "component", "database", "broker", "person"]);
    expect(TYPE_ORDER.map((t) => TYPE_LABEL[t])).toEqual([
      "Система", "Контейнер", "Компонент", "База данных", "Брокер", "Пользователь",
    ]);
  });
  it("подсказка у каждого типа — простыми словами, одной строкой", () => {
    expect(TYPE_ORDER.map((t) => TYPE_HINT[t])).toEqual([
      "Группа контейнеров: сама не запускается",
      "Одно приложение, которое запускается целиком",
      "Часть кода контейнера, отдельно не запускается",
      "Хранилище: таблицы и колонки",
      "Очереди и каналы сообщений",
      "Человек или внешняя роль",
    ]);
  });
  it("тип — проекция формы и действующего элемента", () => {
    expect(typeOf({ shape: "service", element_effective: "system" })).toBe("system");
    expect(typeOf({ shape: "service", element_effective: "component" })).toBe("component");
    expect(typeOf({ shape: "database", element_effective: "container" })).toBe("database");
    expect(typeOf({ shape: "person", element_effective: null })).toBe("person");
    expect(shapeOfType("component")).toBe("service");
    expect(shapeOfType("broker")).toBe("broker");
  });
});

describe("окно «Новый объект»", () => {
  it("верхний уровень: всё, кроме компонента", () => {
    const opts = typeOptions({ mode: "create", parent: null });
    expect(free(opts)).toEqual(["system", "container", "database", "broker", "person"]);
    expect(reasonOf(opts, "component")).toBe("Компонентом объект бывает только внутри контейнера.");
    expect(opts.every((o) => o.note === undefined)).toBe(true);
  });

  it("система с вложенными: компонент серый с советом сделать её контейнером", () => {
    const parent = subject({ name: "Ярмарка", element_effective: "system", has_children: true });
    const opts = typeOptions({ mode: "create", parent });
    expect(free(opts)).toEqual(["system", "container", "database", "broker", "person"]);
    expect(reasonOf(opts, "component")).toBe(
      "Компонентом объект бывает только внутри контейнера. Чтобы вложить компонент, сделайте "
      + "«Ярмарка» контейнером в его свойствах.",
    );
  });

  it("пустая система (Р39) — как система, без ожидания первого вложенного", () => {
    const parent = subject({ name: "Ярмарка", element: "system", element_effective: "system" });
    const opts = typeOptions({ mode: "create", parent });
    expect(free(opts)).toEqual(["system", "container", "database", "broker", "person"]);
    expect(opts.every((o) => o.note === undefined)).toBe(true);
  });

  it("контейнер: компонент и пользователь, контейнер и база — серые с причиной", () => {
    const parent = subject({ element: "container", element_effective: "container", has_children: true });
    const opts = typeOptions({ mode: "create", parent });
    expect(free(opts)).toEqual(["component", "person"]);
    expect(reasonOf(opts, "system")).toBe(
      "Внутри контейнера все объекты — компоненты. Чтобы вложить контейнер, сделайте «orders» "
      + "системой в его свойствах.",
    );
    expect(reasonOf(opts, "container")).toBe(reasonOf(opts, "system"));
    expect(reasonOf(opts, "database")).toBe("База данных не входит в состав контейнера, создайте её рядом с «orders».");
    expect(reasonOf(opts, "broker")).toBe("Брокер не входит в состав контейнера, создайте его рядом с «orders».");
  });

  it("лист с хранимым «контейнер» — уже контейнер: только компонент", () => {
    const opts = typeOptions({ mode: "create", parent: subject({ element: "container" }) });
    expect(free(opts)).toEqual(["component", "person"]);
  });

  it("компонент: причины называют его контейнер", () => {
    const parent = subject({ name: "api", element_effective: "component", container_name: "orders" });
    const opts = typeOptions({ mode: "create", parent });
    expect(free(opts)).toEqual(["component", "person"]);
    expect(reasonOf(opts, "database")).toBe("База данных не входит в состав контейнера, создайте её рядом с «orders».");
  });

  it("лист без элемента: все шесть, строка под полем говорит, кем станет родитель (Р38)", () => {
    const opts = typeOptions({ mode: "create", parent: subject() });
    expect(free(opts)).toEqual(TYPE_ORDER);
    expect(opts.map((o) => o.note)).toEqual([
      "«orders» станет системой.", "«orders» станет системой.", "«orders» станет контейнером.",
      "«orders» станет системой.", "«orders» станет системой.", "«orders» станет системой.",
    ]);
  });

  it("база с детьми из старых данных — как система", () => {
    const parent = subject({ shape: "database", has_children: true, element_effective: "system" });
    const opts = typeOptions({ mode: "create", parent });
    expect(free(opts)).toEqual(["system", "container", "database", "broker", "person"]);
    expect(reasonOf(opts, "component")).toBe("Компонентом объект бывает только внутри контейнера.");
  });
});

describe("строка «Тип» в свойствах", () => {
  const chain = [ancestor("s", "Ярмарка", "system"), ancestor("o", "orders", "container")];

  it("компонент: только он сам; контейнер — перенести из контейнера; база — Р6", () => {
    const node = subject({ name: "api", element_effective: "component", container_name: "orders" });
    const opts = typeOptions({ mode: "change", node, ancestors: chain });
    expect(free(opts)).toEqual(["component", "person"]);
    expect(reasonOf(opts, "container")).toBe(
      "Объект внутри контейнера всегда компонент. Чтобы сделать его контейнером, перенесите его из «orders».",
    );
    expect(reasonOf(opts, "database")).toBe("База данных не входит в состав контейнера, перенесите объект из «orders».");
  });

  it("составной компонент: формы без детей серые причиной вложенных", () => {
    const node = subject({ name: "jobs", element_effective: "component", has_children: true });
    const opts = typeOptions({ mode: "change", node, ancestors: chain });
    expect(free(opts)).toEqual(["component"]);
    expect(reasonOf(opts, "person")).toBe("Объект с вложенными объектами не может стать пользователем.");
  });

  it("с вложенными вне контейнера: система и контейнер, остальное серое", () => {
    const node = subject({ name: "Ярмарка", element_effective: "system", has_children: true });
    const opts = typeOptions({ mode: "change", node, ancestors: [] });
    expect(free(opts)).toEqual(["system", "container"]);
    expect(reasonOf(opts, "component")).toBe(
      "Компонентом объект бывает только внутри контейнера. Чтобы сделать «Ярмарка» компонентом, "
      + "перенесите его в контейнер.",
    );
    expect(reasonOf(opts, "database")).toBe("Объект с вложенными объектами не может стать базой данных.");
    expect(reasonOf(opts, "broker")).toBe("Объект с вложенными объектами не может стать брокером.");
  });

  it("лист вне контейнера: всё, кроме компонента", () => {
    const opts = typeOptions({ mode: "change", node: subject(), ancestors: [] });
    expect(free(opts)).toEqual(["system", "container", "database", "broker", "person"]);
  });

  it("пустая система: тот же выбор, текущая — «Система»", () => {
    const node = subject({ element: "system", element_effective: "system" });
    const opts = typeOptions({ mode: "change", node, ancestors: [] });
    expect(free(opts)).toEqual(["system", "container", "database", "broker", "person"]);
  });

  it("база без детей: система и контейнер доступны сменой формы, компонент — нет", () => {
    const node = subject({ shape: "database" });
    const opts = typeOptions({ mode: "change", node, ancestors: [] });
    expect(free(opts)).toEqual(["system", "container", "database", "broker", "person"]);
  });

  it("пользователь внутри контейнера может стать только компонентом", () => {
    // Элемента у «Пользователя» нет и внутри контейнера (element_effective null), поэтому
    // место видно по цепочке предков.
    const node = subject({ name: "Оператор", shape: "person", element_effective: null });
    expect(free(typeOptions({ mode: "change", node, ancestors: [chain[0]] }))).toEqual(
      ["system", "container", "database", "broker", "person"],
    );
    const opts = typeOptions({ mode: "change", node, ancestors: chain });
    expect(free(opts)).toEqual(["component", "person"]);
    expect(reasonOf(opts, "broker")).toBe("Брокер не входит в состав контейнера, перенесите объект из «orders».");
  });
});

describe("предвыбор окна «Новый объект» (Р36)", () => {
  const at = (iso: string, over: Partial<TypeSubject> = {}) =>
    ({ shape: "service" as const, element_effective: "container" as const, created_at: iso, ...over });

  it("верхний уровень и система без соседей — ничего", () => {
    expect(preselectType(typeOptions({ mode: "create", parent: null }), null, [], null)).toBeNull();
    const system = subject({ element: "system", element_effective: "system" });
    expect(preselectType(typeOptions({ mode: "create", parent: system }), system, [], null)).toBeNull();
  });

  it("тип последнего созданного соседа, если он возможен здесь", () => {
    const opts = typeOptions({ mode: "create", parent: null });
    const siblings = [
      at("2026-10-30T10:00:00Z", { shape: "database" }),
      at("2026-10-30T12:00:00Z", { element_effective: "system" }),
      at("2026-10-30T11:00:00Z", { shape: "person", element_effective: null }),
    ];
    expect(preselectType(opts, null, siblings, null)).toBe("system");
    // Последний — компонент, а на верхнем уровне компонента нет: ничего.
    expect(preselectType(opts, null, [at("2026-10-30T12:00:00Z", { element_effective: "component" })], null)).toBeNull();
  });

  it("внутри контейнера — «Компонент»", () => {
    const parent = subject({ element: "container", has_children: true });
    expect(preselectType(typeOptions({ mode: "create", parent }), parent, [], null)).toBe("component");
  });

  it("шаблон из палитры — если возможен в этом месте", () => {
    const parent = subject({ element: "container", has_children: true });
    const opts = typeOptions({ mode: "create", parent });
    expect(preselectType(opts, parent, [], "person")).toBe("person");
    expect(preselectType(opts, parent, [], "database")).toBe("component");
    expect(preselectType(typeOptions({ mode: "create", parent: null }), null, [], "broker")).toBe("broker");
  });

  it("лист без элемента: без соседей ничего, шаблон — предвыбран", () => {
    const parent = subject();
    const opts = typeOptions({ mode: "create", parent });
    expect(preselectType(opts, parent, [], null)).toBeNull();
    expect(preselectType(opts, parent, [], "component")).toBe("component");
  });
});
