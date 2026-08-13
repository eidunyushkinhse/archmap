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
  unbound_participants: [], orphan_legs: [],
  unresolved_data_refs: [],
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
    expect(screen.getByText("Незадокументированные сообщения")).toBeTruthy();
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

// ── Незадокументированные участники (AL27) ───────────────────────────────────
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
    expect(screen.getByText("Незадокументированные участники")).toBeTruthy();
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

// ── Ответ на асинхронном канале (AL28) ───────────────────────────────────────
// Связь на месте, а плеча «ответ» у неё больше нет: канал сменили на асинхронный
// уже после того, как шаг создан. Отдельный класс от «сообщений без связи» —
// «Восстановить связи» такой шаг не чинит.
const ORPHAN_LEG = {
  process_id: "proc-9",
  process_name: "Оформление заказа",
  message_id: "msg-9",
  caption: "номер заказа",
  edge_label: "оформить заказ",
  from_name: "Сервис заказов",
  to_name: "Покупатель",
};

describe("SchemaAlerts: ответ на асинхронном канале", () => {
  it("строка называет процесс, шаг и канал", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, orphan_legs: [ORPHAN_LEG] }} />);
    await openPanel();

    expect(screen.getByText(/«номер заказа»/)).toBeTruthy();
    expect(screen.getByText(/канал «оформить заказ»/)).toBeTruthy();
  });

  it("считается в общей незавершённости", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, orphan_legs: [ORPHAN_LEG] }} />);

    expect(screen.getByRole("button", { name: /Незавершённость схемы/i }).textContent)
      .toContain("1");
  });

  it("строка ведёт В ПРОЦЕСС — чинить на холсте нечего", async () => {
    const onOpenProcess = vi.fn();
    render(<SchemaAlerts alerts={{ ...EMPTY, orphan_legs: [ORPHAN_LEG] }} onOpenProcess={onOpenProcess} />);
    await openPanel();

    await userEvent.click(screen.getByText(/«номер заказа»/));

    expect(onOpenProcess).toHaveBeenCalledWith("proc-9");
  });
});

// ── Обращения к неописанным данным (AL29) ────────────────────────────────────
// Пометка «читает:/пишет:» в схеме логики — обещание факта. Невыполненное обещание
// молчать не должно: обратный индекс базы такую пометку не показывает вовсе, а
// битую КОЛОНКУ показывает как обращение к таблице целиком — панель остаётся
// единственным местом, где расхождение текста со структурой видно.
const BROKEN_REF = {
  node_id: "n1",
  node_name: "Биллинг",
  doc_id: "d1",
  doc_name: "POST /pay",
  ref: "ordrs.status",
  mode: "write" as const,
  reason: "unknown_table" as const,
};

describe("SchemaAlerts: обращения к неописанным данным", () => {
  it("строка называет объект, док, пометку и причину", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, unresolved_data_refs: [BROKEN_REF] }} />);

    // Знак есть только при ненулевом total — значит класс входит в общий счётчик.
    expect(screen.getByRole("button", { name: "Незавершённость схемы: 1" })).toBeTruthy();
    await openPanel();

    expect(screen.getByText("Обращения к неописанным данным")).toBeTruthy();
    expect(screen.getByText(/Биллинг · POST \/pay/)).toBeTruthy();
    expect(screen.getByText("„ordrs.status“")).toBeTruthy();
    // Причина — не украшение: без неё непонятно, что чинить.
    expect(screen.getByText(/таблица не найдена/)).toBeTruthy();
  });

  it("причина зависит от reason", async () => {
    const { unmount } = render(
      <SchemaAlerts alerts={{ ...EMPTY, unresolved_data_refs: [{ ...BROKEN_REF, reason: "ambiguous" }] }} />,
    );
    await openPanel();
    // Неоднозначность лечится квалификатором — текст обязан его назвать.
    expect(screen.getByText(/имя неоднозначно — укажите „БД \/ таблица“/)).toBeTruthy();
    unmount();

    render(
      <SchemaAlerts alerts={{ ...EMPTY, unresolved_data_refs: [{ ...BROKEN_REF, reason: "unknown_column" }] }} />,
    );
    await openPanel();
    expect(screen.getByText(/колонки нет в таблице/)).toBeTruthy();
  });

  it("ведёт к узлу-владельцу дока: чинится текст пометки, а не структура базы", async () => {
    const onLocate = vi.fn();
    render(<SchemaAlerts alerts={{ ...EMPTY, unresolved_data_refs: [BROKEN_REF] }} onLocate={onLocate} />);
    await openPanel();

    await userEvent.click(screen.getByText("„ordrs.status“"));

    expect(onLocate).toHaveBeenCalledWith({ kind: "node", id: "n1" });
  });

  it("пустая группа не рендерится", async () => {
    // Как и остальные категории: пустая секция в панели не появляется.
    render(<SchemaAlerts alerts={{ ...EMPTY, dangling_messages: [DANGLING] }} />);
    await openPanel();

    expect(screen.queryByText("Обращения к неописанным данным")).toBeNull();
  });
});
