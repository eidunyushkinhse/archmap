// Загрузка OpenAPI-спеки из файла: кнопка в шапке редактора и перетаскивание на
// поле. Содержимое кладётся в редактор ОБЫЧНОЙ правкой, поэтому дальше работают
// разбор, превью и привычное сохранение — отдельного канала записи нет.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FlowchartDoc from "../inspector/FlowchartDoc";
import OpenApiDoc from "../inspector/OpenApiDoc";

// Swagger UI тяжёлый и грузится ленивым чанком — в тестах он не нужен.
vi.mock("../OpenApiViewer", () => ({ default: () => <div data-testid="swagger" /> }));

const SPEC = "openapi: 3.0.0\ninfo:\n  title: Из файла\n  version: 1.0.0\npaths: {}\n";

// Тип нейтральный: диалог выбора сверяет файл с маской accept по РАСШИРЕНИЮ, и
// подсовывать «text/yaml» картинке значило бы протащить её мимо той же проверки,
// что стоит в браузере.
const mkFile = (text: string, name: string) => new File([text], name, { type: "text/plain" });

function renderDoc(over: { initial?: string; isArchitect?: boolean } = {}) {
  const onDraft = vi.fn();
  const view = render(
    <OpenApiDoc
      initial={over.initial ?? ""}
      isArchitect={over.isArchitect ?? true}
      showCode
      onDraft={onDraft}
    />,
  );
  return { ...view, onDraft };
}

const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const fileInput = (c: HTMLElement) => c.querySelector('input[type="file"]') as HTMLInputElement;
const loadBtn = () => screen.queryByRole("button", { name: "Загрузить файл" });

// Чтение файла асинхронное, а дефолтные 1000 мс у waitFor под нагрузкой
// кончаются раньше — та же болезнь, что вылечена в NodePage.test.tsx (bdb7186).
// ⚠ Бюджет waitFor 5000 мс РАВЕН дефолтному таймауту самого теста: под полным
// прогоном гейта (150+ с тестов в параллели) тест умирал раньше, чем ожидание
// (дважды за вечер 2026-09-03). Тесту — запас втрое больше бюджета ожидания.
const ЖДАТЬ = { timeout: 5000 };
vi.setConfig({ testTimeout: 15_000 });

describe("OpenAPI: загрузка спеки из файла", () => {
  it("архитектору предлагается загрузить файл", () => {
    renderDoc();
    expect(loadBtn()).toBeTruthy();
  });

  it("наблюдателю — нет: править он всё равно не может", () => {
    renderDoc({ isArchitect: false });
    expect(loadBtn()).toBeNull();
  });

  it("подсказка говорит про спеку и её форматы", () => {
    renderDoc();
    const hint = loadBtn()?.getAttribute("title") ?? "";
    expect(hint).toContain("спеку");
    expect(hint).toContain(".yaml");
    expect(hint).not.toContain(".mmd"); // колонка общая — чужой текст сюда не подставляется
  });

  it("выбранный файл попадает в поле редактора", async () => {
    const { container } = renderDoc();

    await userEvent.upload(fileInput(container), mkFile(SPEC, "api.yaml"));

    await waitFor(() => expect(field().value).toBe(SPEC));
  });

  it("загруженная спека уходит окну черновиком — пишет её «Сохранить» окна", async () => {
    // Отдельного канала записи нет: файл — это правка, которую пользователь видит
    // в поле и превью до того, как она уедет в БД (вьюер v2: сохраняет окно).
    const { container, onDraft } = renderDoc();

    await userEvent.upload(fileInput(container), mkFile(SPEC, "api.yaml"));
    await waitFor(() => expect(field().value).toBe(SPEC));

    expect(onDraft).toHaveBeenLastCalledWith(SPEC);
  });

  it("колонка кода сама не пишет: ни своей кнопки «Сохранить», ни записи по уходу фокуса", async () => {
    const { onDraft } = renderDoc({ initial: "openapi: 3.0.0\npaths: {}\n" });
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    await userEvent.click(field());
    await userEvent.tab();
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("файл заменяет прежнюю спеку целиком, а не дописывается", async () => {
    const { container } = renderDoc({ initial: "openapi: 3.0.0\npaths: {}\nold: true\n" });

    await userEvent.upload(fileInput(container), mkFile(SPEC, "api.yaml"));

    await waitFor(() => expect(field().value).toBe(SPEC));
  });

  it("перетаскивание файла на поле работает так же, как кнопка", async () => {
    renderDoc();

    fireEvent.drop(field(), { dataTransfer: { files: [mkFile(SPEC, "api.yaml")] } });

    await waitFor(() => expect(field().value).toBe(SPEC));
  });

  it("двоичный файл в поле не льётся — редактор остаётся прежним", async () => {
    renderDoc({ initial: "openapi: 3.0.0\npaths: {}\n" });

    fireEvent.drop(field(), { dataTransfer: { files: [mkFile("PNG\u0000\u0000data", "logo.png")] } });

    await screen.findByText("Это не текстовый файл");
    expect(field().value).toBe("openapi: 3.0.0\npaths: {}\n");
  });

  it("слишком большой файл отклоняется с внятной причиной", async () => {
    const { container } = renderDoc();
    const huge = mkFile("x", "huge.yaml");
    Object.defineProperty(huge, "size", { value: 9 * 1024 * 1024 });

    await userEvent.upload(fileInput(container), huge);

    await screen.findByText(/Файл больше 8 МБ/);
    expect(field().value).toBe("");
  });

  it("отказ гаснет, как только пользователь правит текст", async () => {
    const { container } = renderDoc();
    const huge = mkFile("x", "huge.yaml");
    Object.defineProperty(huge, "size", { value: 9 * 1024 * 1024 });
    await userEvent.upload(fileInput(container), huge);
    await screen.findByText(/Файл больше 8 МБ/);

    await userEvent.type(field(), "o");

    expect(screen.queryByText(/Файл больше 8 МБ/)).toBeNull();
  });

  it("JSON-спека принимается наравне с YAML", async () => {
    // openapi.json встречается не реже yaml, а разбирает его тот же парсер
    // (JSON — подмножество YAML), поэтому отдельной ветки не нужно.
    const { container } = renderDoc();
    const json = JSON.stringify({ openapi: "3.0.0", info: { title: "J", version: "1" }, paths: {} });

    await userEvent.upload(fileInput(container), mkFile(json, "openapi.json"));

    await waitFor(() => expect(field().value).toBe(json));
    await screen.findByText("Синтаксис корректен");
  });

  it("битый файл принимается, но статус говорит про ошибку разбора", async () => {
    // Спека хранится сырой даже невалидной — блокировать загрузку нельзя, иначе
    // нельзя будет починить файл прямо в редакторе.
    const { container } = renderDoc();

    await userEvent.upload(fileInput(container), mkFile("openapi: [\n  broken", "bad.yaml"));

    await waitFor(() => expect(field().value).toContain("broken"));
  });
});

// ── Схемы логики (mermaid) ────────────────────────────────────────────────────
const CHART = "graph TD\n  A[Старт] --> B[Конец]";

function renderChart(over: { initial?: string; isArchitect?: boolean } = {}) {
  const onDraft = vi.fn();
  const view = render(
    <FlowchartDoc
      initial={over.initial ?? ""}
      nodeId="node-1"
      isArchitect={over.isArchitect ?? true}
      showCode
      onDraft={onDraft}
    />,
  );
  return { ...view, onDraft };
}

describe("Логика: загрузка mermaid-схемы из файла", () => {
  it("архитектору предлагается загрузить файл", () => {
    renderChart();
    expect(loadBtn()).toBeTruthy();
  });

  it("наблюдателю — нет", () => {
    renderChart({ isArchitect: false });
    expect(loadBtn()).toBeNull();
  });

  it("подсказка говорит про схему и её форматы, а не про спеку", () => {
    // Колонка редактора общая на оба режима: зашитый в неё текст врал бы в одном.
    renderChart();
    const hint = loadBtn()?.getAttribute("title") ?? "";
    expect(hint).toContain("схему");
    expect(hint).toContain(".mmd");
    expect(hint).not.toContain("спеку");
    expect(hint).not.toContain(".yaml");
  });

  it("про перетаскивание сказано в обоих режимах", () => {
    renderChart();
    expect(loadBtn()?.getAttribute("title")).toContain("перетащить");
  });

  it("выбранный файл попадает в поле редактора", async () => {
    const { container } = renderChart();

    await userEvent.upload(fileInput(container), mkFile(CHART, "logic.mmd"));

    await waitFor(() => expect(field().value).toBe(CHART), ЖДАТЬ);
  });

  it("загруженная схема уходит окну черновиком — пишет её «Сохранить» окна", async () => {
    // Отдельного канала записи нет: файл — обычная правка. Сохраняет окно явной
    // кнопкой в шапке (вьюер v2), своего «Сохранить» у колонки кода больше нет.
    const { container, onDraft } = renderChart();

    await userEvent.upload(fileInput(container), mkFile(CHART, "logic.mmd"));
    await waitFor(() => expect(field().value).toBe(CHART), ЖДАТЬ);

    expect(onDraft).toHaveBeenLastCalledWith(CHART);
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
  });

  it("перетаскивание файла на поле работает так же, как кнопка", async () => {
    renderChart();

    fireEvent.drop(field(), { dataTransfer: { files: [mkFile(CHART, "logic.mmd")] } });

    await waitFor(() => expect(field().value).toBe(CHART), ЖДАТЬ);
  });

  it("обёртка ```mermaid снимается — схема грузится готовой к разбору", async () => {
    // Схемы чаще всего лежат кусочком markdown; без снятия обёртки пользователь
    // получал бы ошибку разбора на первой же строке.
    const { container } = renderChart();

    await userEvent.upload(
      fileInput(container),
      mkFile("```mermaid\n" + CHART + "\n```\n", "doc.md"),
    );

    await waitFor(() => expect(field().value).toBe(CHART), ЖДАТЬ);
  });

  it("набранную руками обёртку НЕ снимаем", async () => {
    // Подготовка содержимого — про файл, а не про поле. Человек, написавший ```
    // сам, сделал это сознательно; молча стирать его ввод нельзя.
    renderChart();

    await userEvent.type(field(), "```mermaid{Enter}graph TD{Enter}```");

    expect(field().value).toBe("```mermaid\ngraph TD\n```");
  });

  it("двоичный файл в поле не льётся", async () => {
    renderChart({ initial: CHART });

    fireEvent.drop(field(), { dataTransfer: { files: [mkFile("PNG\u0000\u0000data", "logo.png")] } });

    await screen.findByText("Это не текстовый файл");
    expect(field().value).toBe(CHART);
  });

  it("слишком большой файл отклоняется, а отказ гаснет на правке", async () => {
    const { container } = renderChart();
    const huge = mkFile("x", "huge.mmd");
    Object.defineProperty(huge, "size", { value: 9 * 1024 * 1024 });

    await userEvent.upload(fileInput(container), huge);
    await screen.findByText(/Файл больше 8 МБ/);
    await userEvent.type(field(), "g");

    expect(screen.queryByText(/Файл больше 8 МБ/)).toBeNull();
  });
});
