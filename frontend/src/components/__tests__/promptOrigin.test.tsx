// Адрес ArchMap уезжает в запрос промпта ввоза из обоих окон (фаза 3 сборщика фактов,
// docs/tasks/fact-collector.md): по нему бэк ставит первым шагом запуск сборщика и
// называет агенту файл для curl. Без адреса промпт прежний, и окно, которое его
// потеряло, выглядело бы совершенно исправным: кнопка копирует текст, просто без шага.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import SyncRepoModal from "../docsImport/SyncRepoModal";
import CreateProjectDialog from "../project/CreateProjectDialog";
import { projectsApi } from "../../api/projects";
import type { Project } from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    importPrompt: vi.fn(),
    get: vi.fn(), syncPreview: vi.fn(), syncApply: vi.fn(), create: vi.fn(),
  },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в соседних тестах.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const адрес = () => vi.mocked(projectsApi.importPrompt).mock.calls.at(-1)?.[0]?.origin;

describe("адрес ArchMap в запросе промпта ввоза", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.importPrompt).mockResolvedValue({ prompt: "промпт" });
    vi.mocked(projectsApi.get).mockResolvedValue({ id: "p1", name: "Платформа" } as Project);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true,
    });
  });

  it("окно «Новый проект», способ «ИИ-агент»", async () => {
    render(<CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByText("ИИ-агент"));
    expect(screen.getByText(/Сначала агент запустит сборщик фактов ArchMap, который скачает сам\./))
      .toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Например, «Платёжная платформа»"), "Платформа");
    await userEvent.click(screen.getByRole("button", { name: "Скопировать промпт" }));
    await waitFor(() => expect(адрес()).toBe(window.location.origin));
  });

  it("окно «Обновить из кода»", async () => {
    render(<SyncRepoModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);
    const кнопка = screen.getByRole("button", { name: "Скопировать задание для агента" });
    await waitFor(() => expect(кнопка).toBeEnabled());
    await userEvent.click(кнопка);
    await waitFor(() => expect(адрес()).toBe(window.location.origin));
  });
});
