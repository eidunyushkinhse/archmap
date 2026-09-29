// Панель «Рекомендации» (алерты схемы, спека alerts.md AL10–AL15): кнопка-лампочка
// с точкой вместо числа, панель «чистым списком» и разделы классов алертов.
//
// Процессные разделы отличаются от остальных классов: чинить повисшее сообщение
// на холсте нечего — связь удалена, а само сообщение живёт в процессе. Поэтому
// строка кликабельна ТОЛЬКО там, где переход в процесс передан (onOpenProcess),
// и молчит там, где его нет.
import { fireEvent, render, screen } from "@testing-library/react";
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
  unresolved_channel_refs: [],
  unresolved_config_refs: [],
  broker_edge_channels: [],
  descendant_edges: [],
  unlinked_messages: [],
  undescribed_docs: [],
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
  await userEvent.click(screen.getByRole("button", { name: "Рекомендации" }));
}

// Точка на кнопке — единственный след общего числа: класс, попавший в сумму,
// её зажигает. Числа на кнопке нет.
function dot(): Element | null {
  return document.querySelector(".sa-btn .sa-dot");
}

// ── Кнопка и панель (подача «А1. Чистый список», 2026-09-29) ─────────────────
// Рекомендации смотрят по желанию, а не под давлением: кнопка видна всегда,
// число заменено точкой, панель без иконок и цвета, у пустой схемы — пустое
// состояние вместо исчезающей кнопки и тоста.
const DISCONNECTED = { node_id: "n-7", node_name: "Уведомления" };

describe("SchemaAlerts: кнопка «Рекомендации»", () => {
  it("при нуле рекомендаций кнопка есть, точки нет", () => {
    render(<SchemaAlerts alerts={EMPTY} />);

    const btn = screen.getByRole("button", { name: "Рекомендации" });
    expect(btn.getAttribute("title")).toBe("Рекомендации");
    expect(dot()).toBeNull();
  });

  it("при total > 0 горит точка, числа на кнопке нет", () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, disconnected_nodes: [DISCONNECTED, { ...DISCONNECTED, node_id: "n-8" }] }} />);

    expect(dot()).not.toBeNull();
    // Имя кнопки не несёт числа, в её тексте цифр нет: точка — не счётчик долга.
    const btn = screen.getByRole("button", { name: "Рекомендации" });
    expect(btn.textContent ?? "").not.toMatch(/\d/);
  });

  it("рост и обнуление: ни числа, ни пульса, ни тоста — только точка гаснет", () => {
    const { rerender } = render(<SchemaAlerts alerts={{ ...EMPTY, disconnected_nodes: [DISCONNECTED] }} />);
    rerender(
      <SchemaAlerts alerts={{ ...EMPTY, disconnected_nodes: [DISCONNECTED, { ...DISCONNECTED, node_id: "n-8" }] }} />,
    );
    expect(document.querySelector(".sa-ring")).toBeNull();

    rerender(<SchemaAlerts alerts={EMPTY} />);

    // Кнопка на месте, точка погасла, «Схема завершена» больше не всплывает.
    expect(screen.getByRole("button", { name: "Рекомендации" })).toBeTruthy();
    expect(dot()).toBeNull();
    expect(screen.queryByText(/Схема завершена/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("на холсте кнопка той же формы, но с тенью; размер задаёт место", () => {
    const { unmount } = render(<SchemaAlerts alerts={EMPTY} placement="canvas" />);
    const onCanvas = screen.getByRole("button", { name: "Рекомендации" });
    expect(onCanvas.className).toContain("sa-btn--canvas");
    expect(onCanvas.style.width).toBe("32px");
    unmount();

    render(<SchemaAlerts alerts={EMPTY} size={34} />);
    const inHeader = screen.getByRole("button", { name: "Рекомендации" });
    expect(inHeader.className).not.toContain("sa-btn--canvas");
    expect(inHeader.style.width).toBe("34px");
  });
});

describe("SchemaAlerts: панель «Рекомендации»", () => {
  it("пустое состояние: «Рекомендаций нет. Схема описана полностью.»", async () => {
    render(<SchemaAlerts alerts={EMPTY} />);
    await openPanel();

    expect(screen.getByRole("dialog", { name: "Рекомендации" })).toBeTruthy();
    expect(screen.getByText("Рекомендаций нет. Схема описана полностью.")).toBeTruthy();
    // Подзаголовок про «что ещё дополнить» при пустой панели не нужен.
    expect(screen.queryByText("Что ещё можно дополнить в схеме.")).toBeNull();
  });

  it("заголовок, подзаголовок и разделы подписью с числом; слова «алерт» нет", async () => {
    render(
      <SchemaAlerts
        alerts={{ ...EMPTY, disconnected_nodes: [DISCONNECTED, { ...DISCONNECTED, node_id: "n-8", node_name: "Поиск" }] }}
      />,
    );
    await openPanel();

    const panel = screen.getByRole("dialog", { name: "Рекомендации" });
    expect(screen.getByRole("heading", { name: "Рекомендации" })).toBeTruthy();
    expect(screen.getByText("Что ещё можно дополнить в схеме.")).toBeTruthy();
    const head = screen.getByText("Объекты без связей").closest(".sa-sec-head");
    expect(head?.textContent).toBe("Объекты без связей2");
    expect(screen.queryByText(/Рекомендаций нет/)).toBeNull();
    expect(panel.textContent ?? "").not.toMatch(/алерт|незавершённ/i);
  });

  it("пункт — текст со стрелкой «→» и подсказкой «Показать на схеме»; без перехода их нет", async () => {
    const { unmount } = render(
      <SchemaAlerts alerts={{ ...EMPTY, disconnected_nodes: [DISCONNECTED] }} onLocate={vi.fn()} />,
    );
    await openPanel();
    const row = screen.getByText("Уведомления").closest(".sa-item");
    expect(row?.getAttribute("role")).toBe("button");
    expect(row?.getAttribute("title")).toBe("Показать на схеме");
    expect(row?.querySelector(".sa-go")?.textContent).toBe("→");
    // Стрелка — украшение: в имя кнопки-пункта она не входит.
    expect(screen.getByRole("button", { name: "Уведомления" })).toBeTruthy();
    unmount();

    render(<SchemaAlerts alerts={{ ...EMPTY, disconnected_nodes: [DISCONNECTED] }} />);
    await openPanel();
    const still = screen.getByText("Уведомления").closest(".sa-item");
    expect(still?.getAttribute("title")).toBeNull();
    expect(still?.querySelector(".sa-go")).toBeNull();
  });

  it("клавиатура: Enter и пробел ведут к цели и закрывают панель", async () => {
    const onLocate = vi.fn();
    render(<SchemaAlerts alerts={{ ...EMPTY, disconnected_nodes: [DISCONNECTED] }} onLocate={onLocate} />);
    await openPanel();

    fireEvent.keyDown(screen.getByRole("button", { name: "Уведомления" }), { key: "Enter" });
    expect(onLocate).toHaveBeenCalledWith({ kind: "node", id: "n-7" });
    expect(screen.queryByRole("dialog")).toBeNull();

    await openPanel();
    fireEvent.keyDown(screen.getByRole("button", { name: "Уведомления" }), { key: " " });
    expect(onLocate).toHaveBeenCalledTimes(2);
  });

  it("закрывается повторным кликом, кликом вне и Escape", async () => {
    render(<SchemaAlerts alerts={EMPTY} />);

    await openPanel();
    await openPanel();
    expect(screen.queryByRole("dialog")).toBeNull();

    await openPanel();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();

    await openPanel();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("SchemaAlerts: шаги без схемы логики (AL34)", () => {
  // Алерт ПОЛНОТЫ (решение Р4): любой шаг с doc_id = NULL, включая самосообщения.
  // Не «сломалось», а «не документировано» — гаснет привязкой шагов к схемам.
  const UNLINKED = {
    process_id: "proc-1",
    process_name: "Оформление заказа",
    message_id: "msg-2",
    caption: "номер заказа",
    from_name: "Сервис заказов",
    to_name: "Покупатель",
  };

  it("зажигает точку и ведёт в процесс", async () => {
    const onOpenProcess = vi.fn();
    render(
      <SchemaAlerts alerts={{ ...EMPTY, unlinked_messages: [UNLINKED] }} onOpenProcess={onOpenProcess} />,
    );

    expect(dot()).not.toBeNull();
    await openPanel();
    expect(screen.getByText("Шаги без схемы логики")).toBeTruthy();
    expect(screen.getByText("Сервис заказов → Покупатель")).toBeTruthy();

    await userEvent.click(screen.getByText(/Оформление заказа/));

    expect(onOpenProcess).toHaveBeenCalledWith("proc-1");
  });
});

describe("SchemaAlerts: объекты с неописанными схемами логики (AL35)", () => {
  // Одна строка на объект, а не на заглушку: после разведки монолита заглушек две
  // сотни, и панель из двухсот строк — стена. Построчный бэклог — на странице объекта.
  const UNDESCRIBED = { node_id: "n-1", node_name: "Сервис заказов", count: 13 };

  it("объект с заглушками — одна строка, строка ведёт к объекту", async () => {
    const onLocate = vi.fn();
    render(<SchemaAlerts alerts={{ ...EMPTY, undescribed_docs: [UNDESCRIBED] }} onLocate={onLocate} />);

    expect(dot()).not.toBeNull();
    await openPanel();
    expect(screen.getByText("Объекты с неописанными схемами логики")).toBeTruthy();
    expect(screen.getByText("13 схем")).toBeTruthy();

    await userEvent.click(screen.getByText("Сервис заказов"));

    expect(onLocate).toHaveBeenCalledWith({ kind: "node", id: "n-1" });
  });
});

describe("SchemaAlerts: сообщения без связи", () => {
  it("зажигает точку на кнопке", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, dangling_messages: [DANGLING] }} />);

    // Точка горит только при ненулевом total — значит новый класс в сумму входит.
    expect(dot()).not.toBeNull();
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
  it("зажигает точку на кнопке", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, unbound_participants: [UNBOUND] }} />);

    expect(dot()).not.toBeNull();
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

  it("входит в общее число: зажигает точку на кнопке", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, orphan_legs: [ORPHAN_LEG] }} />);

    expect(dot()).not.toBeNull();
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

    // Точка горит только при ненулевом total — значит класс входит в общее число.
    expect(dot()).not.toBeNull();
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

const BROKEN_CHANNEL = {
  node_id: "n1",
  node_name: "Заказы",
  doc_id: "d1",
  doc_name: "POST /orders",
  ref: "создание",
  mode: "publish" as const,
  reason: "unknown_channel" as const,
};

describe("SchemaAlerts: обращения к неописанным каналам", () => {
  it("строка называет объект, док, пометку и причину", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, unresolved_channel_refs: [BROKEN_CHANNEL] }} />);

    // Точка горит только при ненулевом total — значит класс входит в общее число.
    expect(dot()).not.toBeNull();
    await openPanel();

    expect(screen.getByText("Обращения к неописанным каналам")).toBeTruthy();
    expect(screen.getByText(/Заказы · POST \/orders/)).toBeTruthy();
    expect(screen.getByText("„создание“")).toBeTruthy();
    expect(screen.getByText(/канал не найден у брокеров проекта/)).toBeTruthy();
  });

  it("причина зависит от reason, и неоднозначность зовёт квалификатор БРОКЕРА", async () => {
    const { unmount } = render(
      <SchemaAlerts alerts={{ ...EMPTY, unresolved_channel_refs: [{ ...BROKEN_CHANNEL, reason: "ambiguous" }] }} />,
    );
    await openPanel();
    // «БД / таблица» здесь послало бы чинить не туда — слова свои.
    expect(screen.getByText(/имя неоднозначно — укажите „Брокер \/ канал“/)).toBeTruthy();
    unmount();

    render(
      <SchemaAlerts alerts={{ ...EMPTY, unresolved_channel_refs: [{ ...BROKEN_CHANNEL, reason: "unknown_field" }] }} />,
    );
    await openPanel();
    expect(screen.getByText(/поля нет в канале/)).toBeTruthy();
  });

  it("класс отдельный от данных: секции не смешиваются", async () => {
    render(
      <SchemaAlerts
        alerts={{ ...EMPTY, unresolved_data_refs: [BROKEN_REF], unresolved_channel_refs: [BROKEN_CHANNEL] }}
      />,
    );
    // Оба класса входят в общее число рекомендаций.
    expect(dot()).not.toBeNull();
    await openPanel();

    expect(screen.getByText("Обращения к неописанным данным")).toBeTruthy();
    expect(screen.getByText("Обращения к неописанным каналам")).toBeTruthy();
    expect(screen.getByText("„ordrs.status“")).toBeTruthy();
    expect(screen.getByText("„создание“")).toBeTruthy();
  });

  it("ведёт к узлу-владельцу дока: чинится текст пометки, а не структура брокера", async () => {
    const onLocate = vi.fn();
    render(
      <SchemaAlerts alerts={{ ...EMPTY, unresolved_channel_refs: [BROKEN_CHANNEL] }} onLocate={onLocate} />,
    );
    await openPanel();

    await userEvent.click(screen.getByText("„создание“"));

    expect(onLocate).toHaveBeenCalledWith({ kind: "node", id: "n1" });
  });

  it("пустая группа не рендерится", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, unresolved_data_refs: [BROKEN_REF] }} />);
    await openPanel();

    expect(screen.queryByText("Обращения к неописанным каналам")).toBeNull();
  });
});

// ── Связи с брокером без канала (AL31) ───────────────────────────────────────
// Стрелка «сервис → брокер» обязана назвать топик (решение пользователя №4). Канал —
// ссылка по ИМЕНИ, не FK, поэтому шов «стрелка ↔ структура брокера» виден только здесь.
// Чинится в инспекторе самой связи, поэтому строка ведёт К СВЯЗИ, а не к брокеру.

const BROKER_EDGE = {
  edge_id: "e1",
  source_name: "orders",
  target_name: "Kafka",
  broker_name: "Kafka",
  channel: null as string | null,
  reason: "missing" as const,
};

describe("SchemaAlerts: связи с брокером без канала", () => {
  it("связь без канала названа концами и зажигает точку", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, broker_edge_channels: [BROKER_EDGE] }} />);

    expect(dot()).not.toBeNull();
    await openPanel();

    expect(screen.getByText("Связи с брокером без канала")).toBeTruthy();
    expect(screen.getByText(/orders → Kafka/)).toBeTruthy();
    expect(screen.getByText(/канал не указан/)).toBeTruthy();
  });

  it("неизвестный канал показан вместе с брокером, у которого его искали", async () => {
    render(
      <SchemaAlerts
        alerts={{
          ...EMPTY,
          broker_edge_channels: [{ ...BROKER_EDGE, channel: "orders.creted", reason: "unknown" }],
        }}
      />,
    );
    await openPanel();

    // Причины разные по смыслу починки: дописать канал ≠ исправить опечатку/описать канал.
    expect(screen.getByText("«orders.creted»")).toBeTruthy();
    expect(screen.getByText(/не найден у брокера «Kafka»/)).toBeTruthy();
    expect(screen.queryByText(/канал не указан/)).toBeNull();
  });

  it("ведёт к СВЯЗИ на схеме: канал правится в её инспекторе", async () => {
    const onLocate = vi.fn();
    render(
      <SchemaAlerts alerts={{ ...EMPTY, broker_edge_channels: [BROKER_EDGE] }} onLocate={onLocate} />,
    );
    await openPanel();

    await userEvent.click(screen.getByText(/orders → Kafka/));

    expect(onLocate).toHaveBeenCalledWith({ kind: "edge", id: "e1" });
  });

  it("пустая группа не рендерится", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, unresolved_data_refs: [BROKEN_REF] }} />);
    await openPanel();

    expect(screen.queryByText("Связи с брокером без канала")).toBeNull();
  });
});

// ── Связи в собственный компонент (AL32) ─────────────────────────────────────
// Совет здесь ПРОТИВОПОЛОЖЕН соседней секции «Связи в контейнер»: не «уточните конец
// до компонента» (конец уже компонент — этого же контейнера), а «удалите или
// перевесьте». Паритет с превью импорта (К4): два взаимоисключающих совета на одну
// связь — то, ради чего класс и заведён.

const SELF_NEST = {
  edge_id: "e9",
  label: null as string | null,
  source_id: "n1",
  source_name: "background-workers",
  target_id: "n2",
  target_name: "email-senders",
  source_is_part: false,
};

describe("SchemaAlerts: связи в собственный компонент", () => {
  it("названа концами, объясняет вложенность и зажигает точку", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, descendant_edges: [SELF_NEST] }} />);

    expect(dot()).not.toBeNull();
    await openPanel();

    expect(screen.getByText("Связи в собственный компонент")).toBeTruthy();
    expect(screen.getByText(/background-workers → email-senders/)).toBeTruthy();
    // Часть подсвечена как конец-нарушитель, целое названо рядом.
    expect(screen.getByText("«email-senders»")).toBeTruthy();
    expect(screen.getByText(/часть «background-workers»/)).toBeTruthy();
    expect(screen.getByText(/удалите связь или перевесьте её/)).toBeTruthy();
  });

  it("обратное направление называет частью источник", async () => {
    render(
      <SchemaAlerts
        alerts={{
          ...EMPTY,
          descendant_edges: [{
            ...SELF_NEST,
            source_name: "email-senders",
            target_name: "background-workers",
            source_is_part: true,
          }],
        }}
      />,
    );
    await openPanel();

    expect(screen.getByText("«email-senders»")).toBeTruthy();
    expect(screen.getByText(/часть «background-workers»/)).toBeTruthy();
  });

  it("ведёт к СВЯЗИ на схеме: чинится сама связь", async () => {
    const onLocate = vi.fn();
    render(
      <SchemaAlerts alerts={{ ...EMPTY, descendant_edges: [SELF_NEST] }} onLocate={onLocate} />,
    );
    await openPanel();

    await userEvent.click(screen.getByText(/background-workers → email-senders/));

    expect(onLocate).toHaveBeenCalledWith({ kind: "edge", id: "e9" });
  });

  it("пустая группа не рендерится", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, unresolved_data_refs: [BROKEN_REF] }} />);
    await openPanel();

    expect(screen.queryByText("Связи в собственный компонент")).toBeNull();
  });
});

const BROKEN_PARAM = {
  node_id: "n1",
  node_name: "Заказы",
  doc_id: "d1",
  doc_name: "POST /orders",
  ref: "FEATURE_Y",
};

describe("SchemaAlerts: обращения к неописанным параметрам", () => {
  it("строка называет объект, док, пометку и оба выхода починки", async () => {
    render(<SchemaAlerts alerts={{ ...EMPTY, unresolved_config_refs: [BROKEN_PARAM] }} />);

    expect(dot()).not.toBeNull();
    await openPanel();

    expect(screen.getByText("Обращения к неописанным параметрам")).toBeTruthy();
    expect(screen.getByText(/Заказы · POST \/orders/)).toBeTruthy();
    expect(screen.getByText("„FEATURE_Y“")).toBeTruthy();
    // Класс ловит и прозу («зависит от: нагрузки») — подсказка обязана называть
    // второй выход, иначе такая строка читается как шум продукта.
    expect(screen.getByText(/параметра нет в конфигурации объекта/)).toBeTruthy();
    expect(screen.getByText(/уберите двоеточие/)).toBeTruthy();
  });

  it("три семьи пометок живут отдельными секциями", async () => {
    render(
      <SchemaAlerts
        alerts={{
          ...EMPTY,
          unresolved_data_refs: [BROKEN_REF],
          unresolved_channel_refs: [BROKEN_CHANNEL],
          unresolved_config_refs: [BROKEN_PARAM],
        }}
      />,
    );
    expect(dot()).not.toBeNull();
    await openPanel();

    expect(screen.getByText("Обращения к неописанным данным")).toBeTruthy();
    expect(screen.getByText("Обращения к неописанным каналам")).toBeTruthy();
    expect(screen.getByText("Обращения к неописанным параметрам")).toBeTruthy();
  });

  it("ведёт к узлу-владельцу: он же владелец параметра", async () => {
    const onLocate = vi.fn();
    render(
      <SchemaAlerts alerts={{ ...EMPTY, unresolved_config_refs: [BROKEN_PARAM] }} onLocate={onLocate} />,
    );
    await openPanel();

    await userEvent.click(screen.getByText("„FEATURE_Y“"));

    expect(onLocate).toHaveBeenCalledWith({ kind: "node", id: "n1" });
  });
});
