// Строка «Элемент архитектуры» — чистая часть (components/element/elementView.ts, Ф8 эпика
// docs/plan-c4-elements.md): контейнер компонента — ближайший предок-контейнер из цепочки;
// вид строки — по элементу с сервера, наличию детей, внешности и праву правки. Справка «?»
// (elementText.ts) — четыре абзаца лексикона без внутренних слов.
import { describe, expect, it } from "vitest";
import { containerOf, elementView, type ElementSubject } from "../element/elementView";
import { ELEMENT_HELP, ELEMENT_HELP_LABEL } from "../element/elementText";
import type { AncestorRef } from "../../types";

const ref = (id: string, element_effective: AncestorRef["element_effective"]): AncestorRef =>
  ({ id, name: id, is_external: false, element_effective });

const subject = (over: Partial<ElementSubject> = {}): ElementSubject => ({
  element_effective: "container", has_children: false, is_external: false, container_name: null, ...over,
});

describe("containerOf", () => {
  it("ближайший предок-контейнер; без контейнера в цепочке — null", () => {
    expect(containerOf([ref("root", "system"), ref("orders", "container"), ref("core", "component")])?.id).toBe("orders");
    expect(containerOf([ref("root", "system"), ref("sub", "system")])).toBeNull();
    expect(containerOf([])).toBeNull();
  });
});

describe("elementView", () => {
  it("«Пользователь» — строки нет", () => {
    expect(elementView(subject({ element_effective: null }), true, [])).toEqual({ kind: "none" });
  });

  it("лист — «Контейнер», внешний лист — «Внешняя система»", () => {
    expect(elementView(subject(), true, [])).toEqual({ kind: "text", text: "Контейнер" });
    expect(elementView(subject({ is_external: true }), true, [])).toEqual({ kind: "text", text: "Внешняя система" });
  });

  it("узел с детьми — выбор у редактора, текст у читателя", () => {
    const group = subject({ element_effective: "system", has_children: true });
    expect(elementView(group, true, [])).toEqual({ kind: "pick", value: "system" });
    expect(elementView(group, false, [])).toEqual({ kind: "text", text: "Система" });
  });

  it("компонент — ссылка на контейнер из цепочки, без него — имя текстом", () => {
    const comp = subject({ element_effective: "component", container_name: "orders" });
    expect(elementView(comp, true, [ref("root", "system"), ref("orders", "container")])).toEqual({
      kind: "link", lead: "Компонент контейнера", name: "orders", containerId: "orders",
    });
    expect(elementView(comp, true, [ref("root", "system")])).toEqual({
      kind: "text", text: "Компонент контейнера «orders»",
    });
    expect(elementView(subject({ element_effective: "component" }), false, [])).toEqual({ kind: "text", text: "Компонент" });
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
});
