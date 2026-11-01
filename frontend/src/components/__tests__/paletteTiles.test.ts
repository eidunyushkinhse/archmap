// Палитра и бросок по месту назначения (приёмка Ф12 2026-10-31): цель броска проверяет тип.
// Плитка активна, если тип возможен на уровне или его принимает раскрытая рамка; бросок
// туда, где тип невозможен, объясняется словами поля «Тип». Чистая модель — без DOM.
import { describe, it, expect } from "vitest";
import type { DropFrameTarget } from "../graph/types";
import { dropEligibility, dropRefusal, paletteTiles } from "../element/paletteTiles";
import { typeOptions, type TypeSubject } from "../element/typeOptions";

function subject(over: Partial<TypeSubject> = {}): TypeSubject {
  return {
    name: "shop", shape: "service", element: null, element_effective: "system",
    has_children: true, container_name: null, ...over,
  };
}
const frame = (id: string, over: Partial<TypeSubject> = {}): DropFrameTarget =>
  ({ id, name: id, subject: subject({ name: id, ...over }) });
const containerFrame = (id: string) => frame(id, { element: "container", element_effective: "container" });

// Уровень системы «shop» с вложенными объектами.
const systemLevel = typeOptions({ mode: "create", parent: subject() });
const tileOf = (tiles: ReturnType<typeof paletteTiles>, type: string) => tiles?.find((t) => t.type === type);

describe("paletteTiles: активность плитки", () => {
  it("тип возможен на уровне — активна без своей подсказки", () => {
    const tiles = paletteTiles(systemLevel, []);
    expect(tiles?.map((t) => t.type)).toEqual(["system", "container", "component", "database", "broker", "person"]);
    expect(tileOf(tiles, "container")).toEqual({ type: "container", enabled: true });
  });

  it("невозможен на уровне и в рамках — серая с причиной уровня", () => {
    const tiles = paletteTiles(systemLevel, [frame("billing")]);
    expect(tileOf(tiles, "component")).toEqual({
      type: "component", enabled: false,
      reason: "Компонентом объект бывает только внутри контейнера. Чтобы вложить компонент, "
        + "сделайте «shop» контейнером в его свойствах.",
    });
  });

  it("невозможен на уровне, но его принимает раскрытая рамка — активна, подсказка с именами рамок", () => {
    const tiles = paletteTiles(systemLevel, [containerFrame("orders"), frame("billing"), containerFrame("auth")]);
    expect(tileOf(tiles, "component")).toEqual({
      type: "component", enabled: true,
      reason: "Положите «Компонент» в раскрытую рамку: «orders», «auth»",
    });
  });

  it("больше трёх рамок — три имени и «и ещё N»", () => {
    const frames = ["a", "b", "c", "d", "e"].map(containerFrame);
    expect(tileOf(paletteTiles(systemLevel, frames), "component")?.reason)
      .toBe("Положите «Компонент» в раскрытую рамку: «a», «b», «c» и ещё 2");
  });

  it("родитель уровня не загружен — плиток нет, палитра ничего не гасит", () => {
    expect(paletteTiles(null, [containerFrame("orders")])).toBeNull();
  });
});

describe("dropEligibility: куда можно бросить тип, который тянут", () => {
  it("на уровень и в принимающие рамки", () => {
    const frames = [containerFrame("orders"), frame("billing")];
    const component = dropEligibility("component", systemLevel, frames);
    expect(component?.levelOk).toBe(false);
    expect([...component!.frameIds]).toEqual(["orders"]);
    // база данных — на уровень системы и в рамку системы, но не в рамку контейнера
    const db = dropEligibility("database", systemLevel, frames);
    expect(db?.levelOk).toBe(true);
    expect([...db!.frameIds]).toEqual(["billing"]);
  });

  it("без драга или без сведений об уровне — null", () => {
    expect(dropEligibility(null, systemLevel, [])).toBeNull();
    expect(dropEligibility("system", null, [])).toBeNull();
  });
});

describe("dropRefusal: почему объект не создан", () => {
  it("мимо рамок — причина уровня и куда положить", () => {
    expect(dropRefusal("component", null, systemLevel, [containerFrame("orders")])).toBe(
      "Компонентом объект бывает только внутри контейнера. Чтобы вложить компонент, сделайте «shop» "
      + "контейнером в его свойствах. Положите «Компонент» в раскрытую рамку: «orders».",
    );
  });

  it("мимо рамок, подходящих рамок нет — только причина уровня", () => {
    const root = typeOptions({ mode: "create", parent: null });
    expect(dropRefusal("component", null, root, [])).toBe("Компонентом объект бывает только внутри контейнера.");
  });

  it("в рамку, которая тип не принимает, — её причина как есть", () => {
    expect(dropRefusal("database", "orders", systemLevel, [containerFrame("orders")]))
      .toBe("База данных не входит в состав контейнера, создайте её рядом с «orders».");
  });

  it("составной компонент называет свой контейнер", () => {
    const auth = frame("auth", { element_effective: "component", container_name: "orders" });
    expect(dropRefusal("broker", "auth", systemLevel, [auth]))
      .toBe("Брокер не входит в состав контейнера, создайте его рядом с «orders».");
  });
});

// «Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31): рамки его
// не принимают, на любом уровне, кроме верхнего, плитка серая.
describe("«Пользователь» в палитре и при броске", () => {
  const PERSON_CREATE = "Пользователь живёт вне границ системы, создайте его на верхнем уровне.";
  const root = typeOptions({ mode: "create", parent: null });

  it("уровень системы: плитка серая с причиной, рамки её не спасают", () => {
    const tiles = paletteTiles(systemLevel, [containerFrame("orders"), frame("billing")]);
    expect(tileOf(tiles, "person")).toEqual({ type: "person", enabled: false, reason: PERSON_CREATE });
  });

  it("верхний уровень с раскрытой рамкой системы: плитка активна, рамка не принимает", () => {
    const frames = [frame("shop")];
    expect(tileOf(paletteTiles(root, frames), "person")).toEqual({ type: "person", enabled: true });
    const person = dropEligibility("person", root, frames);
    expect(person?.levelOk).toBe(true);
    expect([...person!.frameIds]).toEqual([]);
    expect(dropRefusal("person", "shop", root, frames)).toBe(PERSON_CREATE);
  });
});
