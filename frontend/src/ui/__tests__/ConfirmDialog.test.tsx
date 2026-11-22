// Страховка поведения общего подтверждения (ConfirmDialog) перед сменой вида: главная
// кнопка и «Отмена» зовут свои колбэки, при busy обе заперты и главная говорит busyLabel,
// отказ виден, вид card рисуется без <dialog> (вложенный dialog в окне редактора процесса
// нельзя), оба тона дают ту же механику. Modal настоящий: test-setup открывает <dialog>.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import ConfirmDialog from "../ConfirmDialog";

function show(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ConfirmDialog
      title="Удалить «Order API»?"
      lead="Его связи будут удалены вместе с ним:"
      confirmLabel="Удалить"
      busyLabel="Удаляем"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onConfirm, onCancel, ...view };
}

describe("ConfirmDialog", () => {
  it("главная кнопка и «Отмена» зовут каждая свой колбэк", async () => {
    const { onConfirm, onCancel } = show();
    expect(screen.getByText("Удалить «Order API»?")).toBeInTheDocument();
    expect(screen.getByText("Его связи будут удалены вместе с ним:")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("главная кнопка первой, «Отмена» за ней; подпись «Отмена» задаётся", () => {
    show({ cancelLabel: "Оставить" });
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Удалить", "Оставить"]);
  });

  it("busy: обе кнопки заперты, главная говорит busyLabel", () => {
    show({ busy: true });
    expect(screen.getByRole("button", { name: "Удаляем" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
  });

  it("busy без busyLabel: подпись главной прежняя, кнопка заперта", () => {
    show({ busy: true, busyLabel: undefined });
    expect(screen.getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("отказ виден в окне", () => {
    show({ error: "Не удалось удалить" });
    expect(screen.getByText("Не удалось удалить")).toBeInTheDocument();
  });

  it("вид card рисуется без <dialog>, кнопки те же", async () => {
    const { onConfirm, container } = show({ variant: "card" });
    expect(container.querySelector("dialog")).toBeNull();
    expect(document.querySelector("dialog")).toBeNull();
    expect(screen.getByText("Удалить «Order API»?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Отмена" })).toBeEnabled();
  });

  it("модальный вид — в <dialog>", () => {
    show();
    expect(document.querySelector("dialog")).not.toBeNull();
  });

  it("оба тона: подпись и запертость при busy одинаковы", () => {
    const danger = show({ tone: "danger", busy: true });
    expect(screen.getByRole("button", { name: "Удаляем" })).toBeDisabled();
    danger.unmount();
    show({ tone: "neutral", confirmLabel: "Привязать", busyLabel: "Привязываем" });
    expect(screen.getByRole("button", { name: "Привязать" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeEnabled();
  });
});

// Вид нового языка (редизайн, фаза 9а): каркас окна .ds-win, без знака-предупреждения,
// тон различим классом главной кнопки.
describe("ConfirmDialog: каркас окна", () => {
  const root = () => document.querySelector(".ds-confirm") as HTMLElement;

  it("заголовок h2 окна, пояснение, кнопки в подвале; ни знака, ни инлайн-стилей", () => {
    show();
    expect(root()).toHaveClass("ds", "ds-win", "ds-confirm");
    expect(screen.getByRole("heading", { level: 2, name: "Удалить «Order API»?" })).toHaveClass("ds-win-title");
    expect(screen.getByText("Его связи будут удалены вместе с ним:")).toHaveClass("ds-confirm-lead");
    expect(root().querySelectorAll("svg")).toHaveLength(0);
    expect(root().querySelectorAll("[style]")).toHaveLength(0);
    const foot = root().querySelector(".ds-win-foot") as HTMLElement;
    expect([...foot.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Удалить", "Отмена"]);
  });

  it("тон: опасный — красная главная, нейтральный — синяя; «Отмена» обычная", () => {
    const danger = show();
    expect(screen.getByRole("button", { name: "Удалить" }).className).toBe("ds-btn ds-btn--danger");
    expect(screen.getByRole("button", { name: "Отмена" }).className).toBe("ds-btn");
    danger.unmount();
    show({ tone: "neutral", confirmLabel: "Привязать" });
    expect(screen.getByRole("button", { name: "Привязать" }).className).toBe("ds-btn ds-btn--primary");
  });

  it("отказ — строкой над кнопками подвала", () => {
    show({ error: "Не удалось удалить" });
    const err = screen.getByText("Не удалось удалить");
    expect(err).toHaveClass("ds-danger", "ds-win-err");
    expect(err.parentElement).toHaveClass("ds-win-foot");
  });

  it("без пояснения и содержимого тела нет; пустое условное содержимое тела не заводит", () => {
    const bare = show({ lead: undefined });
    expect(root().querySelector(".ds-win-body")).toBeNull();
    bare.unmount();
    show({ lead: undefined, children: false });
    expect(root().querySelector(".ds-win-body")).toBeNull();
  });

  it("содержимое — в теле после пояснения", () => {
    show({ children: <ul className="ds-confirm-list"><li>строка</li></ul> });
    const body = root().querySelector(".ds-win-body") as HTMLElement;
    expect(body.firstElementChild).toHaveClass("ds-confirm-lead");
    expect(body.lastElementChild).toHaveClass("ds-confirm-list");
  });

  it("confirmDisabled запирает только главную кнопку, вместе с busy — обе", () => {
    const view = show({ confirmDisabled: true });
    expect(screen.getByRole("button", { name: "Удалить" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeEnabled();
    view.unmount();
    show({ confirmDisabled: true, busy: true });
    expect(screen.getByRole("button", { name: "Удаляем" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
  });

  it("onSubmit: Enter в поле окна зовёт его, а не главную кнопку", async () => {
    const onSubmit = vi.fn();
    const { onConfirm } = show({ onSubmit, children: <input aria-label="Имя" /> });
    await userEvent.type(screen.getByRole("textbox", { name: "Имя" }), "x{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("вид card: тот же каркас карточкой", () => {
    show({ variant: "card" });
    expect(root()).toHaveClass("ds", "ds-win", "ds-confirm", "ds-confirm--card");
    expect(root().querySelector(".ds-win-title")?.tagName).toBe("H2");
    expect(screen.getByRole("button", { name: "Удалить" }).className).toBe("ds-btn ds-btn--danger");
  });
});
