// Слова строк обращений (docRefs): одна сборка для строк при правке схемы логики и для
// строки неразрешённых обращений в подвале чтения (редизайн, фаза 7б).
import { describe, expect, it } from "vitest";
import { refLine, refOwner, unresolvedLine } from "../inspector/docRefs";
import type { DataRefPreviewItem } from "../../types";

const item = (over: Partial<DataRefPreviewItem>): DataRefPreviewItem => ({
  ref: "orders", mode: "write", status: "ok", target: "БД заказов · orders", ...over,
});
const text = (r: DataRefPreviewItem) => { const l = refLine(r); return l.lead + l.name + l.tail; };

describe("refOwner: владелец из target", () => {
  it("хвост « · {имя}» отбрасывается", () => {
    expect(refOwner("БД заказов · orders", "orders")).toBe("БД заказов");
    expect(refOwner("Конфигурация · MAX_ITEMS_PER_ORDER", "MAX_ITEMS_PER_ORDER")).toBe("Конфигурация");
    expect(refOwner("Конфигурация «Order API» · TTL", "TTL")).toBe("Конфигурация «Order API»");
  });

  it("хвост другой — target целиком", () => {
    expect(refOwner("БД заказов · orders", "БД заказов / orders")).toBe("БД заказов · orders");
    expect(refOwner("Kafka · orders.events", "orders")).toBe("Kafka · orders.events");
  });
});

describe("refLine: строка обращения при правке", () => {
  it("разрешённое: «{действие} {имя} → {владелец}»", () => {
    expect(refLine(item({}))).toEqual({ ok: true, lead: "пишет ", name: "orders", tail: " → БД заказов" });
    expect(text(item({ ref: "orders.events", mode: "publish", target: "Kafka · orders.events" })))
      .toBe("публикует orders.events → Kafka");
    expect(text(item({ ref: "MAX_ITEMS_PER_ORDER", mode: "config", target: "Конфигурация · MAX_ITEMS_PER_ORDER" })))
      .toBe("зависит от MAX_ITEMS_PER_ORDER → Конфигурация");
  });

  it("разрешённое, target без хвоста имени — целиком", () => {
    expect(text(item({ ref: "БД заказов / orders", mode: "read", target: "БД заказов · orders" })))
      .toBe("читает БД заказов / orders → БД заказов · orders");
  });

  it("неразрешённое: «{действие} {имя}: {причина}»", () => {
    const l = refLine(item({ ref: "ordrs", status: "unknown_table", target: null }));
    expect(l.ok).toBe(false);
    expect(l.lead + l.name + l.tail).toBe("пишет ordrs: таблица не найдена");
    expect(text(item({ ref: "x", mode: "publish", status: "ambiguous", target: null })))
      .toBe("публикует x: канал с таким именем есть у нескольких брокеров, укажите «брокер / канал»");
  });

  it("нет колонки или поля — найденная таблица или канал в скобках", () => {
    expect(text(item({ ref: "orders.stat", mode: "read", status: "unknown_column", target: "БД заказов · orders" })))
      .toBe("читает orders.stat: колонки нет в таблице (БД заказов · orders)");
    expect(text(item({ ref: "orders.events.x", mode: "consume", status: "unknown_field", target: "Kafka · orders.events" })))
      .toBe("потребляет orders.events.x: поля нет в канале (Kafka · orders.events)");
  });
});

describe("unresolvedLine: подвал чтения теми же словами", () => {
  it("только неразрешённые, через «; », с заглавной буквы", () => {
    expect(unresolvedLine([
      item({}),
      item({ ref: "ordrs", status: "unknown_table", target: null }),
      item({ ref: "orders.evnts", mode: "publish", status: "unknown_channel", target: null }),
    ])).toBe("Пишет ordrs: таблица не найдена; публикует orders.evnts: канал не найден у брокеров проекта");
    expect(unresolvedLine([item({})])).toBeNull();
  });
});
