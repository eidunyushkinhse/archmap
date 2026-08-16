// Глубина BYOA — ВСЕГДА два слоя (решение пользователя 2026-08-16).
//
// Выбор глубины из интерфейса убран, и оба окна, которые заказывают промпт «Из
// репозитория», обязаны просить у агента ОДНО И ТО ЖЕ: создание проекта и синк
// живого проекта. Разойдутся — синк предложит план по более дробной схеме, чем та,
// что построена при создании. Трёхслойный режим остаётся только у ручки (дефолт
// depth=3 — публичный контракт MCP-агентов), поэтому окну недостаточно «не просить
// три»: параметр надо передать явно, и проверяется именно ПЕРЕДАЧА — промпт с лишним
// слоем выглядит совершенно исправным, ошибиться тут молча легко.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CreateProjectDialog from "../project/CreateProjectDialog";
import SyncRepoModal from "../docsImport/SyncRepoModal";
import { projectsApi } from "../../api/projects";
import type { Project } from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    templates: vi.fn(), importPrompt: vi.fn(), importPreview: vi.fn(),
    get: vi.fn(), syncPreview: vi.fn(), syncApply: vi.fn(), create: vi.fn(),
  },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в соседних тестах.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const БЕЗ_АУДИТА = "Промпт без аудита";
const ТОЛЬКО_АУДИТ = "Только промпт аудита";
const ИМЯ = "Например, «Платёжная платформа»";

/** Глубина из ПОСЛЕДНЕГО вызова ручки промпта. */
const глубина = () => vi.mocked(projectsApi.importPrompt).mock.calls.at(-1)?.[0]?.depth;

function моки() {
  vi.clearAllMocks();
  vi.mocked(projectsApi.templates).mockResolvedValue([]);
  vi.mocked(projectsApi.get).mockResolvedValue({ id: "p1", name: "Платформа" } as Project);
  vi.mocked(projectsApi.importPrompt).mockResolvedValue({ prompt: "промпт" });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
}

async function открытьСоздание() {
  render(<CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
  await userEvent.click(screen.getByText("ИИ-агент"));
  // Имя системы вшито в промпт ЛЮБОГО варианта — без имени вся тройка неактивна.
  await userEvent.type(screen.getByPlaceholderText(ИМЯ), "Платформа");
}

interface Окно {
  имя: string;
  главная: string; // подпись главной кнопки тройки
  открыть: () => Promise<void>;
}

const окна: Окно[] = [
  {
    имя: "создание проекта «ИИ-агент» (CreateProjectDialog)",
    главная: "Скопировать промпт",
    открыть: открытьСоздание,
  },
  {
    имя: "синк «Обновить из репозитория» (SyncRepoModal)",
    главная: "Скопировать задание для агента",
    открыть: async () => {
      render(<SyncRepoModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);
      // Имя проекта приезжает запросом — до него кнопки неактивны.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Скопировать задание для агента" }),
        ).toBeEnabled(),
      );
    },
  },
];

describe.each(окна)("глубина промпта · $имя", (о: Окно) => {
  beforeEach(async () => {
    моки();
    await о.открыть();
  });

  it.each([о.главная, БЕЗ_АУДИТА, ТОЛЬКО_АУДИТ])("кнопка «%s» просит два слоя", async (кнопка) => {
    await userEvent.click(screen.getByRole("button", { name: кнопка }));
    await waitFor(() => expect(глубина()).toBe(2));
  });
});

describe("окно создания проекта · выбор глубины убран", () => {
  beforeEach(async () => {
    моки();
    await открытьСоздание();
  });

  it("селектора глубины в интерфейсе нет, соседние параметры на месте", () => {
    expect(screen.queryByText("Глубина модели")).not.toBeInTheDocument();
    expect(screen.getByText("Язык описаний")).toBeInTheDocument();
    expect(screen.getByText("Проект объединяет несколько продуктов")).toBeInTheDocument();
  });
});
