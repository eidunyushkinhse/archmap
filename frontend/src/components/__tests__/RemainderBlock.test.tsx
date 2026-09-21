// Блок «Без ваших решений не объединить» (§3, §4.6, §8 ТЗ) — оркестрация разбора.
//
// Что закрепляем (приёмка §11): выбор варианта НЕ переводит к следующему вопросу;
// ходить можно «Назад/Дальше», точками, списком и стрелками, и ответы при этом не
// теряются; «как сейчас» отмечается серым и в применение не уезжает; двухшаговые
// вопросы возвращаются к форме без потери ответа; на 15 вопросах точки сменяются
// полосой по видам.
//
// Ответы живут у вызывающего (в диалоге) — здесь их держит стенд, как это будет
// делать CreateProjectDialog.
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
    { origin: 0, origin_label: "1 · zabbix.yaml", source_label: "От агента Zabbix", summary: "12 строк", body: "flowchart TD\n A-->B", truncated: false, current: false },
    { origin: 1, origin_label: "2 · plugin.zip", source_label: "Из архива плагина", summary: "20 строк", body: "flowchart LR\n A-->C", truncated: false, current: false },
  ],
  default: "all", allow_all: true,
};

const поле: FieldDisputeOut = {
  id: "field|Zabbix/server|description", node_path: "Zabbix / server", field: "description",
  candidates: [
    { origin: 0, origin_label: "1 · zabbix.yaml", source_label: "От агента Zabbix", value: "Ядро", current: false },
    { origin: 1, origin_label: "2 · plugin.zip", source_label: "Из архива плагина", value: "Сервер опроса", current: false },
  ],
  default: 0,
};

const связь: ContainerEdgeOut = {
  id: "edge|Плагин/Датасорс|Zabbix||target", from_path: "Плагин / Датасорс", to_path: "Zabbix",
  label: "запросы", technology: "HTTP", end: "target", container_path: "Zabbix",
  components: [
    { path: "Zabbix / server", has_children: true },
    { path: "Zabbix / Поллер", has_children: false },
  ],
};

const группа: IsolatedGroupOut = { id: "group|Плагин", node_paths: ["Плагин", "Плагин / Датасорс"] };

const пара: FuzzyPairOut = {
  id: "pair|Пользователь Zabbix|Пользователь", a_path: "Пользователь Zabbix", b_path: "Пользователь",
  a_source: "От агента Zabbix", b_source: "Из архива плагина",
  a_edges: 2, b_edges: 1, where: "на верхнем уровне", a_current: false, b_current: false,
};

const остаток = (over: Partial<RemainderOut> = {}): RemainderOut => ({
  field_conflicts: [поле], container_edges: [связь], isolated_groups: [группа], fuzzy_pairs: [пара],
  unfixable: [], converted_warnings: [],
  node_paths: ["Zabbix", "Zabbix / server", "Плагин", "Плагин / Датасорс"],
  node_has_children: [true, false, true, false], ...over,
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

const счётчик = () => screen.getByText(/вопрос \d+ из \d+|разбор пройден/).textContent;
const дальше = () => screen.getByRole("button", { name: "Дальше →" });

describe("навигация по вопросам", () => {
  it("открывается первым вопросом и не предвыбирает дефолт бэка", () => {
    render(<Stand />);
    expect(screen.getByText(/Без ваших решений не объединить/)).toBeInTheDocument();
    expect(счётчик()).toBe("вопрос 1 из 5");
    expect(screen.getByText(/У объекта «Опрос»/)).toBeInTheDocument();
    for (const кнопка of screen.getAllByRole("button", { pressed: false })) {
      expect(кнопка).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it("ВЫБОР ВАРИАНТА НЕ ПЕРЕВОДИТ ДАЛЬШЕ", async () => {
    render(<Stand />);
    await userEvent.click(screen.getByText("Из архива плагина"));
    expect(счётчик()).toBe("вопрос 1 из 5");
    expect(screen.getByRole("button", { name: /Из архива плагина/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("«Назад» на первом вопросе выключена, «Дальше» на последнем — «Завершить»", async () => {
    render(<Stand />);
    expect(screen.getByRole("button", { name: "← Назад" })).toBeDisabled();
    for (let i = 0; i < 4; i++) await userEvent.click(дальше());
    expect(счётчик()).toBe("вопрос 5 из 5");
    expect(screen.getByRole("button", { name: "Завершить →" })).toBeInTheDocument();
  });

  it("ответ переживает хождение вперёд-назад", async () => {
    render(<Stand />);
    await userEvent.click(дальше());
    await userEvent.click(screen.getByText("Сервер опроса"));
    await userEvent.click(дальше());
    await userEvent.click(screen.getByRole("button", { name: "← Назад" }));
    expect(счётчик()).toBe("вопрос 2 из 5");
    expect(screen.getByRole("button", { name: /Сервер опроса/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("стрелки ← → ходят по вопросам, а в поле ввода — нет", async () => {
    render(<Stand />);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(счётчик()).toBe("вопрос 2 из 5");
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(счётчик()).toBe("вопрос 1 из 5");
    // Модификатор — не наш жест (в окне живут свои сочетания).
    fireEvent.keyDown(document.body, { key: "ArrowRight", ctrlKey: true });
    expect(счётчик()).toBe("вопрос 1 из 5");
    // Курсор в поле: стрелка двигает каретку, а не вопросы.
    const поле_ = document.createElement("input");
    document.body.appendChild(поле_);
    fireEvent.keyDown(поле_, { key: "ArrowRight" });
    expect(счётчик()).toBe("вопрос 1 из 5");
    поле_.remove();
  });

  it("точки прогресса ведут к вопросу и показывают его состояние", async () => {
    render(<Stand />);
    const точки = screen.getAllByRole("button", { name: /^вопрос \d+$/ });
    expect(точки).toHaveLength(5);
    await userEvent.click(точки[3]!);
    expect(счётчик()).toBe("вопрос 4 из 5");
    expect(screen.getByText(/приехали без связей/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("Оставить как есть"));
    // «Как сейчас» — серая точка, а не синяя (у текущего вопроса точка своя,
    // поэтому смотрим на неё, отойдя дальше).
    await userEvent.click(дальше());
    expect(screen.getAllByRole("button", { name: /^вопрос \d+$/ })[3]!.className)
      .toContain("rq-dot--kept");
  });
});

describe("список всех вопросов и итог (§3, §8)", () => {
  it("список показывает ответы и открывает любой вопрос", async () => {
    render(<Stand />);
    await userEvent.click(screen.getByText("Из архива плагина"));
    await userEvent.click(screen.getByRole("button", { name: "Все вопросы" }));
    const строки = screen.getAllByRole("button").filter((b) => b.className.includes("rq-ql-r"));
    expect(строки).toHaveLength(5);
    expect(within(строки[0]!).getByText("Из архива плагина")).toBeInTheDocument();
    expect(within(строки[1]!).getByText("—")).toBeInTheDocument();
    await userEvent.click(строки[4]!);
    expect(счётчик()).toBe("вопрос 5 из 5");
    expect(screen.getByText(/похожие имена/)).toBeInTheDocument();
  });

  it("«Завершить» показывает итог с верными числами", async () => {
    render(<Stand />);
    // Перевешиваем связь (вопрос 3) и оставляем группу как есть (вопрос 4).
    const точки = screen.getAllByRole("button", { name: /^вопрос \d+$/ });
    await userEvent.click(точки[2]!);
    await userEvent.click(screen.getByText("Поллер"));
    await userEvent.click(дальше());
    await userEvent.click(screen.getByText("Оставить как есть"));
    await userEvent.click(дальше());
    await userEvent.click(screen.getByRole("button", { name: "Завершить →" }));
    expect(счётчик()).toBe("разбор пройден");
    expect(screen.getByText(/Осталось 3 вопроса без ответа/)).toBeInTheDocument();
    // Строка итога собрана из частей — смотрим её целиком.
    const строка = screen.getByText(/перевешено связей/).parentElement;
    expect(строка?.textContent).toContain("перевешено связей 1");
    expect(строка?.textContent).toContain("оставлено как есть 1");
    expect(строка?.textContent).not.toContain("склеек");
    await userEvent.click(screen.getByRole("button", { name: "Вернуться к пропущенным" }));
    expect(счётчик()).toBe("вопрос 1 из 5");
  });

  it("на всё отвечено — «Разбор пройден» с галкой", async () => {
    const qs = buildQuestions({
      family_conflicts: [], remainder: остаток({ container_edges: [связь], isolated_groups: [], fuzzy_pairs: [], field_conflicts: [] }),
    });
    render(<Stand questions={qs} />);
    await userEvent.click(screen.getByText("Поллер"));
    await userEvent.click(screen.getByRole("button", { name: "Завершить →" }));
    expect(screen.getByText("Разбор пройден")).toBeInTheDocument();
    expect(screen.getByText(/перевешено связей/).parentElement?.textContent).toBe("перевешено связей 1");
  });
});

describe("двухшаговые вопросы (§4.6)", () => {
  it("4.4: форма → «Добавить связь» → карточка с тегом «изменить»", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    await userEvent.click(screen.getAllByRole("button", { name: /^вопрос \d+$/ })[3]!);
    await userEvent.click(screen.getByText("Дорисовать связь"));
    // Второй шаг: свой заголовок, «почему» и сноска не повторяются.
    expect(screen.getByText("Новая связь между группой и остальной схемой")).toBeInTheDocument();
    expect(screen.queryByText("почему возник вопрос")).toBeNull();
    expect(screen.queryByText(/Если не отвечать/)).toBeNull();
    await userEvent.click(screen.getByText("Датасорс"));
    await userEvent.click(screen.getByText("Zabbix", { selector: "b" }));
    await userEvent.type(screen.getByLabelText("Технология"), "SQL");
    await userEvent.click(screen.getByRole("button", { name: "Добавить связь" }));
    expect(screen.getByText("изменить")).toBeInTheDocument();
    expect(screen.getByText(/Датасорс → Zabbix/)).toBeInTheDocument();
    expect(состояние.answers["group|Плагин"]).toEqual({
      kind: "new_edge", fromPath: "Плагин / Датасорс", toPath: "Zabbix",
      label: "", tech: "SQL", channel: "sync",
    });
  });

  it("4.4: «Назад к вопросу» не стирает уже данный ответ", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    await userEvent.click(screen.getAllByRole("button", { name: /^вопрос \d+$/ })[3]!);
    await userEvent.click(screen.getByText("Дорисовать связь"));
    await userEvent.click(screen.getByText("Датасорс"));
    await userEvent.click(screen.getByText("Zabbix", { selector: "b" }));
    await userEvent.click(screen.getByRole("button", { name: "Добавить связь" }));
    // Возвращаемся в форму и уходим из неё без «Добавить связь».
    await userEvent.click(screen.getByText("изменить"));
    await userEvent.click(screen.getByRole("button", { name: "Назад к вопросу" }));
    expect(состояние.answers["group|Плагин"]).toMatchObject({ kind: "new_edge", toPath: "Zabbix" });
    expect(screen.getByText("изменить")).toBeInTheDocument();
  });

  it("4.5: «Один объект» → имя → «Склеить» → снова шаг 2 с выбранным", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    await userEvent.click(screen.getAllByRole("button", { name: /^вопрос \d+$/ })[4]!);
    await userEvent.click(screen.getByText("Один объект"));
    expect(screen.getByText("Как назвать склеенный объект?")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Пользователь", { selector: "b" }));
    await userEvent.click(screen.getByRole("button", { name: "Склеить" }));
    expect(состояние.answers["pair|Пользователь Zabbix|Пользователь"]).toEqual({ kind: "merge", name: "Пользователь" });
    // Ответ виден и правится: шаг 2 остаётся на экране с выбранным именем,
    // возвращаться уже некуда — «Назад к вопросу» нет.
    expect(screen.getByText("Как назвать склеенный объект?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Пользователь.*Из архива плагина/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Назад к вопросу" })).toBeNull();
  });
});

describe("«как сейчас» и вьюер", () => {
  it("keep-ответы не попадают в применение", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    const точки = () => screen.getAllByRole("button", { name: /^вопрос \d+$/ });
    await userEvent.click(точки()[2]!);
    await userEvent.click(screen.getByText(/Оставить на контейнере/));
    await userEvent.click(точки()[4]!);
    await userEvent.click(screen.getByText("Разные объекты"));
    expect(toDecisions(ВОПРОСЫ, состояние.answers)).toBeNull();
  });

  it("вьюер схемы открывается из сплит-кнопки и отвечает на вопрос", async () => {
    let состояние: { answers: Answers; resolutions: Resolutions } = { answers: {}, resolutions: {} };
    render(<Stand onState={(s) => { состояние = s; }} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Открыть" })[1]!);
    expect(screen.getByTestId("mmd")).toHaveTextContent("flowchart LR");
    expect(screen.getByRole("button", { name: "Открыто" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Выбрать этот вариант" }));
    expect(состояние.resolutions["doc|Zabbix/server|Опрос"]).toBe("cand:1");
    expect(screen.queryByTestId("mmd")).toBeNull();
  });
});

describe("масштаб: 15 вопросов", () => {
  const много = buildQuestions({
    family_conflicts: [], remainder: остаток({
      field_conflicts: Array.from({ length: 13 }, (_, i) => ({ ...поле, id: `field|N${i}|role`, node_path: `Узел ${i}` })),
      isolated_groups: [], fuzzy_pairs: [пара],
    }),
  });

  it("точки сменяются полосой по видам, клик ведёт к первому вопросу вида", async () => {
    expect(много).toHaveLength(15);
    render(<Stand questions={много} />);
    expect(screen.queryByRole("button", { name: /^вопрос \d+$/ })).toBeNull();
    expect(screen.getByText("Поля · 0/13")).toBeInTheDocument();
    expect(screen.getByText("В контейнер · 0/1")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Имена · 0/1"));
    expect(счётчик()).toBe("вопрос 15 из 15");
  });
});
