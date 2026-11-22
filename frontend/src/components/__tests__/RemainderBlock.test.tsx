// Блок вопросов слияния (§3, §4.6, §8 ТЗ; вид — фаза 8а редизайна) — оркестрация разбора.
//
// Что закрепляем: над вопросом одна строка (тихий «Вопрос N из M» и «Все вопросы»), шапки
// и прогресса точками или полосой нет; выбор варианта НЕ переводит к следующему вопросу;
// ходить можно «Назад/Дальше», списком и стрелками, и ответы при этом не теряются;
// вариант, который действует без ответа, помечен «по умолчанию» у всех пяти видов; «почему
// возник вопрос» и «Если не отвечать» — в подсказке «?»; список показывает у вопроса без
// ответа вариант по умолчанию тихим цветом; двухшаговые вопросы возвращаются к форме без
// потери ответа; итог без счётчика и без строки частей.
//
// Ответы живут у вызывающего (в диалоге) — здесь их держит стенд, как это делает окно.
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import type {
  ContainerEdgeOut, FamilyConflictOut, FieldDisputeOut, FuzzyPairOut,
  IsolatedGroupOut, RemainderOut,
} from "../../types";
import RemainderBlock from "../project/remainder/RemainderBlock";
import { buildQuestions, toDecisions } from "../project/remainder/questions";
import type { Answer, Answers, Question, Resolutions } from "../project/remainder/questions";

vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <div data-testid="mmd">{chart}</div>,
}));

const семья: FamilyConflictOut = {
  id: "doc|Zabbix/server|Опрос", family: "doc", node_path: "Zabbix / server", key: "Опрос",
  candidates: [
    { origin: 0, origin_label: "1 · zabbix.yaml", source_label: "Из файла zabbix.yaml", summary: "12 строк", body: "flowchart TD\n A-->B", truncated: false, current: false },
    { origin: 1, origin_label: "2 · plugin.zip", source_label: "Из архива plugin.zip", summary: "20 строк", body: "flowchart LR\n A-->C", truncated: false, current: false },
  ],
  default: "all", allow_all: true,
};

const поле: FieldDisputeOut = {
  id: "field|Zabbix/server|description", node_path: "Zabbix / server", field: "description",
  candidates: [
    { origin: 0, origin_label: "1 · zabbix.yaml", source_label: "Из файла zabbix.yaml", value: "Ядро", current: false },
    { origin: 1, origin_label: "2 · plugin.zip", source_label: "Из архива plugin.zip", value: "Сервер опроса", current: false },
  ],
  default: 0,
};

const связь: ContainerEdgeOut = {
  id: "edge|Плагин/Датасорс|Zabbix||target", from_path: "Плагин / Датасорс", to_path: "Zabbix",
  label: "запросы", technology: "HTTP", end: "target", container_path: "Zabbix",
  container_element: "container",
  components: [
    { path: "Zabbix / server", has_children: true },
    { path: "Zabbix / Поллер", has_children: false },
  ],
};

const группа: IsolatedGroupOut = { id: "group|Плагин", node_paths: ["Плагин", "Плагин / Датасорс"] };

const пара: FuzzyPairOut = {
  id: "pair|Пользователь Zabbix|Пользователь", a_path: "Пользователь Zabbix", b_path: "Пользователь",
  a_source: "Из файла zabbix.yaml", b_source: "Из архива plugin.zip",
  a_edges: 2, b_edges: 1, where: "на верхнем уровне", a_current: false, b_current: false,
};

const остаток = (over: Partial<RemainderOut> = {}): RemainderOut => ({
  field_conflicts: [поле], container_edges: [связь], isolated_groups: [группа], fuzzy_pairs: [пара],
  unfixable: [], converted_warnings: [],
  node_paths: ["Zabbix", "Zabbix / server", "Плагин", "Плагин / Датасорс"],
  node_has_children: [true, false, true, false],
  node_elements: ["system", "container", "system", "container"], ...over,
});

const ВОПРОСЫ = buildQuestions({ family_conflicts: [семья], remainder: остаток() });

// Стенд с состоянием ответов — так блок живёт в диалоге (Р2). Имя латиницей:
// react-hooks/rules-of-hooks узнаёт компонент по заглавной ЛАТИНСКОЙ букве.
function Stand({ questions = ВОПРОСЫ, onState }: {
  questions?: Question[];
  onState?: (s: { answers: Answers; resolutions: Resolutions }) => void;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [resolutions, setResolutions] = useState<Resolutions>({});
  onState?.({ answers, resolutions });
  return (
    <RemainderBlock
      questions={questions}
      answers={answers}
      resolutions={resolutions}
      onAnswer={(id: string, a: Answer) => setAnswers((cur) => ({ ...cur, [id]: a }))}
      onResolve={(id: string, c: string) => setResolutions((cur) => ({ ...cur, [id]: c }))}
      mode="create"
    />
  );
}

const счётчик = () => screen.getByText(/^Вопрос \d+ из \d+$/).textContent;
const дальше = () => screen.getByRole("button", { name: "Дальше →" });
const заголовок = () => screen.getByRole("heading", { level: 4 });
const строки = () => screen.getAllByRole("button").filter((b) => b.className.includes("rq-ql-r"));
/** Вариант с тегом «по умолчанию» — он один на вопрос. */
const поУмолчанию = () => {
  const теги = document.querySelectorAll(".rq-opt-def");
  expect(теги).toHaveLength(1);
  return теги[0]!.closest("button") as HTMLElement;
};

async function кВопросу(i: number) {
  await userEvent.click(screen.getByRole("button", { name: "Все вопросы" }));
  await userEvent.click(строки()[i]!);
}

describe("строка над вопросом (фаза 8а)", () => {
  it("тихий счётчик и «Все вопросы»; ни шапки, ни прогресса", () => {
    const { container } = render(<Stand />);
    expect(счётчик()).toBe("Вопрос 1 из 5");
    expect(screen.getByRole("button", { name: "Все вопросы" })).toHaveClass("ds-add");
    expect(container.textContent).not.toMatch(/Без ваших решений|Помогите сделать правильно/);
    expect(container.querySelector(".rq-h1, .rq-prog, .rq-dot, .rq-bar")).toBeNull();
    expect(screen.queryByRole("button", { name: /^вопрос \d+$/ })).toBeNull();
    // Нативной раскрывашки и сноски под вариантами больше нет: их тексты в подсказке «?».
    expect(container.querySelector("details, .rq-ifnot")).toBeNull();
    expect(container.textContent).not.toContain("почему возник вопрос");
    expect(container.textContent).not.toContain("Если не отвечать");
  });

  it("на 15 вопросах — тот же счётчик, подписей видов нет", () => {
    const много = buildQuestions({
      family_conflicts: [], remainder: остаток({
        field_conflicts: Array.from({ length: 13 }, (_, i) => ({ ...поле, id: `field|N${i}|role`, node_path: `Узел ${i}` })),
        isolated_groups: [], fuzzy_pairs: [пара],
      }),
    });
    expect(много).toHaveLength(15);
    const { container } = render(<Stand questions={много} />);
    expect(счётчик()).toBe("Вопрос 1 из 15");
    expect(container.textContent).not.toMatch(/Поля|Имена|В систему или контейнер|·/);
  });
});

describe("заголовок и подсказка «?»", () => {
  it("знак «?» сразу за текстом; в подсказке «почему» и «Если не отвечать»", async () => {
    render(<Stand />);
    expect(заголовок().textContent).toBe(
      "У объекта «server» в разных файлах разные схемы логики «Опрос». Какую считаем правильной?");
    const знак = within(заголовок()).getByRole("button", { name: "Почему возник вопрос" });
    await userEvent.click(знак);
    const подсказка = screen.getByRole("dialog", { name: "Почему возник вопрос" });
    const абзацы = within(подсказка).getAllByText(/./, { selector: "p" }).map((p) => p.textContent);
    expect(абзацы).toEqual([
      "Схемы разные (отличаются хотя бы одним символом), а названия одинаковые. Непонятно, какую считать правильной.",
      "Если не отвечать, то будут добавлены все схемы, и при добавлении им будут назначены номера.",
    ]);
  });

  it("первый Escape закрывает только подсказку: вопрос и ответ на месте", async () => {
    const выше = vi.fn();
    render(<Stand />);
    await userEvent.click(screen.getByRole("button", { name: /^Из архива plugin\.zip/ }));
    await userEvent.click(screen.getByRole("button", { name: "Почему возник вопрос" }));
    document.addEventListener("keydown", выше);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Почему возник вопрос" })).toBeNull();
    // Клавиша не ушла выше (окно ввоза закрылось бы вместе с подсказкой).
    expect(выше).not.toHaveBeenCalled();
    expect(счётчик()).toBe("Вопрос 1 из 5");
    expect(screen.getByRole("button", { name: /^Из архива plugin\.zip/ })).toHaveAttribute("aria-pressed", "true");
    // Второй Escape — как раньше: подсказки нет, клавиша идёт окну.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(выше).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", выше);
  });

  it("у второго шага знака «?» нет", async () => {
    render(<Stand />);
    await кВопросу(3);
    await userEvent.click(screen.getAllByRole("button", { name: /^Провести связь/ })[0]!);
    expect(заголовок().textContent).toBe("Связи объектов с остальной схемой");
    expect(screen.queryByRole("button", { name: "Почему возник вопрос" })).toBeNull();
  });
});

describe("тег «по умолчанию» (фаза 8а)", () => {
  it("спор содержимого: «Добавить все» при default «all», кандидат при «cand:<i>»", async () => {
    const { unmount } = render(<Stand />);
    expect(поУмолчанию()).toHaveTextContent(/^Добавить всепо умолчанию$/);
    unmount();
    render(<Stand questions={buildQuestions({
      family_conflicts: [{ ...семья, default: "cand:1", allow_all: false }], remainder: остаток({
        field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
      }),
    })} />);
    expect(поУмолчанию()).toHaveTextContent(/^Из архива plugin\.zip/);
  });

  it("спор поля — кандидат default, связь — «Оставить на …», группа и пара — свои", async () => {
    render(<Stand />);
    await кВопросу(1);
    expect(поУмолчанию()).toHaveTextContent(/^Ядро/);
    await кВопросу(2);
    expect(поУмолчанию()).toHaveTextContent(/^Оставить на контейнере «Zabbix»/);
    await кВопросу(3);
    expect(поУмолчанию()).toHaveTextContent(/^Оставить как есть/);
    await кВопросу(4);
    expect(поУмолчанию()).toHaveTextContent(/^Разные объекты/);
  });

  it("вариант по умолчанию выглядит как остальные: ни пунктира, ни «как сейчас»", async () => {
    const { container } = render(<Stand />);
    for (const i of [2, 3, 4]) {
      await кВопросу(i);
      expect(container.querySelector(".rq-opt--keep")).toBeNull();
      expect(container.textContent).not.toContain("как сейчас");
    }
  });

  it("выбор варианта не переводит дальше и отмечает его", async () => {
    render(<Stand />);
    await userEvent.click(screen.getByRole("button", { name: /^Из архива plugin\.zip/ }));
    expect(счётчик()).toBe("Вопрос 1 из 5");
    expect(screen.getByRole("button", { name: /^Из архива plugin\.zip/ })).toHaveAttribute("aria-pressed", "true");
    // Ничего не было предвыбрано: тег «по умолчанию» — не выбор.
    expect(screen.getByRole("button", { name: /^Добавить все/ })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("переходы", () => {
  it("«Назад» на первом вопросе выключена, «Дальше» на последнем — «Завершить»", async () => {
    render(<Stand />);
    expect(screen.getByRole("button", { name: "← Назад" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "← Назад" })).toHaveClass("ds-add");
    for (let i = 0; i < 4; i++) await userEvent.click(дальше());
    expect(счётчик()).toBe("Вопрос 5 из 5");
    expect(screen.getByRole("button", { name: "Завершить →" })).toBeInTheDocument();
  });

  it("стрелки ← → ходят по вопросам, а в поле ввода — нет", async () => {
    render(<Stand />);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(счётчик()).toBe("Вопрос 2 из 5");
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(счётчик()).toBe("Вопрос 1 из 5");
    // Модификатор — не наш жест (в окне живут свои сочетания).
    fireEvent.keyDown(document.body, { key: "ArrowRight", ctrlKey: true });
    expect(счётчик()).toBe("Вопрос 1 из 5");
    // Курсор в поле: стрелка двигает каретку, а не вопросы.
    const поле_ = document.createElement("input");
    document.body.appendChild(поле_);
    fireEvent.keyDown(поле_, { key: "ArrowRight" });
    expect(счётчик()).toBe("Вопрос 1 из 5");
    поле_.remove();
  });
});

describe("список всех вопросов (§3, фаза 8а)", () => {
  it("до ответов: у каждого вопроса тихим цветом вариант по умолчанию", async () => {
    render(<Stand />);
    await userEvent.click(screen.getByRole("button", { name: "Все вопросы" }));
    // В списке счётчик остаётся, переключатель — «К вопросу».
    expect(счётчик()).toBe("Вопрос 1 из 5");
    expect(screen.getByRole("button", { name: "К вопросу" })).toBeInTheDocument();
    const ответы = строки().map((r) => r.querySelector(".rq-ql-a")!);
    expect(ответы.map((a) => a.textContent)).toEqual([
      "Добавить все", "Ядро", "Оставить на контейнере", "Оставить как есть", "Разные объекты",
    ]);
    for (const a of ответы) expect(a).toHaveClass("rq-ql-a--none");
    expect(screen.queryByText("—")).toBeNull();
    // Строка называет короткую тему, полный вопрос — в подсказке (фаза 8б).
    expect(строки().map((r) => r.querySelector(".rq-ql-q")!.textContent)).toEqual([
      "server, схема логики «Опрос»", "server, описание", "Связь «Датасорс → Zabbix»",
      "2 объекта без связей", "«Пользователь Zabbix» и «Пользователь»",
    ]);
    строки().forEach((r, i) => expect(r.querySelector(".rq-ql-q")).toHaveAttribute("title", ВОПРОСЫ[i]!.title));
    // Текущий вопрос выделен.
    expect(строки()[0]).toHaveClass("rq-ql-r--on");
  });

  it("после ответов: подписи ответов основным цветом, с заглавной", async () => {
    render(<Stand />);
    await userEvent.click(screen.getByRole("button", { name: /^Из архива plugin\.zip/ }));
    await кВопросу(2);
    await userEvent.click(screen.getByRole("button", { name: /Поллер/ }));
    await кВопросу(3);
    await userEvent.click(screen.getByRole("button", { name: /^Оставить как есть/ }));
    await кВопросу(4);
    await userEvent.click(screen.getByRole("button", { name: /^Разные объекты/ }));
    await userEvent.click(screen.getByRole("button", { name: "Все вопросы" }));
    const ответы = строки().map((r) => r.querySelector(".rq-ql-a")!);
    expect(ответы.map((a) => a.textContent)).toEqual([
      "Из архива plugin.zip", "Ядро", "Поллер", "Оставить как есть", "Разные объекты",
    ]);
    expect(ответы.map((a) => a.classList.contains("rq-ql-a--none"))).toEqual([false, true, false, false, false]);
    await userEvent.click(строки()[4]!);
    expect(счётчик()).toBe("Вопрос 5 из 5");
    expect(screen.getByText(/похожие имена/)).toBeInTheDocument();
  });

  it("связь в систему: вариант «Оставить на системе …», в списке «Оставить на системе»", async () => {
    const вопросы = buildQuestions({
      family_conflicts: [],
      remainder: остаток({
        field_conflicts: [], isolated_groups: [], fuzzy_pairs: [],
        container_edges: [{
          ...связь,
          container_element: "system",
          components: [
            { path: "Zabbix / server", has_children: true, element_effective: "container" },
            { path: "Zabbix / Поллер", has_children: false, element_effective: "container" },
          ],
        }],
      }),
    });
    render(<Stand questions={вопросы} />);
    expect(screen.getByText(/приходит в систему «Zabbix»/)).toBeInTheDocument();
    // Тег объекта с вложенными в списке — по его элементу.
    expect(screen.getByText("контейнер")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Оставить на системе «Zabbix»/ }));
    await userEvent.click(screen.getByRole("button", { name: "Все вопросы" }));
    const ответ = строки()[0]!.querySelector(".rq-ql-a")!;
    expect(ответ.textContent).toBe("Оставить на системе");
    expect(ответ).not.toHaveClass("rq-ql-a--none");
  });
});

describe("итог (§8, фаза 8а)", () => {
  it("без ответов: «Осталось N вопросов без ответа», ни счётчика, ни строки частей", async () => {
    const { container } = render(<Stand />);
    await кВопросу(4);
    await userEvent.click(screen.getByRole("button", { name: "Завершить →" }));
    expect(screen.getByText("Осталось 5 вопросов без ответа")).toBeInTheDocument();
    expect(screen.queryByText(/вопрос \d+ из \d+|разбор пройден/i, { selector: ".rq-cnt" })).toBeNull();
    expect(container.querySelector(".rq-cnt")).toBeNull();
    expect(container.textContent).not.toMatch(/перенесено|добавлено|объединено|оставлено/);
    const кнопки = within(container.querySelector(".rq-ft") as HTMLElement).getAllByRole("button");
    expect(кнопки.map((b) => b.textContent)).toEqual(["Вернуться к пропущенным", "Пересмотреть ответы"]);
    for (const b of кнопки) expect(b).toHaveClass("ds-btn");
    await userEvent.click(кнопки[0]!);
    expect(счётчик()).toBe("Вопрос 1 из 5");
  });

  it("с ответами: «Разбор пройден», возвращаться не к чему", async () => {
    const qs = buildQuestions({
      family_conflicts: [], remainder: остаток({ container_edges: [связь], isolated_groups: [], fuzzy_pairs: [], field_conflicts: [] }),
    });
    const { container } = render(<Stand questions={qs} />);
    await userEvent.click(screen.getByText("Поллер"));
    await userEvent.click(screen.getByRole("button", { name: "Завершить →" }));
    expect(screen.getByText("Разбор пройден")).toBeInTheDocument();
    expect(container.textContent).not.toContain("перенесено связей");
    expect(screen.queryByRole("button", { name: "Вернуться к пропущенным" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Пересмотреть ответы" }));
    expect(строки()).toHaveLength(1);
  });
});

describe("двухшаговые вопросы (§4.6, фаза 8б)", () => {
  const провести = () => screen.getAllByRole("button", { name: /^Провести связь/ })[0]!;
  const одинОбъект = () => screen.getByRole("button", { name: /^Один объект/ });

  it("4.4: форма строкой на объект → «Провести связь» → ответ виден на первом шаге", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    await кВопросу(3);
    await userEvent.click(провести());
    // Второй шаг: свой заголовок, «почему» и сноска не повторяются.
    expect(screen.getByText("Связи объектов с остальной схемой")).toBeInTheDocument();
    expect(screen.getByText(/строку можно оставить пустой/)).toBeInTheDocument();
    // Строка на каждый объект группы — видно, у кого связей нет.
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    await userEvent.type(screen.getAllByRole("combobox")[0]!, "server");
    await userEvent.click(screen.getByRole("option", { name: /server/ }));
    await userEvent.type(screen.getByLabelText("Технология связи от «Плагин»"), "SQL");
    await userEvent.click(screen.getByRole("button", { name: "Провести связь" }));
    // Первый шаг: оба варианта, «Провести связь» выбран, подписью — проведённая связь.
    expect(заголовок().textContent).toContain("нет связей с остальной схемой");
    expect(screen.queryByText("изменить")).toBeNull();
    expect(провести()).toHaveAttribute("aria-pressed", "true");
    expect(провести()).toHaveTextContent("Плагин → server");
    expect(провести()).not.toHaveTextContent("указать, с чем связан");
    expect(screen.getByRole("button", { name: /^Оставить как есть/ })).toHaveAttribute("aria-pressed", "false");
    expect(состояние.answers["group|Плагин"]).toEqual({
      kind: "new_edges",
      edges: [{ fromPath: "Плагин", toPath: "Zabbix / server", label: "", tech: "SQL" }],
    });
    // В списке ответ группы — числом связей.
    await userEvent.click(screen.getByRole("button", { name: "Все вопросы" }));
    expect(строки()[3]!.querySelector(".rq-ql-a")?.textContent).toBe("Связей: 1");
  });

  it("4.4: проведённые связи — первые три строки и «и ещё N»", async () => {
    const пять = buildQuestions({
      family_conflicts: [], remainder: остаток({
        field_conflicts: [], container_edges: [], fuzzy_pairs: [],
        isolated_groups: [{ id: "group|Г", node_paths: ["Г / А", "Г / Б", "Г / В", "Г / Д", "Г / Е"] }],
        node_paths: ["Zabbix", "Г / А", "Г / Б", "Г / В", "Г / Д", "Г / Е"],
        node_has_children: [false, false, false, false, false, false],
        node_elements: ["container", "container", "container", "container", "container", "container"],
      }),
    });
    render(<Stand questions={пять} />);
    await userEvent.click(провести());
    for (let i = 0; i < 5; i++) {
      await userEvent.type(screen.getAllByRole("combobox")[i]!, "zabbix");
      await userEvent.click(screen.getByRole("option", { name: "Zabbix" }));
    }
    await userEvent.click(screen.getByRole("button", { name: "Провести связи" }));
    const строкиПодписи = [...провести().querySelectorAll(".rq-opt-line")].map((e) => e.textContent);
    expect(строкиПодписи).toEqual(["А → Zabbix", "Б → Zabbix", "В → Zabbix", "и ещё 2"]);
  });

  it("4.4: «Назад к вопросу» не стирает уже проведённые связи", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    await кВопросу(3);
    await userEvent.click(провести());
    await userEvent.type(screen.getAllByRole("combobox")[0]!, "server");
    await userEvent.click(screen.getByRole("option", { name: /server/ }));
    await userEvent.click(screen.getByRole("button", { name: "Провести связь" }));
    // Возвращаемся в форму выбранным вариантом и уходим из неё без «Провести связь».
    await userEvent.click(провести());
    expect(screen.getAllByRole("combobox")[0]!).toHaveValue("Zabbix / server");
    expect(screen.getAllByRole("combobox")[1]!).toHaveValue(""); // вторая строка пуста
    await userEvent.click(screen.getByRole("button", { name: "Назад к вопросу" }));
    expect(состояние.answers["group|Плагин"]).toMatchObject({ kind: "new_edges" });
    expect(провести()).toHaveAttribute("aria-pressed", "true");
  });

  it("4.5: «Один объект» → имя → «Объединить» → первый шаг с ответом", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    await кВопросу(4);
    expect(одинОбъект()).toHaveTextContent("связи обоих (3) перейдут на объединённый");
    await userEvent.click(одинОбъект());
    expect(screen.getByText("Как назвать объединённый объект?")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Пользователь", { selector: "b" }));
    await userEvent.click(screen.getByRole("button", { name: "Объединить" }));
    expect(состояние.answers["pair|Пользователь Zabbix|Пользователь"]).toEqual({ kind: "merge", name: "Пользователь" });
    // «Объединить» возвращает к вопросу: ответ виден выбранным вариантом с именем.
    expect(заголовок().textContent).toContain("похожие имена");
    expect(screen.queryByText("Как назвать объединённый объект?")).toBeNull();
    expect(одинОбъект()).toHaveAttribute("aria-pressed", "true");
    expect(одинОбъект()).toHaveTextContent("под именем «Пользователь»");
    expect(screen.getByRole("button", { name: /^Разные объекты/ })).toHaveAttribute("aria-pressed", "false");
    // Шаг имени открывается снова на выбранном имени; «Назад к вопросу» ответа не меняет.
    await userEvent.click(одинОбъект());
    expect(screen.getByRole("button", { name: /Пользователь.*Из архива plugin.zip/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByText("Своё имя", { selector: "b" }));
    await userEvent.click(screen.getByRole("button", { name: "Назад к вопросу" }));
    expect(состояние.answers["pair|Пользователь Zabbix|Пользователь"]).toEqual({ kind: "merge", name: "Пользователь" });
    expect(одинОбъект()).toHaveTextContent("под именем «Пользователь»");
  });

  it("4.5: без ответа «Назад к вопросу» на шаге имени возвращает к двум вариантам", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    await кВопросу(4);
    await userEvent.click(одинОбъект());
    await userEvent.click(screen.getByRole("button", { name: "Назад к вопросу" }));
    expect(состояние.answers["pair|Пользователь Zabbix|Пользователь"]).toBeUndefined();
    expect(одинОбъект()).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Разные объекты/ })).toBeInTheDocument();
  });
});

describe("ответы по умолчанию и просмотр", () => {
  it("ответы вариантами по умолчанию в применение не попадают", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    await кВопросу(2);
    await userEvent.click(screen.getByRole("button", { name: /^Оставить на контейнере/ }));
    await кВопросу(4);
    await userEvent.click(screen.getByRole("button", { name: /^Разные объекты/ }));
    expect(toDecisions(ВОПРОСЫ, состояние.answers)).toBeNull();
  });

  it("«Открыть» — тихая кнопка в строке варианта, просмотр отвечает на вопрос", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    const строка = screen.getAllByRole("button", { name: "Открыть" })[1]!.closest(".rq-opt-row")!;
    expect(строка).not.toHaveClass("rq-opt-row--on");
    await userEvent.click(screen.getAllByRole("button", { name: "Открыть" })[1]!);
    expect(screen.getByTestId("mmd")).toHaveTextContent("flowchart LR");
    expect(screen.getByRole("button", { name: "Открыто" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Выбрать этот вариант" }));
    expect(состояние.resolutions["doc|Zabbix/server|Опрос"]).toBe("cand:1");
    expect(screen.queryByTestId("mmd")).toBeNull();
    // Выбранная строка различима целиком: рамка и фон выбора у строки.
    expect(screen.getAllByRole("button", { name: "Открыть" })[1]!.closest(".rq-opt-row")).toHaveClass("rq-opt-row--on");
  });
});
