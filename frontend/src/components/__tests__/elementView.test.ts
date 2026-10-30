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
  shape: "service", element_effective: "container", container_name: null, ...over,
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
    expect(typeView(subject(), [])).toEqual({ value: "container", container: null });
    expect(typeView(subject({ element_effective: "system" }), [])).toEqual({ value: "system", container: null });
    expect(typeView(subject({ shape: "database" }), [])).toEqual({ value: "database", container: null });
    expect(typeView(subject({ shape: "person", element_effective: null }), [ref("orders", "container")]))
      .toEqual({ value: "person", container: null });
  });

  it("компонент — контейнер из цепочки со ссылкой, без него — имя с сервера", () => {
    const comp = subject({ element_effective: "component", container_name: "orders" });
    expect(typeView(comp, [ref("root", "system"), ref("orders", "container")])).toEqual({
      value: "component", container: { id: "orders", name: "orders" },
    });
    expect(typeView(comp, [ref("root", "system")])).toEqual({
      value: "component", container: { id: null, name: "orders" },
    });
  });
});

describe("пустая система (Р39)", () => {
  const empty: Pick<Node, "shape" | "element" | "has_children" | "element_effective" | "container_name"> = {
    shape: "service", element: "system", has_children: false, element_effective: "system", container_name: null,
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
      + "или файла агента ArchMap читает так: без вложенных — контейнер, с вложенными — система, "
      + "внутри контейнера — компонент. Поле «Роль» — свободная подпись на схеме, на это не влияет.",
    );
  });
});
