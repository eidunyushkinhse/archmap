// Страховка трёх сообщений пределов демо-стенда (components/demo/DemoLimitNotice) перед
// переводом на новый язык (редизайн, фаза 13б, меняется только вид): тексты с выделенным
// началом, роль alert, подпись и цифры полоски «142 из 100», заполнение полоски в процентах
// с пределом 100. Тексты в окнах ввоза и в разделах страницы объекта держат
// demoImportLimits.test и demoEditLimits.test; здесь — сами компоненты.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoExcessNotice, FileTooBigNotice, LimitNotice } from "../demo/DemoLimitNotice";

// Заполнение полоски — единственный элемент с шириной в инлайн-стиле.
const fillOf = (root: HTMLElement): HTMLElement => {
  const fill = root.querySelector<HTMLElement>("[style*='width']");
  if (!fill) throw new Error("нет заполнения полоски");
  return fill;
};

describe("DemoExcessNotice", () => {
  it("сообщение: выделенное начало и текст превышения, роль alert", () => {
    render(<DemoExcessNotice excess={{ kind: "nodes", actual: 142, limit: 100 }} scope="files" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Проект не помещается в демо. В файлах 142 объекта, а в демо можно до 100. "
      + "Уберите часть файлов или загрузите проект поменьше.",
    );
    const head = screen.getByText("Проект не помещается в демо.");
    expect(head.tagName).toMatch(/^(B|STRONG)$/);
    expect(alert).toContainElement(head);
  });

  it("полоска: подпись вида и «142 из 100» вне сообщения, заполнение не больше 100%", () => {
    const { container } = render(<DemoExcessNotice excess={{ kind: "nodes", actual: 142, limit: 100 }} scope="files" />);
    expect(screen.getByText("Объекты")).toBeInTheDocument();
    expect(screen.getByText("142 из 100")).toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent("142 из 100");
    expect(fillOf(container).style.width).toBe("100%");
  });

  it("заполнение в процентах от предела, округлённое", () => {
    const { container } = render(<DemoExcessNotice excess={{ kind: "edges", actual: 61, limit: 120 }} scope="project" />);
    expect(screen.getByText("Связи")).toBeInTheDocument();
    expect(screen.getByText("61 из 120")).toBeInTheDocument();
    expect(fillOf(container).style.width).toBe("51%");
    expect(screen.getByRole("alert")).toHaveTextContent("После загрузки в проекте будет 61 связь, а в демо можно до 120.");
  });

  it("текст: цифры размером («300 КБ из 250 КБ»), предел 0 не делит на ноль", () => {
    const { container, unmount } = render(<DemoExcessNotice excess={{ kind: "text", actual: 300 * 1024, limit: 250 * 1024 }} scope="files" />);
    expect(screen.getByText("Текст")).toBeInTheDocument();
    expect(screen.getByText("300 КБ из 250 КБ")).toBeInTheDocument();
    expect(fillOf(container).style.width).toBe("100%");
    unmount();
    const zero = render(<DemoExcessNotice excess={{ kind: "sites", actual: 0, limit: 0 }} scope="files" />);
    expect(fillOf(zero.container).style.width).toBe("0%");
  });
});

describe("FileTooBigNotice", () => {
  it("выделенное начало, имя файла, размер и предел, роль alert", () => {
    render(<FileTooBigNotice name="billing-full.zip" size={Math.round(1.4 * 1024 * 1024)} limit={250 * 1024} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Файл слишком большой для демо. «billing-full.zip» весит 1,4 МБ, а в демо можно загрузить до 250 КБ.",
    );
    expect(screen.getByText("Файл слишком большой для демо.").tagName).toMatch(/^(B|STRONG)$/);
  });
});

describe("LimitNotice", () => {
  it("начало из сообщения выделено, текст сервера следом, роль alert", () => {
    render(<LimitNotice message={{ head: "Не сохранилось.", text: "Демо-проект поддерживает до 250 КБ текста." }} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Не сохранилось. Демо-проект поддерживает до 250 КБ текста.");
    const head = screen.getByText("Не сохранилось.");
    expect(head.tagName).toMatch(/^(B|STRONG)$/);
    expect(alert).toContainElement(head);
  });
});
