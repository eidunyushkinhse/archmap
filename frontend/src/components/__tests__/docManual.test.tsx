// Стадия «Вручную» окна документа (схема логики и спецификация, DocOverlay).
//
// Страховочная сетка перед переводом стадии на новый язык (редизайн, фаза 7б): поведение,
// которое переживает переделку. Сохранение схемы и спецификации, «Отмена» у сохранённой и у
// новой, «Сохранить» погашена, пока идёт запись, двухшаговое удаление (уход фокуса
// отменяет), отказы сохранения и удаления с черновиком на месте, вопрос «Закрыть без
// сохранения?» по крестику и по Escape. Написаны на прежнем окне и зелёные на нём: держатся
// за роли и слова, а не за классы.
//
// Окно настоящее (DocOverlay, FlowchartDocs, FlowchartDoc, OpenApiPane, OpenApiDoc, Modal:
// test-setup открывает <dialog> атрибутом open). Замоканы сеть, mermaid, Swagger UI и панели
// пакета агента.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DocOverlay from "../inspector/DocOverlay";
import { nodeDocsApi } from "../../api/nodes";
import { ApiError, DEMO_LIMIT_CODE } from "../../api/client";
import type { NodeDoc } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodeDocsApi: {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
    usage: vi.fn(() => Promise.resolve([])),
  },
  nodesApi: { get: vi.fn() },
}));
vi.mock("../../api/dataRefs", () => ({ dataRefsApi: { preview: vi.fn(() => Promise.resolve([])) } }));
vi.mock("../../api/docsImport", () => ({ docsImportApi: { prompt: vi.fn() } }));
vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <div data-testid="mmd">{chart}</div>,
}));
vi.mock("../OpenApiViewer", () => ({
  default: ({ spec }: { spec: { info?: { title?: string } } }) => (
    <div data-testid="swagger">{spec.info?.title ?? "без заголовка"}</div>
  ),
}));
vi.mock("../docsImport/SpecAgentPanel", () => ({ default: () => <div data-testid="spec-panel" /> }));

const doc = (over: Partial<NodeDoc> = {}): NodeDoc => ({
  id: "d1", node_id: "n1", name: "Создание заказа", kind: "operation", operation: "POST /orders",
  content: "graph TD\n  A[Принять] --> B[Сохранить]", version: 1, ...over,
} as NodeDoc);

const spec = (title: string) => `openapi: 3.0.3\ninfo:\n  title: ${title}\n  version: 1.0.0\npaths: {}\n`;
const VOLUME = "Текста в проекте стало больше 250 КБ, это предел демо. Сократите описания или удалите ненужные объекты.";
const limit = () => new ApiError(409, VOLUME, DEMO_LIMIT_CODE);

const codeField = () => document.querySelector("textarea.doc-edta") as HTMLTextAreaElement | null;
const setCode = (text: string) => fireEvent.change(codeField()!, { target: { value: text } });
const dlg = () => document.querySelector("dialog") as HTMLDialogElement;
// Escape у нативного <dialog> приходит событием cancel (jsdom его по клавише не шлёт).
const escape = () => fireEvent(dlg(), new Event("cancel", { cancelable: true }));
const button = (name: string) => screen.getByRole("button", { name });

// Обещание, которое тест разрешает сам: «пока идёт сохранение».
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function openFlow(over: { createNew?: boolean; onClose?: () => void; onDocEvent?: () => void } = {}) {
  render(
    <DocOverlay
      mode="flowchart"
      nodeId="n1"
      nodeName="Order API"
      isArchitect
      initialDocId={over.createNew ? undefined : "d1"}
      createNew={over.createNew}
      onDocEvent={over.onDocEvent ?? vi.fn()}
      onClose={over.onClose ?? vi.fn()}
    />,
  );
}

async function toManual() {
  await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
  await waitFor(() => expect(codeField()).not.toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodeDocsApi.list).mockResolvedValue([doc()]);
  vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
});

describe("схема логики, «Вручную»: сохранение и отмена", () => {
  it("«Сохранить» пишет правку и возвращает к чтению", async () => {
    vi.mocked(nodeDocsApi.update).mockResolvedValue(doc({ content: "graph TD\n  новое", version: 2 }));
    openFlow();
    await toManual();
    setCode("graph TD\n  новое");
    await userEvent.click(button("Сохранить"));
    await waitFor(() => expect(nodeDocsApi.update).toHaveBeenCalledWith(
      "n1", "d1", expect.objectContaining({ content: "graph TD\n  новое", base_version: 1 }),
    ));
    await waitFor(() => expect(codeField()).toBeNull());
    expect(button("Изменить")).toBeInTheDocument();
    expect(screen.getByTestId("mmd")).toHaveTextContent("новое");
  });

  it("пока идёт сохранение, «Сохранить» погашена", async () => {
    const wait = deferred<NodeDoc>();
    vi.mocked(nodeDocsApi.update).mockReturnValue(wait.promise);
    openFlow();
    await toManual();
    setCode("graph TD\n  новое");
    await userEvent.click(button("Сохранить"));
    expect(button("Сохранить")).toBeDisabled();
    wait.resolve(doc({ content: "graph TD\n  новое", version: 2 }));
    await waitFor(() => expect(codeField()).toBeNull());
  });

  it("«Отмена» у сохранённой схемы возвращает к чтению без вопроса и без записи", async () => {
    const onClose = vi.fn();
    openFlow({ onClose });
    await toManual();
    setCode("graph TD\n  брошенное");
    await userEvent.click(button("Отмена"));
    expect(screen.queryByText("Закрыть без сохранения?")).toBeNull();
    expect(codeField()).toBeNull();
    expect(screen.getByTestId("mmd")).toHaveTextContent("Сохранить");
    expect(nodeDocsApi.update).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("новая схема: «Отмена» закрывает окно, ничего не создав; удалять нечего", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([]);
    const onClose = vi.fn();
    openFlow({ createNew: true, onClose });
    await waitFor(() => expect(codeField()).not.toBeNull());
    expect(screen.getByRole("heading", { name: "Новая схема" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Удалить схему" })).toBeNull();
    await userEvent.click(button("Отмена"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(nodeDocsApi.create).not.toHaveBeenCalled();
  });
});

describe("схема логики, «Вручную»: двухшаговое удаление", () => {
  it("«Удалить схему» → «Удалить схему?» → запрос удаления и закрытие окна", async () => {
    vi.mocked(nodeDocsApi.delete).mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onDocEvent = vi.fn();
    openFlow({ onClose, onDocEvent });
    await toManual();
    await userEvent.click(button("Удалить схему"));
    expect(nodeDocsApi.delete).not.toHaveBeenCalled();
    await userEvent.click(button("Удалить схему?"));
    await waitFor(() => expect(nodeDocsApi.delete).toHaveBeenCalledWith("n1", "d1"));
    expect(onDocEvent).toHaveBeenCalledWith({ type: "delete", nodeId: "n1", doc: doc() });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("уход фокуса отменяет вторую ступень", async () => {
    openFlow();
    await toManual();
    await userEvent.click(button("Удалить схему"));
    expect(button("Удалить схему?")).toBeInTheDocument();
    fireEvent.blur(button("Удалить схему?"));
    expect(button("Удалить схему")).toBeInTheDocument();
    expect(nodeDocsApi.delete).not.toHaveBeenCalled();
  });

  it("отказ удаления: «Схема не удалена», окно на месте", async () => {
    vi.mocked(nodeDocsApi.delete).mockRejectedValue("сбой");
    const onClose = vi.fn();
    openFlow({ onClose });
    await toManual();
    await userEvent.click(button("Удалить схему"));
    await userEvent.click(button("Удалить схему?"));
    expect(await screen.findByText("Схема не удалена")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(codeField()).not.toBeNull();
  });
});

describe("схема логики, «Вручную»: отказы сохранения, черновик на месте", () => {
  it("сбой записи: «Схема не сохранена», правка в поле", async () => {
    vi.mocked(nodeDocsApi.update).mockRejectedValue("сбой");
    openFlow();
    await toManual();
    setCode("graph TD\n  моё");
    await userEvent.click(button("Сохранить"));
    expect(await screen.findByText("Схема не сохранена")).toBeInTheDocument();
    expect(codeField()!.value).toBe("graph TD\n  моё");
    expect(button("Сохранить")).toBeEnabled();
  });

  it("занятое имя (ответ сервера при создании): текст отказа, черновик и окно на месте", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([]);
    vi.mocked(nodeDocsApi.create).mockRejectedValue(new ApiError(409, "У объекта уже есть схема с таким именем"));
    const onClose = vi.fn();
    openFlow({ createNew: true, onClose });
    await waitFor(() => expect(codeField()).not.toBeNull());
    setCode("graph TD\n  новая");
    await userEvent.click(button("Сохранить"));
    expect(await screen.findByText("У объекта уже есть схема с таким именем")).toBeInTheDocument();
    expect(codeField()!.value).toBe("graph TD\n  новая");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("занятое имя ловится до запроса: текст отказа, имя и код на месте", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc(), doc({ id: "d2", name: "Получение заказа" })]);
    openFlow();
    await toManual();
    const имя = screen.getByLabelText("Имя схемы");
    await userEvent.clear(имя);
    await userEvent.type(имя, "Получение заказа");
    setCode("graph TD\n  моё");
    await userEvent.click(button("Сохранить"));
    expect(screen.getByText("У объекта уже есть схема с таким именем")).toBeInTheDocument();
    expect(nodeDocsApi.update).not.toHaveBeenCalled();
    expect(имя).toHaveValue("Получение заказа");
    expect(codeField()!.value).toBe("graph TD\n  моё");
  });

  it("предел демо-стенда: «Не сохранилось.» и правка в поле", async () => {
    vi.mocked(nodeDocsApi.update).mockRejectedValue(limit());
    openFlow();
    await toManual();
    setCode("graph TD\n  длинное");
    await userEvent.click(button("Сохранить"));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Не сохранилось. ${VOLUME}`);
    expect(codeField()!.value).toBe("graph TD\n  длинное");
  });
});

describe("схема логики, «Вручную»: вопрос о закрытии", () => {
  it("Escape при несохранённой правке спрашивает, второй Escape возвращает к правке", async () => {
    const onClose = vi.fn();
    openFlow({ onClose });
    await toManual();
    setCode("graph TD\n  правка");
    escape();
    const ask = screen.getByRole("alertdialog", { name: "Закрыть без сохранения?" });
    expect(within(ask).getAllByRole("button").map((b) => b.textContent)).toEqual(["Вернуться к правке", "Закрыть"]);
    escape();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(codeField()!.value).toBe("graph TD\n  правка");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("крестик при несохранённой правке спрашивает; «Закрыть» закрывает", async () => {
    const onClose = vi.fn();
    openFlow({ onClose });
    await toManual();
    setCode("graph TD\n  правка");
    await userEvent.click(button("Закрыть"));
    const ask = screen.getByRole("alertdialog", { name: "Закрыть без сохранения?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("спецификация, «Вручную»", () => {
  function openSpec(over: { openapi?: string; commit?: (v: string) => Promise<boolean>; onClose?: () => void; manual?: boolean } = {}) {
    render(
      <DocOverlay
        mode="openapi"
        nodeId="n1"
        nodeName="Order API"
        openapi={over.openapi ?? spec("Старая")}
        isArchitect
        initialStage={over.manual ? "manual" : undefined}
        onCommitOpenapi={over.commit ?? vi.fn(() => Promise.resolve(true))}
        onDocEvent={vi.fn()}
        onClose={over.onClose ?? vi.fn()}
      />,
    );
  }

  it("«Сохранить» пишет черновик и возвращает к чтению новой спецификации", async () => {
    const commit = vi.fn(() => Promise.resolve(true));
    openSpec({ commit });
    await toManual();
    setCode(spec("Новая"));
    await userEvent.click(button("Сохранить"));
    expect(commit).toHaveBeenCalledWith(spec("Новая"));
    await waitFor(() => expect(codeField()).toBeNull());
    expect(screen.getByTestId("swagger")).toHaveTextContent("Новая");
  });

  it("пока идёт сохранение, «Сохранить» погашена", async () => {
    const wait = deferred<boolean>();
    openSpec({ commit: () => wait.promise });
    await toManual();
    setCode(spec("Новая"));
    await userEvent.click(button("Сохранить"));
    expect(button("Сохранить")).toBeDisabled();
    wait.resolve(true);
    await waitFor(() => expect(codeField()).toBeNull());
  });

  it("«Отмена» со спецификацией возвращает к чтению без записи", async () => {
    const commit = vi.fn(() => Promise.resolve(true));
    const onClose = vi.fn();
    openSpec({ commit, onClose });
    await toManual();
    setCode(spec("Новая"));
    await userEvent.click(button("Отмена"));
    expect(codeField()).toBeNull();
    expect(screen.getByTestId("swagger")).toHaveTextContent("Старая");
    expect(commit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("новая спецификация: «Нет спецификации» в превью, «Отмена» закрывает окно", async () => {
    const onClose = vi.fn();
    openSpec({ openapi: "", manual: true, onClose });
    expect(codeField()).not.toBeNull();
    expect(screen.getByText("Нет спецификации")).toBeInTheDocument();
    await userEvent.click(button("Отмена"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("предел демо-стенда: «Не сохранилось.», черновик в поле", async () => {
    openSpec({ commit: () => Promise.reject(limit()) });
    await toManual();
    setCode(spec("Новая"));
    await userEvent.click(button("Сохранить"));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Не сохранилось. ${VOLUME}`);
    expect(codeField()!.value).toBe(spec("Новая"));
  });

  it("крестик при несохранённой правке спрашивает, Escape возвращает к правке", async () => {
    const onClose = vi.fn();
    openSpec({ onClose });
    await toManual();
    setCode(spec("Новая"));
    await userEvent.click(button("Закрыть"));
    expect(screen.getByRole("alertdialog", { name: "Закрыть без сохранения?" })).toBeInTheDocument();
    escape();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(codeField()!.value).toBe(spec("Новая"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Новый язык стадии «Вручную» у схемы логики (редизайн, фаза 7б): в шапке только имя
// объекта, название и крестик; подвал одной строкой «Сохранить», «Отмена», справа
// «Удалить схему»; отказ — строкой над кнопками; поля в одну строку на примитивах языка.
describe("схема логики, «Вручную»: подвал и поля на новом языке", () => {
  const foot = () => document.querySelector(".doc-editfoot") as HTMLElement;
  const head = () => document.querySelector(".doc-head") as HTMLElement;

  it("в шапке кнопок правки нет; подвал: «Сохранить», «Отмена», справа «Удалить схему»", async () => {
    openFlow();
    await toManual();
    expect(within(head()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Закрыть"]);
    expect(head()).toHaveTextContent(/^Order APIСоздание заказа$/);
    expect(foot()).toHaveClass("ds-win-foot");
    expect(within(foot()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Сохранить", "Отмена", "Удалить схему"]);
    expect(button("Сохранить")).toHaveClass("ds-btn", "ds-btn--primary");
    expect(button("Отмена")).toHaveClass("ds-btn");
    expect(button("Отмена")).not.toHaveClass("ds-btn--primary");
    // Удаление — тихая кнопка-текст, не кнопка с рамкой.
    expect(button("Удалить схему")).toHaveClass("doc-delbtn");
    expect(button("Удалить схему")).not.toHaveClass("ds-btn");
    expect(screen.queryByText("Превью обновляется сразу")).toBeNull();
    // Прежнего вида в стадии нет.
    expect(document.querySelector(".doc-root .legacy-root")).toBeNull();
  });

  it("у новой схемы в подвале только «Сохранить» и «Отмена»", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([]);
    openFlow({ createNew: true });
    await waitFor(() => expect(codeField()).not.toBeNull());
    expect(within(foot()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Сохранить", "Отмена"]);
  });

  it("отказ сохранения — строкой над кнопками подвала, не под шапкой", async () => {
    vi.mocked(nodeDocsApi.update).mockRejectedValue("сбой");
    openFlow();
    await toManual();
    setCode("graph TD\n  моё");
    await userEvent.click(button("Сохранить"));
    const отказ = await screen.findByText("Схема не сохранена");
    expect(отказ).toHaveClass("ds-danger", "ds-win-err");
    expect(отказ.parentElement).toBe(foot());
    expect(отказ.nextElementSibling).toBe(button("Сохранить"));
    expect(document.querySelector(".doc-notice")).toBeNull();
  });

  it("занятое имя и предел демо — там же, над кнопками", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc(), doc({ id: "d2", name: "Получение заказа" })]);
    vi.mocked(nodeDocsApi.update).mockRejectedValue(limit());
    openFlow();
    await toManual();
    const имя = screen.getByLabelText("Имя схемы");
    await userEvent.clear(имя);
    await userEvent.type(имя, "Получение заказа");
    await userEvent.click(button("Сохранить"));
    expect(screen.getByText("У объекта уже есть схема с таким именем").parentElement).toBe(foot());
    await userEvent.clear(имя);
    await userEvent.type(имя, "Создание заказа 2");
    await userEvent.click(button("Сохранить"));
    const предел = await screen.findByRole("alert");
    expect(предел).toHaveTextContent(`Не сохранилось. ${VOLUME}`);
    expect(предел).toHaveClass("ds-danger", "ds-win-err");
    expect(предел.parentElement).toBe(foot());
    // Одна строка отказа: прежняя ушла.
    expect(screen.queryByText("У объекта уже есть схема с таким именем")).toBeNull();
  });

  it("отказ удаления — над кнопками подвала", async () => {
    vi.mocked(nodeDocsApi.delete).mockRejectedValue("сбой");
    openFlow();
    await toManual();
    await userEvent.click(button("Удалить схему"));
    await userEvent.click(button("Удалить схему?"));
    expect((await screen.findByText("Схема не удалена")).parentElement).toBe(foot());
  });

  it("поля: подпись над полем, поля на примитивах языка, подсказки у «Вид» и «Эндпоинт»", async () => {
    openFlow();
    await toManual();
    const имя = screen.getByLabelText("Имя схемы");
    const вид = screen.getByLabelText("Вид");
    const эндпоинт = screen.getByLabelText("Эндпоинт");
    expect(имя).toHaveClass("ds-input");
    expect(эндпоинт).toHaveClass("ds-input");
    expect(вид.tagName).toBe("SELECT");
    expect(вид.parentElement).toHaveClass("ds-select");
    expect([...document.querySelectorAll(".doc-field-label")].map((e) => e.textContent)).toEqual(["Имя схемы", "Вид", "Эндпоинт"]);
    expect(вид.closest("label")).toHaveAttribute("title", "Обработчик операции или сценарий клиента / фоновый воркер");
    expect(эндпоинт.closest("label")).toHaveAttribute("title", "Эндпоинт из спецификации объекта, который описывает эта схема");
  });

  it("у воркера поля «Эндпоинт» нет, имя занимает строку", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc({ name: "Автоотмена", kind: "worker", operation: null })]);
    openFlow();
    await toManual();
    expect(screen.queryByLabelText("Эндпоинт")).toBeNull();
    expect(screen.getByLabelText("Вид")).toHaveValue("worker");
    expect(screen.getByLabelText("Имя схемы").closest("label")).toHaveClass("doc-field--grow");
    expect(document.querySelectorAll(".doc-fields > label")).toHaveLength(2);
  });
});

// Новый язык стадии «Вручную» у спецификации (редизайн, фаза 7б): в шапке только имя
// объекта, название и крестик; подвал «Сохранить», «Отмена» без примечания; отказ над
// кнопками; при ошибке над превью строка предупреждения без времени.
describe("спецификация, «Вручную»: подвал и строка над превью на новом языке", () => {
  function openSpec(commit: (v: string) => Promise<boolean> = vi.fn(() => Promise.resolve(true))) {
    render(
      <DocOverlay mode="openapi" nodeId="n1" nodeName="Order API" openapi={spec("Старая")} isArchitect
        onCommitOpenapi={commit} onDocEvent={vi.fn()} onClose={vi.fn()} />,
    );
  }
  const foot = () => document.querySelector(".doc-editfoot") as HTMLElement;
  const ЖДАТЬ = { timeout: 3000 };

  it("шапка без кнопок правки; подвал «Сохранить», «Отмена» без примечания", async () => {
    openSpec();
    await toManual();
    const head = document.querySelector(".doc-head") as HTMLElement;
    expect(within(head).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Закрыть"]);
    expect(foot()).toHaveClass("ds-win-foot");
    expect(foot()).toHaveTextContent(/^СохранитьОтмена$/);
    expect(within(foot()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Сохранить", "Отмена"]);
    expect(button("Сохранить")).toHaveClass("ds-btn", "ds-btn--primary");
    expect(screen.queryByText(/черновик/)).toBeNull();
    expect(document.querySelector(".doc-root .legacy-root")).toBeNull();
  });

  it("предел демо-стенда — строкой над кнопками подвала", async () => {
    openSpec(() => Promise.reject(limit()));
    await toManual();
    setCode(spec("Новая"));
    await userEvent.click(button("Сохранить"));
    const предел = await screen.findByRole("alert");
    expect(предел).toHaveClass("ds-danger", "ds-win-err");
    expect(предел.parentElement).toBe(foot());
    expect(предел.nextElementSibling).toBe(button("Сохранить"));
  });

  it("ошибка после удачной правки: «Показан последний текст без ошибок» без времени, строкой ds-warn", async () => {
    openSpec();
    await toManual();
    setCode(spec("Новая"));
    await waitFor(() => expect(screen.getByTestId("swagger")).toHaveTextContent("Новая"), ЖДАТЬ);
    setCode("openapi: [\n  broken");
    const строка = await screen.findByText(/^Показан последний текст без ошибок/, undefined, ЖДАТЬ);
    expect(строка.textContent).toBe("Показан последний текст без ошибок");
    expect(строка).toHaveClass("ds-warn");
    expect(screen.getByTestId("swagger")).toHaveTextContent("Новая");
  });

  it("ошибки без удачного текста: «В спецификации ошибка, превью недоступно»", async () => {
    render(
      <DocOverlay mode="openapi" nodeId="n1" nodeName="Order API" openapi="" isArchitect initialStage="manual"
        onCommitOpenapi={vi.fn()} onDocEvent={vi.fn()} onClose={vi.fn()} />,
    );
    setCode("openapi: [\n  broken");
    expect(await screen.findByText("В спецификации ошибка, превью недоступно", undefined, ЖДАТЬ)).toHaveClass("ds-warn");
  });
});
