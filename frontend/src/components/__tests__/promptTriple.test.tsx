// Тройка BYOA-промпта во ВСЕХ ШЕСТИ окнах (docs/plan-skeptic-audit.md, Ф1).
//
// Проверяется главное продуктовое решение эпика: аудит вторым агентом-скептиком —
// не опция, а дефолт. Прежняя кнопка каждого окна осталась на своём месте и со
// своей подписью, но копирует теперь ОРКЕСТРАТОРНЫЙ промпт (variant=orchestrated);
// запасные варианты уехали в две мелкие ссылки под подписью-гейтом. Ошибиться тут
// незаметно: варианты отличаются только query-параметром, и окно, которое молча
// продолжит отдавать builder, выглядит совершенно исправным.
//
// Окна разные (пропсы, готовность кнопки, какая ручка промпта), поэтому таблица
// кейсов: рендер окна, подписи главной кнопки и способ достать variant из вызова.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DocsAgentModal from "../docsImport/DocsAgentModal";
import SpecAgentModal from "../docsImport/SpecAgentModal";
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
    templates: vi.fn(), importPrompt: vi.fn(),
    get: vi.fn(), syncPreview: vi.fn(), syncApply: vi.fn(), create: vi.fn(),
  },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в соседних тестах.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
// Валидатор mermaid — ленивый чанк; пакетов здесь нет, но чанк тянуть незачем.
vi.mock("../mermaidLoader", () => ({ validateMermaid: vi.fn().mockResolvedValue(null) }));

// Подпись-гейт — ДОСЛОВНО одна на все шесть окон (текст согласован с пользователем):
// он объясняет и что промпт с аудитом, и что агенту нужны субагенты.
const ГЕЙТ =
  "Промпт включает аудит вторым агентом-скептиком: перед выдачей пакет проверяется "
  + "по коду. Вашему агенту понадобятся субагенты.";
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
  /** Только главная кнопка, без подписи-гейта и ссылок (окно создания проекта). */
  голая?: boolean;
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
    окно: "спека (SpecAgentModal)",
    подпись: "Скопировать промпт",
    скопировано: "Скопировано ✓",
    открыть: async () => {
      render(<SpecAgentModal nodeId="n1" nodeName="orders" onClose={vi.fn()} onApplied={vi.fn()} />);
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
    голая: true,
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
  vi.mocked(projectsApi.templates).mockResolvedValue([]);
  vi.mocked(projectsApi.get).mockResolvedValue({ id: "p1", name: "Платформа" } as Project);
}

const главная = (к: Кейс) => screen.getByRole("button", { name: к.подпись });
const ссылка = (имя: string) => screen.getByRole("button", { name: имя });

describe.each(кейсы.filter((к) => к.голая === true))("одна кнопка промпта · $окно", (к: Кейс) => {
  beforeEach(async () => {
    vi.clearAllMocks();
    мокиРучек();
    записано = vi.fn((_текст: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText: записано }, configurable: true });
    await к.открыть();
  });

  it("без подписи-гейта и запасных ссылок (решение пользователя 2026-09-28)", () => {
    expect(главная(к)).toBeInTheDocument();
    expect(screen.queryByText(ГЕЙТ)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: БЕЗ_АУДИТА })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ТОЛЬКО_АУДИТ })).not.toBeInTheDocument();
  });

  it("главная кнопка копирует промпт С АУДИТОМ", async () => {
    await userEvent.click(главная(к));
    await waitFor(() => expect(к.вариант()).toBe("orchestrated"));
    expect(записано).toHaveBeenCalledWith("промпт:orchestrated");
    await waitFor(() => expect(screen.getByRole("button", { name: к.скопировано })).toBeInTheDocument());
  });
});

describe.each(кейсы.filter((к) => к.голая !== true))("тройка промпта · $окно", (к: Кейс) => {
  beforeEach(async () => {
    vi.clearAllMocks();
    мокиРучек();
    записано = vi.fn((_текст: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText: записано }, configurable: true });
    await к.открыть();
  });

  it("показывает главную кнопку, подпись-гейт и две запасные ссылки", () => {
    expect(главная(к)).toBeInTheDocument();
    expect(screen.getByText(ГЕЙТ)).toBeInTheDocument();
    expect(ссылка(БЕЗ_АУДИТА)).toBeInTheDocument();
    expect(ссылка(ТОЛЬКО_АУДИТ)).toBeInTheDocument();
  });

  it("главная кнопка копирует промпт С АУДИТОМ", async () => {
    await userEvent.click(главная(к));
    await waitFor(() => expect(к.вариант()).toBe("orchestrated"));
    expect(записано).toHaveBeenCalledWith("промпт:orchestrated");
    // «Скопировано» — на самой кнопке, ссылки остались подписями вариантов.
    await waitFor(() => expect(screen.getByRole("button", { name: к.скопировано })).toBeInTheDocument());
    expect(ссылка(БЕЗ_АУДИТА)).toBeInTheDocument();
    expect(ссылка(ТОЛЬКО_АУДИТ)).toBeInTheDocument();
  });

  it("ссылка «Промпт без аудита» копирует строительный промпт", async () => {
    await userEvent.click(ссылка(БЕЗ_АУДИТА));
    await waitFor(() => expect(к.вариант()).toBe("builder"));
    expect(записано).toHaveBeenCalledWith("промпт:builder");
    // Отклик — на месте самой ссылки, главная кнопка подпись не меняет.
    await waitFor(() => expect(screen.getAllByText("Скопировано ✓")).toHaveLength(1));
    expect(главная(к)).toBeInTheDocument();
    expect(screen.queryByText(БЕЗ_АУДИТА)).not.toBeInTheDocument();
  });

  it("ссылка «Только промпт аудита» копирует промпт скептика", async () => {
    await userEvent.click(ссылка(ТОЛЬКО_АУДИТ));
    await waitFor(() => expect(к.вариант()).toBe("skeptic"));
    expect(записано).toHaveBeenCalledWith("промпт:skeptic");
    await waitFor(() => expect(screen.getAllByText("Скопировано ✓")).toHaveLength(1));
    expect(главная(к)).toBeInTheDocument();
    expect(screen.queryByText(ТОЛЬКО_АУДИТ)).not.toBeInTheDocument();
  });

  it("двух «скопировано» разом не бывает: второй клик гасит первый", async () => {
    // Иначе непонятно, что лежит в буфере: подписей-победителей две, промпт один.
    await userEvent.click(ссылка(БЕЗ_АУДИТА));
    await waitFor(() => expect(screen.getAllByText("Скопировано ✓")).toHaveLength(1));
    await userEvent.click(ссылка(ТОЛЬКО_АУДИТ));
    await waitFor(() => expect(к.вариант()).toBe("skeptic"));
    await waitFor(() => expect(screen.getAllByText("Скопировано ✓")).toHaveLength(1));
    expect(ссылка(БЕЗ_АУДИТА)).toBeInTheDocument();
  });
});
