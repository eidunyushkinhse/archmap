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
