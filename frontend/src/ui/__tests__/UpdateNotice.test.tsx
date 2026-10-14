import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import UpdateNotice, { UPDATE_NOTICE } from "../UpdateNotice";

describe("UpdateNotice (аудит R-7)", () => {
  it("молчит, пока чанки грузятся; на vite:preloadError — плашка с кнопкой", () => {
    render(<UpdateNotice />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      window.dispatchEvent(new Event("vite:preloadError"));
    });

    expect(screen.getByRole("status")).toHaveTextContent(UPDATE_NOTICE);
    expect(screen.getByRole("button", { name: "Обновить" })).toBeInTheDocument();
  });
});
