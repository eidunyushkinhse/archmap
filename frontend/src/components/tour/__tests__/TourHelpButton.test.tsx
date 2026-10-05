// Пилюля «Обучение» в шапке гостя (docs/tasks/demo-tour-2.md, п.2–3): на месте
// прежних «Песочница» + «?», то же действие — пройти обучение заново. Не гостю её нет.
// Пока тур на паузе (docs/tasks/demo-tour-pause.md) — «Продолжить обучение».
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import TourHelpButton from "../TourHelpButton";
import { getIsGuest } from "../../../api/auth";
import { onTourRestart, onTourResume, setTourPaused } from "../tourStore";

vi.mock("../../../api/auth", () => ({ getIsGuest: vi.fn(() => true) }));

describe("TourHelpButton", () => {
  let off: (() => void) | null = null;
  afterEach(() => { off?.(); off = null; setTourPaused(false); });

  it("гостю — пилюля «Обучение», нажатие запускает обучение заново", async () => {
    const restart = vi.fn();
    off = onTourRestart(restart);
    render(<TourHelpButton />);
    const pill = screen.getByRole("button", { name: "Обучение" });
    expect(pill).toHaveAttribute("title", "Пройти обучение заново");
    await userEvent.click(pill);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("тур на паузе — «Продолжить обучение» продолжает его; сняли паузу — снова «Обучение»", async () => {
    const resume = vi.fn();
    off = onTourResume(resume);
    render(<TourHelpButton />);
    act(() => setTourPaused(true));
    const pill = screen.getByRole("button", { name: "Продолжить обучение" });
    expect(pill).toHaveClass("tour-pill--resume");
    await userEvent.click(pill);
    expect(resume).toHaveBeenCalledOnce();
    act(() => setTourPaused(false));
    expect(screen.getByRole("button", { name: "Обучение" })).not.toHaveClass("tour-pill--resume");
  });

  it("не гостю — ничего", () => {
    vi.mocked(getIsGuest).mockReturnValue(false);
    const { container } = render(<TourHelpButton />);
    expect(container).toBeEmptyDOMElement();
  });
});
