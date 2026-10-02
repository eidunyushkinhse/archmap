// Превью схемы на странице входа: цикл requestAnimationFrame останавливается при
// размонтировании; при prefers-reduced-motion — статичный раскрытый кадр без цикла.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import LoginScenePreview from "../login/LoginScenePreview";

const ARIA = "Схема маркетплейса «Ярмарка»: контейнер «Сервис заказов» раскрывается и сворачивается";

function mockMotion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

function mockRaf() {
  const raf = vi.fn((_cb: FrameRequestCallback) => 7);
  const caf = vi.fn();
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", caf);
  return { raf, caf };
}

describe("LoginScenePreview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("стартует со свёрнутого кадра и гасит цикл при размонтировании", () => {
    mockMotion(false);
    const { raf, caf } = mockRaf();
    const { unmount } = render(<LoginScenePreview />);
    expect(screen.getByRole("img", { name: ARIA })).toBeInTheDocument();
    expect(screen.getAllByText("Сервис заказов")).toHaveLength(1);
    expect(screen.queryByText("Order API")).toBeNull();
    expect(raf).toHaveBeenCalled();
    unmount();
    expect(caf).toHaveBeenCalledWith(7);
  });

  it("prefers-reduced-motion: раскрытый кадр, цикла нет", () => {
    mockMotion(true);
    const { raf } = mockRaf();
    render(<LoginScenePreview />);
    expect(screen.getByText("Order API")).toBeInTheDocument();
    expect(screen.getByText("Оркестратор")).toBeInTheDocument();
    expect(screen.getByText("События")).toBeInTheDocument();
    expect(raf).not.toHaveBeenCalled();
  });
});
