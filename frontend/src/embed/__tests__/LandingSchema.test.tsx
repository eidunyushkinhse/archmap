// Живая схема лендинга: холст инертен до клика (колесо и свайп листают страницу), а с
// startActive — сразу включён: на телефоне её грузят по тапу на картинку, второй тап лишний.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LandingSchema from "../LandingSchema";
import type { LandingScene } from "../scene";

vi.mock("../../components/LevelGraph", () => ({ default: () => null }));

const SCENE = {
  graph: { nodes: [], endpoints: [], edges: [], layout: { version: 0, items: {} } },
  ancestors: [],
  containerId: null,
  layoutViewId: null,
} as unknown as LandingScene;

describe("LandingSchema", () => {
  it("по умолчанию ждёт приглашения, «Готово» нет", () => {
    render(<LandingSchema scene={SCENE} />);
    expect(screen.getByText("Попробовать")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Готово" })).toBeNull();
  });

  it("startActive — холст сразу включён: приглашения нет, есть «Готово»", () => {
    render(<LandingSchema scene={SCENE} startActive />);
    expect(screen.queryByText("Попробовать")).toBeNull();
    expect(screen.getByRole("button", { name: "Готово" })).toBeTruthy();
  });

  it("повторное «Попробовать» после «Готово» включает холст, а не нажимает «Готово»", async () => {
    // Первый клик доходит до кнопки под курсором (лупа на узле). «Готово» стоит на месте
    // приглашения — клик по приглашению не должен тут же выключить холст обратно.
    const original = document.elementFromPoint;
    document.elementFromPoint = () => document.querySelector(".lp-done");
    try {
      render(<LandingSchema scene={SCENE} startActive />);
      fireEvent.click(screen.getByRole("button", { name: "Готово" }));
      fireEvent.click(screen.getByText("Попробовать"));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await waitFor(() => expect(screen.getByRole("button", { name: "Готово" })).toBeTruthy());
      expect(screen.queryByText("Попробовать")).toBeNull();
    } finally {
      document.elementFromPoint = original;
    }
  });
});
