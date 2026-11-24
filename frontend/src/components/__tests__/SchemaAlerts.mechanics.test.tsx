// Механика панели «Рекомендации», которую перевод панели на новый язык (редизайн, фаза 10)
// обязан сохранить: порядок разделов, переходы строк всех классов щелчком и клавишей Enter,
// закрытие панели после перехода, вклад изолированных групп в точку на кнопке и состояние
// кнопки для чтения с экрана. Тесты не опираются на разметку строк (классы, склейки
// текста): строки ищутся по роли и имени, разделы по заголовку.
//
// Уже держит SchemaAlerts.test.tsx и здесь не повторяется: точка при нуле и при total > 0,
// закрытие повторным щелчком, щелчком мимо и Escape, Enter и пробел у строки объекта,
// подсказки «Показать на схеме» и «Открыть процесс», некликабельные строки без перехода.
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import SchemaAlerts, { type LocateTarget } from "../SchemaAlerts";
import type { SchemaAlerts as Alerts } from "../../types";

const EMPTY: Alerts = {
  code_changes: [], disconnected_nodes: [], intermediate_edges: [], descendant_edges: [],
  isolated_groups: [], container_own_docs: [], component_facts: [], unresolved_data_refs: [],
  unresolved_channel_refs: [], unresolved_config_refs: [], broker_edge_channels: [],
  dangling_messages: [], orphan_legs: [], unbound_participants: [], unlinked_messages: [],
  undescribed_docs: [], persons_inside: [],
};

// По записи в каждом из 17 классов; имена не повторяются между классами, чтобы строку
// можно было найти по имени.
const ALL: Alerts = {
  code_changes: [{
    id: "cc1", repo: "github.com/yarmarka/orders", merges: 3,
    first_at: "2026-11-20T10:00:00Z", last_at: "2026-11-22T10:00:00Z",
    first_commit: null, last_commit: null, branch: "main",
    nodes: [{ node_id: "n-cc", node_name: "Order API" }, { node_id: "n-cc2", node_name: "Оркестратор" }],
  }],
  disconnected_nodes: [{ node_id: "n-dis", node_name: "Уведомления" }],
  intermediate_edges: [{
    edge_id: "e-int", label: null, source_id: "n-buyer", source_name: "Покупатель",
    target_id: "n-trade", target_name: "Торговля", source_is_intermediate: false, target_is_intermediate: true,
  }],
  descendant_edges: [{
    edge_id: "e-desc", label: null, source_id: "n-bw", source_name: "background-workers",
    target_id: "n-es", target_name: "email-senders", source_is_part: false,
  }],
  isolated_groups: [
    { node_ids: ["g1a", "g1b"], node_names: ["Витрина", "Каталог"] },
    { node_ids: ["g2a"], node_names: ["Отгрузка"] },
  ],
  container_own_docs: [{
    node_id: "n-own", node_name: "Биллинг-система", element_effective: "system",
    has_docs: false, has_spec: true, has_config: false,
  }],
  component_facts: [{
    node_id: "n-comp", node_name: "orders/api", container_id: "n-orders", container_name: "orders",
    has_spec: true, has_config: true, has_sites: false,
  }],
  unresolved_data_refs: [{
    node_id: "n-data", node_name: "Платежи", doc_id: "d1", doc_name: "POST /pay",
    ref: "ordrs.status", mode: "write", reason: "unknown_table",
  }],
  unresolved_channel_refs: [{
    node_id: "n-chan", node_name: "Заказы", doc_id: "d2", doc_name: "POST /orders",
    ref: "создание", mode: "publish", reason: "unknown_channel",
  }],
  unresolved_config_refs: [{
    node_id: "n-conf", node_name: "Поиск", doc_id: "d3", doc_name: "Переиндексация",
    ref: "FEATURE_Y", container_id: "n-conf", container_name: "Поиск",
  }],
  broker_edge_channels: [{
    edge_id: "e-broker", source_name: "orders", target_name: "Kafka", broker_name: "Kafka",
    channel: null, reason: "missing",
  }],
  dangling_messages: [{
    process_id: "p-dang", process_name: "Оформление заказа", message_id: "m1",
    caption: "создать заказ", from_name: "Фронт", to_name: "Бэкенд",
  }],
  orphan_legs: [{
    process_id: "p-orph", process_name: "Оплата заказа", message_id: "m2",
    caption: "статус оплаты", edge_label: "orders.events", from_name: "Фронт", to_name: "Бэкенд",
  }],
  unbound_participants: [{ process_id: "p-unb", process_name: "Исполнение заказа", participant_id: "u1", name: "Склад" }],
  unlinked_messages: [{
    process_id: "p-unl", process_name: "Возврат", message_id: "m3",
    caption: "вернуть деньги", from_name: "Фронт", to_name: "Бэкенд",
  }],
  undescribed_docs: [{ node_id: "n-und", node_name: "Сервис заказов", count: 13 }],
  persons_inside: [{ node_id: "n-pers", node_name: "Кладовщик", parent_id: "n-log", parent_name: "Логистика" }],
};

// Порядок разделов в панели (он же порядок у MCP, mcp/tests/test_alerts_render.py).
const ORDER = [
  "Документацию пора обновить",
  "Объекты без связей",
  "Связи в систему или контейнер",
  "Связи с собственной частью",
  "Изолированные группы",
  "Системы и контейнеры со своей документацией",
  "Конфигурация и спецификации у компонентов",
  "Обращения к неописанным данным",
  "Обращения к неописанным каналам",
  "Обращения к неописанным параметрам",
  "Связи с брокером без канала",
  "Незадокументированные сообщения",
  "Ответ на асинхронном канале",
  "Незадокументированные участники",
  "Шаги без схемы логики",
  "Объекты с неописанными схемами логики",
  "Пользователи внутри системы",
];

type Goal = { locate: LocateTarget } | { process: string };

// Строка каждого класса (по имени кнопки-строки) и куда она ведёт.
const ROWS: [string, RegExp, Goal][] = [
  ["Документацию пора обновить", /github\.com\/yarmarka\/orders/, { locate: { kind: "node", id: "n-cc" } }],
  ["Объекты без связей", /^Уведомления$/, { locate: { kind: "node", id: "n-dis" } }],
  ["Связи в систему или контейнер", /Покупатель.*Торговля/, { locate: { kind: "edge", id: "e-int" } }],
  ["Связи с собственной частью", /background-workers → email-senders/, { locate: { kind: "edge", id: "e-desc" } }],
  ["Изолированные группы", /Витрина, Каталог/, { locate: { kind: "group", ids: ["g1a", "g1b"] } }],
  ["Системы и контейнеры со своей документацией", /Биллинг-система/, { locate: { kind: "node", id: "n-own" } }],
  ["Конфигурация и спецификации у компонентов", /orders\/api/, { locate: { kind: "node", id: "n-comp" } }],
  ["Обращения к неописанным данным", /«ordrs\.status»/, { locate: { kind: "node", id: "n-data" } }],
  ["Обращения к неописанным каналам", /«создание»/, { locate: { kind: "node", id: "n-chan" } }],
  ["Обращения к неописанным параметрам", /«FEATURE_Y»/, { locate: { kind: "node", id: "n-conf" } }],
  ["Связи с брокером без канала", /orders → Kafka/, { locate: { kind: "edge", id: "e-broker" } }],
  ["Незадокументированные сообщения", /«создать заказ»/, { process: "p-dang" }],
  ["Ответ на асинхронном канале", /«статус оплаты»/, { process: "p-orph" }],
  ["Незадокументированные участники", /Исполнение заказа/, { process: "p-unb" }],
  ["Шаги без схемы логики", /«вернуть деньги»/, { process: "p-unl" }],
  ["Объекты с неописанными схемами логики", /Сервис заказов/, { locate: { kind: "node", id: "n-und" } }],
  ["Пользователи внутри системы", /Кладовщик/, { locate: { kind: "node", id: "n-pers" } }],
];

function setup(alerts: Alerts = ALL) {
  const onLocate = vi.fn();
  const onOpenProcess = vi.fn();
  render(<SchemaAlerts alerts={alerts} onLocate={onLocate} onOpenProcess={onOpenProcess} />);
  return { onLocate, onOpenProcess };
}

const lamp = () => screen.getByRole("button", { name: "Рекомендации" });
const openPanel = () => userEvent.click(lamp());

function expectGoal(goal: Goal, onLocate: ReturnType<typeof vi.fn>, onOpenProcess: ReturnType<typeof vi.fn>) {
  if ("locate" in goal) {
    expect(onLocate).toHaveBeenCalledExactlyOnceWith(goal.locate);
    expect(onOpenProcess).not.toHaveBeenCalled();
  } else {
    expect(onOpenProcess).toHaveBeenCalledExactlyOnceWith(goal.process);
    expect(onLocate).not.toHaveBeenCalled();
  }
}

describe("SchemaAlerts: механика панели", () => {
  it("17 разделов идут в прежнем порядке, каждый один раз", async () => {
    setup();
    await openPanel();
    const titles = ORDER.map((t) => screen.getByText(t));
    for (let i = 1; i < titles.length; i++) {
      expect(titles[i - 1].compareDocumentPosition(titles[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // В фикстуре строка на класс (у групп две): число строк-кнопок сходится.
    const rows = screen.getByRole("dialog", { name: "Рекомендации" }).querySelectorAll('[role="button"]');
    expect(rows).toHaveLength(18);
  });

  it.each(ROWS)("щелчок по строке раздела «%s» ведёт к цели и закрывает панель", async (_title, name, goal) => {
    const { onLocate, onOpenProcess } = setup();
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name }));
    expectGoal(goal, onLocate, onOpenProcess);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lamp()).toHaveAttribute("aria-expanded", "false");
  });

  it.each(ROWS.filter(([t]) => [
    "Связи в систему или контейнер", "Изолированные группы", "Связи с брокером без канала",
    "Незадокументированные сообщения", "Незадокументированные участники",
  ].includes(t)))("Enter по строке раздела «%s» ведёт к цели и закрывает панель", async (_title, name, goal) => {
    const { onLocate, onOpenProcess } = setup();
    await openPanel();
    fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
    expectGoal(goal, onLocate, onOpenProcess);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Служебных склеек через точку в строках нет (редизайн, фаза 10): части строки
  // разделяют косая черта, запятая или тихий цвет.
  it("в панели со всеми классами нет склеек « · »", async () => {
    setup();
    await openPanel();
    expect(screen.getByRole("dialog", { name: "Рекомендации" }).textContent).not.toMatch(/·/);
  });

  it("после перехода по строке лампа снова открывает панель", async () => {
    const { onLocate } = setup();
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name: /^Уведомления$/ }));
    expect(onLocate).toHaveBeenCalledOnce();
    await openPanel();
    expect(screen.getByRole("dialog", { name: "Рекомендации" })).toBeInTheDocument();
  });

  it("одна изолированная группа точку не зажигает, две зажигают (в общее число идёт групп минус одна)", () => {
    const { unmount } = render(<SchemaAlerts alerts={{ ...EMPTY, isolated_groups: [ALL.isolated_groups[0]] }} />);
    expect(lamp().querySelector(".sa-dot")).toBeNull();
    unmount();
    render(<SchemaAlerts alerts={{ ...EMPTY, isolated_groups: ALL.isolated_groups }} />);
    expect(lamp().querySelector(".sa-dot")).not.toBeNull();
  });

  it("кнопка: aria-expanded повторяет состояние панели, панель — dialog «Рекомендации»", async () => {
    setup();
    expect(lamp()).toHaveAttribute("aria-expanded", "false");
    await openPanel();
    expect(lamp()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Рекомендации" })).toBeInTheDocument();
    await openPanel();
    expect(lamp()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
