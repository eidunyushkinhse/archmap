// Чекбокс «Проект объединяет несколько продуктов» в окне создания проекта
// (docs/plan-federation-tuning.md, П1).
//
// Полевой мультирепо-QA: конвенция «имя системы = название проекта» заставляет
// каждого агента растворять свой продукт прямо в корне — заглушки соседей не
// находят пары, и продукт существует в проекте ДВАЖДЫ. Лечение — раздел промпта,
// который включается этой галкой, поэтому проверяется именно ПЕРЕДАЧА параметра:
// промпт без раздела выглядит совершенно исправным, ошибиться тут молча легко.
//
// Предвключение по «+» в названии — догадка, а не решение за пользователя: снятая
// или поставленная руками галка больше от имени не зависит (защёлка null → boolean).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CreateProjectDialog from "../project/CreateProjectDialog";
import { projectsApi } from "../../api/projects";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    templates: vi.fn(), importPrompt: vi.fn(), importPreview: vi.fn(), create: vi.fn(),
  },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в соседних тестах.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const ГАЛКА = "Проект объединяет несколько продуктов";
const ИМЯ = "Например, «Платёжная платформа»";

/** Значение multiProduct в ПОСЛЕДНЕМ вызове ручки промпта. */
const переданное = () => vi.mocked(projectsApi.importPrompt).mock.calls.at(-1)?.[0]?.multiProduct;
const галка = () => screen.getByRole("checkbox", { name: ГАЛКА });

async function открыть(имя: string) {
  render(<CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
  await userEvent.click(screen.getByText("ИИ-агент"));
  if (имя) await userEvent.type(screen.getByPlaceholderText(ИМЯ), имя);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.templates).mockResolvedValue([]);
  vi.mocked(projectsApi.importPrompt).mockResolvedValue({ prompt: "промпт" });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

describe("федерация продуктов · чекбокс окна создания", () => {
  it("«+» в названии проекта предвключает галку", async () => {
    await открыть("Zabbix+Grafana");
    expect(галка()).toBeChecked();
  });

  it("без «+» галка выключена", async () => {
    await открыть("Ярмарка");
    expect(галка()).not.toBeChecked();
  });

  it("включённая галка уходит параметром во ВСЕ три варианта промпта", async () => {
    // Промпт строит бэк, и раздел федерации сидит в СТРОИТЕЛЬНОМ тексте — он же
    // вшит в блок А обёртки. Потерять параметр на любой из трёх кнопок — значит
    // выдать агенту промпт без раздела, ничем внешне не отличимый.
    await открыть("Zabbix+Grafana");
    for (const кнопка of ["Скопировать промпт", "Промпт без аудита", "Только промпт аудита"]) {
      await userEvent.click(screen.getByRole("button", { name: кнопка }));
      await waitFor(() => expect(vi.mocked(projectsApi.importPrompt)).toHaveBeenCalled());
      expect(переданное()).toBe(true);
    }
  });

  it("выключенная галка уходит параметром false", async () => {
    await открыть("Ярмарка");
    await userEvent.click(screen.getByRole("button", { name: "Скопировать промпт" }));
    await waitFor(() => expect(переданное()).toBe(false));
  });

  it("снятую руками галку дальнейший ввод имени НЕ возвращает", async () => {
    await открыть("Zabbix+Grafana");
    await userEvent.click(галка());
    expect(галка()).not.toBeChecked();

    // Признак «+» в имени остаётся и появляется снова — решение пользователя старше.
    await userEvent.type(screen.getByPlaceholderText(ИМЯ), "+Zulip");
    expect(галка()).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Скопировать промпт" }));
    await waitFor(() => expect(переданное()).toBe(false));
  });

  it("поставленную руками галку ввод имени без «+» не сбрасывает", async () => {
    await открыть("Ярмарка");
    await userEvent.click(галка());
    expect(галка()).toBeChecked();

    await userEvent.type(screen.getByPlaceholderText(ИМЯ), " и партнёры");
    expect(галка()).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Скопировать промпт" }));
    await waitFor(() => expect(переданное()).toBe(true));
  });
});
