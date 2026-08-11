// Панель «Незавершённость схемы»: секция повисших сообщений процессов.
//
// Она отличается от остальных классов: чинить повисшее сообщение на холсте
// нечего — связь удалена, а само сообщение живёт в процессе. Поэтому строка
// кликабельна ТОЛЬКО там, где переход в процесс существует (оболочка страниц),
// и молчит там, где его нет (редактор-карта — отдельный роут).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import SchemaAlerts from "../SchemaAlerts";
import type { SchemaAlerts as Alerts } from "../../types";

const EMPTY: Alerts = {
  disconnected_nodes: [],
  intermediate_edges: [],
  isolated_groups: [],
  container_own_docs: [],
  persons_inside: [],
  dangling_messages: [],
  unbound_participants: [],
};

const DANGLING = {
  process_id: "proc-1",
  process_name: "Оформление заказа",
  message_id: "msg-1",
  caption: "создать заказ",
  from_name: "Покупатель",
  to_name: "Сервис заказов",
};

async function openPanel() {
  await userEvent.click(screen.getByRole("button", { name: /Незавершённость схемы/i }));
}

describe("SchemaAlerts: сообщения без связи", () => {
  it("зажигает знак и считается в общем счётчике", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, dangling_messages: [DANGLING] }} />);

    // Знак есть только при ненулевом total — значит новый класс в сумму входит.
    expect(screen.getByRole("button", { name: "Незавершённость схемы: 1" })).toBeTruthy();
    await openPanel();
    expect(screen.getByText("Сообщения без связи")).toBeTruthy();
    expect(screen.getByText(/Оформление заказа/)).toBeTruthy();
    expect(screen.getByText("Покупатель → Сервис заказов")).toBeTruthy();
  });

  it("без обработчика перехода строка НЕ кликабельна", async () => {
    // Редактор-карта: onOpenProcess не передан — строка не должна прикидываться
    // кнопкой, ведущей в никуда.
    render(<SchemaAlerts alerts={{ ...EMPTY, dangling_messages: [DANGLING] }} onLocate={vi.fn()} />);
    await openPanel();

    const row = screen.getByText(/Оформление заказа/).closest(".sa-item");
    expect(row?.getAttribute("role")).toBeNull();
  });

  it("с обработчиком ведёт в процесс по его id", async () => {
    const onOpenProcess = vi.fn();
    render(<SchemaAlerts alerts={{ ...EMPTY, dangling_messages: [DANGLING] }} onOpenProcess={onOpenProcess} />);
    await openPanel();

    await userEvent.click(screen.getByText(/Оформление заказа/));

    expect(onOpenProcess).toHaveBeenCalledWith("proc-1");
  });

  it("сообщение без подписи показывается явно, а не пустой строкой", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, dangling_messages: [{ ...DANGLING, caption: null }] }} />);
    await openPanel();

    expect(screen.getByText(/без подписи/)).toBeTruthy();
  });
});

// ── Участники без узла схемы (AL27) ───────────────────────────────────────────
// Симметрия повисшему сообщению: линия жизни на диаграмме есть, объекта архитектуры
// за ней нет. Чинится привязкой на шапке участника — поэтому строка ведёт В ПРОЦЕСС,
// а не на холст: на холсте этого участника попросту нет.
const UNBOUND = {
  process_id: "p1",
  process_name: "Оформление заказа",
  participant_id: "u1",
  name: "Биллинг",
};

describe("SchemaAlerts: участники без узла схемы", () => {
  it("зажигает знак и считается в общем счётчике", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, unbound_participants: [UNBOUND] }} />);

    expect(screen.getByRole("button", { name: "Незавершённость схемы: 1" })).toBeTruthy();
    await openPanel();
    expect(screen.getByText("Участники без узла схемы")).toBeTruthy();
    expect(screen.getByText("Биллинг")).toBeTruthy();
  });

  it("ведёт в процесс, а не на холст", async () => {
    const onOpenProcess = vi.fn();
    render(
      <SchemaAlerts
        alerts={{ ...EMPTY, unbound_participants: [UNBOUND] }}
        onLocate={vi.fn()}
        onOpenProcess={onOpenProcess}
      />,
    );
    await openPanel();

    await userEvent.click(screen.getByText("Биллинг"));

    expect(onOpenProcess).toHaveBeenCalledWith("p1");
  });

  it("без обработчика перехода строка НЕ кликабельна", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, unbound_participants: [UNBOUND] }} onLocate={vi.fn()} />);
    await openPanel();

    expect(screen.getByText("Биллинг").closest(".sa-item")?.getAttribute("role")).toBeNull();
  });
});
