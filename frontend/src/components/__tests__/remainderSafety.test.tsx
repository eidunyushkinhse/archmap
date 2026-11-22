// Страховка редизайна блока вопросов слияния (фаза 8а): то, что ОБЯЗАНО пережить смену вида.
//
// Вид блока меняется (шапка, прогресс, «почему возник вопрос», сноска, кнопки), а протокол
// ответов — нет: ответ на каждый из пяти видов вопроса даёт прежние resolutions и
// decisions (toDecisions), «Назад» и «Дальше» ходят по вопросам, «Все вопросы» открывает
// список и строка списка ведёт к вопросу, итог и его кнопки работают, массовые ответы
// догрузки ставят те же ответы, «Выбрать этот вариант» в просмотре схемы отвечает на
// вопрос. Тесты ищут элементы словами и ролями, а не разметкой прогресса, поэтому
// зелёные и на старом виде, и на новом.
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import type {
  ContainerEdgeOut, FamilyConflictOut, FieldDisputeOut, FuzzyPairOut,
  IsolatedGroupOut, RemainderOut,
} from "../../types";
import RemainderBlock from "../project/remainder/RemainderBlock";
import BulkBox from "../project/remainder/BulkBox";
import { buildQuestions, bulkAnswers, toDecisions } from "../project/remainder/questions";
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

type State = { answers: Answers; resolutions: Resolutions };

// Стенд держит ответы, как окно ввоза; with bulk — ещё и массовые кнопки догрузки под
// блоком, как ImportIntoModal. Имя латиницей: правило хуков узнаёт компонент по ней.
function Stand({ questions = ВОПРОСЫ, onState, bulk = false }: {
  questions?: Question[];
  onState?: (s: State) => void;
  bulk?: boolean;
}) {
  const [state, setState] = useState<State>({ answers: {}, resolutions: {} });
  onState?.(state);
  return (
    <>
      <RemainderBlock
        questions={questions}
        answers={state.answers}
        resolutions={state.resolutions}
        onAnswer={(id: string, a: Answer) => setState((s) => ({ ...s, answers: { ...s.answers, [id]: a } }))}
        onResolve={(id: string, c: string) => setState((s) => ({ ...s, resolutions: { ...s.resolutions, [id]: c } }))}
        mode={bulk ? "into" : "create"}
      />
      {bulk && (
        <BulkBox
          onKeepMine={() => setState((s) => bulkAnswers(questions, true, s))}
          onTakeArchives={() => setState((s) => bulkAnswers(questions, false, s))}
        />
      )}
    </>
  );
}

function стенд(props: { questions?: Question[]; bulk?: boolean } = {}) {
  const ref: { current: State } = { current: { answers: {}, resolutions: {} } };
  render(<Stand {...props} onState={(s) => { ref.current = s; }} />);
  return ref;
}

// Счётчик и заголовок — словами, а не разметкой: регистр «вопрос/Вопрос» не важен.
const номер = () => {
  const m = /вопрос (\d+) из (\d+)/i.exec(screen.getByText(/вопрос \d+ из \d+/i).textContent ?? "");
  return m ? `${m[1]} из ${m[2]}` : null;
};
const заголовок = () => screen.getByRole("heading", { level: 4 }).textContent ?? "";
const строкиСписка = () => screen.getAllByRole("button").filter((b) => b.className.includes("rq-ql-r"));

/** К вопросу i (с нуля) через «Все вопросы» и строку списка. */
async function кВопросу(i: number) {
  await userEvent.click(screen.getByRole("button", { name: "Все вопросы" }));
  await userEvent.click(строкиСписка()[i]!);
}

describe("ответы уезжают прежним протоколом", () => {
  it("спор содержимого: кандидат и «Добавить все» — резолюциями, decisions пусты", async () => {
    const s = стенд();
    await userEvent.click(screen.getByRole("button", { name: /^Из архива plugin\.zip/ }));
    expect(s.current.resolutions).toEqual({ [семья.id]: "cand:1" });
    await userEvent.click(screen.getByRole("button", { name: /^Добавить все/ }));
    expect(s.current.resolutions).toEqual({ [семья.id]: "all" });
    expect(toDecisions(ВОПРОСЫ, s.current.answers)).toBeNull();
  });

  it("спор поля: индекс кандидата в decisions.fields", async () => {
    const s = стенд();
    await кВопросу(1);
    await userEvent.click(screen.getByRole("button", { name: /^Сервер опроса/ }));
    expect(toDecisions(ВОПРОСЫ, s.current.answers)).toEqual({ fields: { [поле.id]: 1 } });
    expect(s.current.resolutions).toEqual({});
  });

  it("связь: объект — в decisions.edges, «Оставить на контейнере» не едет", async () => {
    const s = стенд();
    await кВопросу(2);
    await userEvent.click(screen.getByRole("button", { name: /Поллер/ }));
    expect(toDecisions(ВОПРОСЫ, s.current.answers)).toEqual({
      edges: { [связь.id]: { to_path: "Zabbix / Поллер" } },
    });
    await userEvent.click(screen.getByRole("button", { name: /^Оставить на контейнере «Zabbix»/ }));
    expect(s.current.answers[связь.id]).toEqual({ kind: "keep" });
    expect(toDecisions(ВОПРОСЫ, s.current.answers)).toBeNull();
  });

  it("группа: форма связей даёт decisions.new_edges, «Оставить как есть» не едет", async () => {
    const s = стенд();
    await кВопросу(3);
    await userEvent.click(screen.getAllByRole("button", { name: /^Провести связь/ })[0]!);
    await userEvent.type(screen.getAllByRole("combobox")[0]!, "server");
    await userEvent.click(screen.getByRole("option", { name: /server/ }));
    await userEvent.type(screen.getByLabelText("Описание связи от «Плагин»"), "метрики");
    await userEvent.click(screen.getByRole("button", { name: "Провести связь" }));
    expect(toDecisions(ВОПРОСЫ, s.current.answers)).toEqual({
      new_edges: [{ group_id: группа.id, from_path: "Плагин", to_path: "Zabbix / server", label: "метрики", tech: "" }],
    });
  });

  it("группа без формы: «Оставить как есть» — keep, в применение не едет", async () => {
    const s = стенд();
    await кВопросу(3);
    await userEvent.click(screen.getByRole("button", { name: /^Оставить как есть/ }));
    expect(s.current.answers[группа.id]).toEqual({ kind: "keep" });
    expect(toDecisions(ВОПРОСЫ, s.current.answers)).toBeNull();
  });

  it("похожие имена: «Один объект» → «Объединить» в decisions.merges", async () => {
    const s = стенд();
    await кВопросу(4);
    await userEvent.click(screen.getByRole("button", { name: /^Один объект/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Своё имя/ }));
    await userEvent.type(screen.getByLabelText("Своё имя"), "Оператор");
    await userEvent.click(screen.getByRole("button", { name: "Объединить" }));
    expect(toDecisions(ВОПРОСЫ, s.current.answers)).toEqual({
      merges: { [пара.id]: { name: "Оператор" } },
    });
  });

  it("похожие имена: «Разные объекты» — diff, в применение не едет", async () => {
    const s = стенд();
    await кВопросу(4);
    await userEvent.click(screen.getByRole("button", { name: /^Разные объекты/ }));
    expect(s.current.answers[пара.id]).toEqual({ kind: "diff" });
    expect(toDecisions(ВОПРОСЫ, s.current.answers)).toBeNull();
  });
});

describe("переходы, список и итог", () => {
  it("«Назад» и «Дальше» ходят по вопросам, ответ при этом не теряется", async () => {
    const s = стенд();
    expect(номер()).toBe("1 из 5");
    expect(screen.getByRole("button", { name: "← Назад" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Дальше →" }));
    expect(номер()).toBe("2 из 5");
    expect(заголовок()).toContain("по-разному");
    await userEvent.click(screen.getByRole("button", { name: /^Сервер опроса/ }));
    // Выбор варианта не переводит дальше.
    expect(номер()).toBe("2 из 5");
    await userEvent.click(screen.getByRole("button", { name: "Дальше →" }));
    await userEvent.click(screen.getByRole("button", { name: "← Назад" }));
    expect(номер()).toBe("2 из 5");
    expect(screen.getByRole("button", { name: /^Сервер опроса/ })).toHaveAttribute("aria-pressed", "true");
    expect(s.current.answers[поле.id]).toEqual({ kind: "field", index: 1 });
  });

  it("«Все вопросы»: строка на вопрос, строка ведёт к вопросу, «К вопросу» возвращает", async () => {
    стенд();
    await userEvent.click(screen.getByRole("button", { name: "Все вопросы" }));
    expect(строкиСписка()).toHaveLength(5);
    expect(within(строкиСписка()[3]!).getByText(/нет связей с остальной схемой/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "К вопросу" }));
    expect(номер()).toBe("1 из 5");
    await кВопросу(3);
    expect(номер()).toBe("4 из 5");
    expect(заголовок()).toContain("нет связей с остальной схемой");
  });

  it("итог: «Завершить», «Вернуться к пропущенным» и «Пересмотреть ответы»", async () => {
    стенд();
    await userEvent.click(screen.getByRole("button", { name: /^Из архива plugin\.zip/ }));
    await кВопросу(4);
    await userEvent.click(screen.getByRole("button", { name: "Завершить →" }));
    expect(screen.getByText("Осталось 4 вопроса без ответа")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Вернуться к пропущенным" }));
    // Первый пропущенный — второй вопрос: на первый уже ответили.
    expect(номер()).toBe("2 из 5");
    await кВопросу(4);
    await userEvent.click(screen.getByRole("button", { name: "Завершить →" }));
    await userEvent.click(screen.getByRole("button", { name: "Пересмотреть ответы" }));
    expect(строкиСписка()).toHaveLength(5);
  });

  it("итог при всех ответах — «Разбор пройден», возвращаться не к чему", async () => {
    const один = buildQuestions({
      family_conflicts: [],
      remainder: остаток({ field_conflicts: [], isolated_groups: [], fuzzy_pairs: [] }),
    });
    стенд({ questions: один });
    await userEvent.click(screen.getByRole("button", { name: /Поллер/ }));
    await userEvent.click(screen.getByRole("button", { name: "Завершить →" }));
    expect(screen.getByText("Разбор пройден")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Вернуться к пропущенным" })).toBeNull();
    expect(screen.getByRole("button", { name: "Пересмотреть ответы" })).toBeInTheDocument();
  });
});

describe("массовые ответы догрузки", () => {
  const свои = buildQuestions({
    family_conflicts: [{
      ...семья, default: "cand:0", allow_all: false,
      candidates: [
        { origin: 0, origin_label: "Текущий проект", source_label: "Из проекта", summary: "12 строк", body: "flowchart TD", truncated: false, current: true },
        { origin: 1, origin_label: "1 · plugin.zip", source_label: "Из архива plugin.zip", summary: "20 строк", body: "flowchart LR", truncated: false, current: false },
      ],
    }],
    remainder: остаток({
      field_conflicts: [{
        ...поле, default: 0,
        candidates: [
          { ...поле.candidates[0]!, source_label: "Из проекта", value: "Моё", current: true },
          { ...поле.candidates[1]!, value: "Из архива" },
        ],
      }],
    }),
    mode: "into",
  });

  it("«Взять из новых архивов» и «Оставить, как было в проекте» ставят прежние ответы", async () => {
    const s = стенд({ questions: свои, bulk: true });
    await userEvent.click(screen.getByRole("button", { name: "Взять из новых архивов" }));
    expect(s.current.resolutions).toEqual({ [семья.id]: "cand:1" });
    expect(s.current.answers).toEqual({ [поле.id]: { kind: "field", index: 1 } });
    await userEvent.click(screen.getByRole("button", { name: "Оставить, как было в проекте" }));
    expect(s.current.resolutions).toEqual({});
    expect(s.current.answers).toEqual({ [поле.id]: { kind: "field", index: 0 } });
    expect(toDecisions(свои, s.current.answers)).toEqual({ fields: { [поле.id]: 0 } });
  });
});

describe("просмотр схемы", () => {
  it("«Выбрать этот вариант» отвечает на вопрос и закрывает просмотр", async () => {
    const s = стенд();
    await userEvent.click(screen.getAllByRole("button", { name: "Открыть" })[1]!);
    expect(screen.getByTestId("mmd")).toHaveTextContent("flowchart LR");
    await userEvent.click(screen.getByRole("button", { name: "Выбрать этот вариант" }));
    expect(s.current.resolutions).toEqual({ [семья.id]: "cand:1" });
    expect(screen.queryByTestId("mmd")).toBeNull();
    expect(номер()).toBe("1 из 5");
  });

  it("Escape закрывает только просмотр, ответа не даёт", async () => {
    const s = стенд();
    await userEvent.click(screen.getAllByRole("button", { name: "Открыть" })[0]!);
    expect(screen.getByTestId("mmd")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("mmd")).toBeNull();
    expect(s.current.resolutions).toEqual({});
    expect(номер()).toBe("1 из 5");
  });
});
