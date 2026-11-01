// Строка «Тип» и чтение объекта страницей — чистая часть (components/element/elementView.ts,
// Ф8 и Р40 эпика docs/plan-c4-elements.md): тип — проекция формы и элемента с сервера,
// контейнер компонента — ближайший предок-контейнер из цепочки; пустая система (Р39)
// читается системой и не ждёт первого вложенного объекта. Справка «?» (elementText.ts) —
// четыре абзаца лексикона без внутренних слов.
import { describe, expect, it } from "vitest";
import {
  awaitsFirstChild, childIsComponent, containerOf, pageElement, typeView, type TypeSubject,
} from "../element/elementView";
import { ELEMENT_HELP, ELEMENT_HELP_LABEL } from "../element/elementText";
import type { AncestorRef, Node } from "../../types";

const ref = (id: string, element_effective: AncestorRef["element_effective"]): AncestorRef =>
  ({ id, name: id, is_external: false, element_effective });

const subject = (over: Partial<TypeSubject> = {}): TypeSubject => ({
  shape: "service", element_effective: "container", is_external: false, container_name: null, ...over,
});

describe("containerOf", () => {
  it("ближайший предок-контейнер; без контейнера в цепочке — null", () => {
    expect(containerOf([ref("root", "system"), ref("orders", "container"), ref("core", "component")])?.id).toBe("orders");
    expect(containerOf([ref("root", "system"), ref("sub", "system")])).toBeNull();
    expect(containerOf([])).toBeNull();
  });
});

describe("typeView", () => {
  it("тип — по форме и элементу; контейнер только у компонента", () => {
    expect(typeView(subject(), [])).toEqual({ value: "container", label: "Контейнер", container: null });
    expect(typeView(subject({ element_effective: "system" }), []))
      .toEqual({ value: "system", label: "Система", container: null });
    expect(typeView(subject({ shape: "database" }), []))
      .toEqual({ value: "database", label: "База данных", container: null });
    expect(typeView(subject({ shape: "person", element_effective: null }), [ref("orders", "container")]))
      .toEqual({ value: "person", label: "Пользователь", container: null });
  });

  it("у внешнего объекта подпись «Внешняя система» / «Внешний контейнер», тип прежний (Р42)", () => {
    const ext = (over: Partial<TypeSubject>) => typeView(subject({ is_external: true, ...over }), []);
    expect(ext({ element_effective: "system" })).toEqual({ value: "system", label: "Внешняя система", container: null });
    expect(ext({})).toEqual({ value: "container", label: "Внешний контейнер", container: null });
    // У базы, брокера и пользователя подпись прежняя.
    expect(ext({ shape: "database" }).label).toBe("База данных");
    expect(ext({ shape: "broker" }).label).toBe("Брокер");
    expect(ext({ shape: "person", element_effective: null }).label).toBe("Пользователь");
  });

  it("компонент — контейнер из цепочки со ссылкой, без него — имя с сервера", () => {
    const comp = subject({ element_effective: "component", container_name: "orders" });
    expect(typeView(comp, [ref("root", "system"), ref("orders", "container")])).toEqual({
      value: "component", label: "Компонент", container: { id: "orders", name: "orders" },
    });
    expect(typeView(comp, [ref("root", "system")])).toEqual({
      value: "component", label: "Компонент", container: { id: null, name: "orders" },
    });
  });
});

describe("пустая система (Р39)", () => {
  const empty: Pick<Node, "shape" | "element" | "has_children" | "element_effective" | "container_name" | "is_external"> = {
    shape: "service", element: "system", has_children: false, element_effective: "system", container_name: null,
    is_external: false,
  };

  // Тот же лист без хранимого элемента — обычный контейнер.
  const leaf = { ...empty, element: null, element_effective: "container" as const };

  it("страница читает её системой, обычный лист — листом", () => {
    expect(pageElement(empty, [])).toEqual({ kind: "system" });
    expect(pageElement(leaf, [])).toEqual({ kind: "leaf" });
  });

  it("первого вложенного объекта не ждёт, и он у неё не компонент", () => {
    expect(awaitsFirstChild(empty)).toBe(false);
    expect(childIsComponent(empty)).toBe(false);
    expect(awaitsFirstChild(leaf)).toBe(true);
  });
});

describe("внешняя система (Р42)", () => {
  // Внешний лист без хранимого элемента сервер читает системой.
  const ext: Pick<Node, "shape" | "element" | "has_children" | "element_effective" | "container_name" | "is_external"> = {
    shape: "service", element: null, has_children: false, element_effective: "system", container_name: null,
    is_external: true,
  };

  it("страница читает её внешней системой: документация на месте, размещения и статуса нет", () => {
    expect(pageElement(ext, [])).toEqual({ kind: "external" });
    // С вложенными — обычная система; с хранимым «контейнер» сервер читает её контейнером.
    expect(pageElement({ ...ext, has_children: true }, [])).toEqual({ kind: "system" });
    expect(pageElement({ ...ext, element_effective: "container" }, [])).toEqual({ kind: "leaf" });
  });

  it("первого вложенного объекта ждёт, как свой лист без элемента", () => {
    expect(awaitsFirstChild(ext)).toBe(true);
    expect(childIsComponent(ext)).toBe(false);
  });
});

describe("справка «?»", () => {
  it("четыре абзаца с жирным началом, без внутренних слов", () => {
    expect(ELEMENT_HELP_LABEL).toBe("Что такое система, контейнер и компонент");
    expect(ELEMENT_HELP.map((p) => p.head)).toEqual(["Контейнер.", "Компонент.", "Система.", "Как выбрать."]);
    const text = ELEMENT_HELP.map((p) => p.body).join(" ");
    expect(text).toContain("спецификация API");
    expect(text).not.toMatch(/[Сс]пек[^т]|модул|коробк/);
  });

  it("«Как выбрать» — тип при создании и чтение объекта без типа", () => {
    expect(ELEMENT_HELP[3].body).toBe(
      "Тип выбирается при создании и меняется в свойствах. Объект без типа из старого проекта "
      + "или файла агента ArchMap читает так: без вложенных — контейнер, а внешний — внешняя "
      + "система, с вложенными — система, внутри контейнера — компонент. Поле «Роль» — свободная "
      + "подпись на схеме, на это не влияет.",
    );
  });
});
