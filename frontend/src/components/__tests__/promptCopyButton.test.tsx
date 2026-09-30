// Кнопка BYOA-промпта в окнах агентов (docs/plan-skeptic-audit.md, Ф1).
//
// Проверяется главное продуктовое решение эпика: аудит вторым агентом-скептиком —
// не опция, а дефолт. Кнопка каждого окна копирует ОРКЕСТРАТОРНЫЙ промпт
// (variant=orchestrated). Подпись-гейт и запасные ссылки «без аудита / только аудит»
// сняты решением пользователя 2026-09-28 во всех окнах. Ошибиться тут незаметно:
// варианты отличаются только query-параметром, и окно, которое молча отдаёт
// builder, выглядит совершенно исправным.
//
// Окна разные (пропсы, готовность кнопки, какая ручка промпта), поэтому таблица
// кейсов: рендер окна, подписи главной кнопки и способ достать variant из вызова.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DocsAgentModal from "../docsImport/DocsAgentModal";
import OpenApiPane from "../inspector/OpenApiPane";
import DataAgentModal from "../docsImport/DataAgentModal";
import ChannelsAgentModal from "../docsImport/ChannelsAgentModal";
import SyncRepoModal from "../docsImport/SyncRepoModal";
import CreateProjectDialog from "../project/CreateProjectDialog";
import { docsImportApi, dataImportApi, channelsImportApi } from "../../api/docsImport";
import { projectsApi } from "../../api/projects";
import type { Project } from "../../types";

vi.mock("../../api/docsImport", () => ({
  docsImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
  dataImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
  channelsImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
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
// Валидатор mermaid — ленивый чанк; пакетов здесь нет, но чанк тянуть незачем.
vi.mock("../mermaidLoader", () => ({ validateMermaid: vi.fn().mockResolvedValue(null) }));

// Прежние тексты подписи-гейта и ссылок: их в окнах быть не должно.
const ГЕЙТ = /агентом-скептиком|понадобятся субагенты/;
const БЕЗ_АУДИТА = "Промпт без аудита";
const ТОЛЬКО_АУДИТ = "Только промпт аудита";

let записано: ReturnType<typeof vi.fn>;

interface Кейс {
  окно: string;
  подпись: string; // текст главной кнопки в покое
  скопировано: string; // её текст сразу после копирования
  открыть: () => Promise<void>;
  // Вариант из ПОСЛЕДНЕГО вызова ручки промпта этого окна.
  вариант: () => string | undefined;
}

const кейсы: Кейс[] = [
  {
    окно: "логика (DocsAgentModal)",
    подпись: "Скопировать промпт",
    скопировано: "Скопировано ✓",
    открыть: async () => {
      render(<DocsAgentModal nodeId="n1" nodeName="orders" onClose={vi.fn()} onApplied={vi.fn()} />);
      await Promise.resolve();
    },
    вариант: () => vi.mocked(docsImportApi.prompt).mock.calls.at(-1)?.[0]?.variant,
  },
  {
    // Отдельной модалки спеки больше нет: агент живёт в окне спеки (вьюер v2).
    окно: "спека (окно спеки, «Через ИИ-агента»)",
    подпись: "Скопировать промпт",
    скопировано: "Скопировано ✓",
    открыть: async () => {
      render(
        <OpenApiPane nodeId="n1" nodeName="orders" openapi="" isArchitect initialStage="agent"
          onCommitOpenapi={vi.fn()} onClose={vi.fn()} />,
      );
      await Promise.resolve();
    },
    вариант: () => vi.mocked(docsImportApi.prompt).mock.calls.at(-1)?.[0]?.variant,
  },
  {
    окно: "структура БД (DataAgentModal)",
    подпись: "Скопировать промпт",
    скопировано: "Скопировано ✓",
    открыть: async () => {
      render(<DataAgentModal nodeId="db1" nodeName="Хранилище" onClose={vi.fn()} onApplied={vi.fn()} />);
      await Promise.resolve();
    },
    // У этой ручки параметров нет вовсе — variant единственный аргумент.
    вариант: () => vi.mocked(dataImportApi.prompt).mock.calls.at(-1)?.[0],
  },
  {
    окно: "каналы брокера (ChannelsAgentModal)",
    подпись: "Скопировать промпт",
    скопировано: "Скопировано ✓",
    открыть: async () => {
      render(<ChannelsAgentModal nodeId="b1" nodeName="Кафка" onClose={vi.fn()} onApplied={vi.fn()} />);
      await Promise.resolve();
    },
    вариант: () => vi.mocked(channelsImportApi.prompt).mock.calls.at(-1)?.[0],
  },
  {
    окно: "создание проекта «Из репозитория» (CreateProjectDialog)",
    подпись: "Скопировать промпт",
    скопировано: "Промпт скопирован ✓",
    открыть: async () => {
      render(<CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
      await userEvent.click(screen.getByText("ИИ-агент"));
      // Имя системы вшивается в промпт ЛЮБОГО варианта — без имени вся тройка мертва.
      await userEvent.type(screen.getByPlaceholderText("Например, «Платёжная платформа»"), "Платформа");
    },
    вариант: () => vi.mocked(projectsApi.importPrompt).mock.calls.at(-1)?.[0]?.variant,
  },
  {
    окно: "синк «Обновить из репозитория» (SyncRepoModal)",
    подпись: "Скопировать задание для агента",
    скопировано: "Скопировано",
    открыть: async () => {
      render(<SyncRepoModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);
      // Имя проекта приезжает запросом — до него кнопки неактивны.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Скопировать задание для агента" })).toBeEnabled(),
      );
    },
    вариант: () => vi.mocked(projectsApi.importPrompt).mock.calls.at(-1)?.[0]?.variant,
  },
];

// Ручки промпта отдают текст, В КОТОРОМ НАЗВАН вариант: так видно не только то, что
// параметр уехал на бэк, но и что в буфер лёг ответ именно этого запроса.
function мокиРучек() {
  vi.mocked(docsImportApi.prompt).mockImplementation((p) =>
    Promise.resolve({ prompt: `промпт:${p.variant}` }),
  );
  vi.mocked(dataImportApi.prompt).mockImplementation((v) => Promise.resolve({ prompt: `промпт:${v}` }));
  vi.mocked(channelsImportApi.prompt).mockImplementation((v) => Promise.resolve({ prompt: `промпт:${v}` }));
  vi.mocked(projectsApi.importPrompt).mockImplementation((p) =>
    Promise.resolve({ prompt: `промпт:${p.variant}` }),
  );
  vi.mocked(projectsApi.get).mockResolvedValue({ id: "p1", name: "Платформа" } as Project);
}

const главная = (к: Кейс) => screen.getByRole("button", { name: к.подпись });

describe.each(кейсы)("кнопка промпта · $окно", (к: Кейс) => {
  beforeEach(async () => {
    vi.clearAllMocks();
    мокиРучек();
    записано = vi.fn((_текст: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText: записано }, configurable: true });
    await к.открыть();
  });

  it("одна кнопка: без подписи-гейта и запасных ссылок", () => {
    expect(главная(к)).toBeInTheDocument();
    expect(screen.queryByText(ГЕЙТ)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: БЕЗ_АУДИТА })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ТОЛЬКО_АУДИТ })).not.toBeInTheDocument();
  });

  it("кнопка копирует промпт С АУДИТОМ", async () => {
    await userEvent.click(главная(к));
    await waitFor(() => expect(к.вариант()).toBe("orchestrated"));
    expect(записано).toHaveBeenCalledWith("промпт:orchestrated");
    await waitFor(() => expect(screen.getByRole("button", { name: к.скопировано })).toBeInTheDocument());
  });
});
