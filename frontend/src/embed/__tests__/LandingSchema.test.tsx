// Живая схема лендинга: холст инертен до клика (колесо и свайп листают страницу), а с
// startActive — сразу включён: на телефоне её грузят по тапу на картинку, второй тап лишний.
import { render, screen } from "@testing-library/react";
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
});
