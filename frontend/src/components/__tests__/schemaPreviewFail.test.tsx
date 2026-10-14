// Миниатюра схемы на карточке проекта: упавшая раскладка ELK — подпись «Превью
// недоступно», а не вечный пустой каркас (аудит R-23).
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../project/schemaPreviewLayout", () => ({
  resolvePointsElk: () => Promise.reject(new Error("elk упал")),
}));

import SchemaPreview from "../project/SchemaPreview";

describe("SchemaPreview: сбой раскладки", () => {
  it("показывает «Превью недоступно»", async () => {
    const preview = { nodes: [{ id: "a", name: "A", shape: "service" }], edges: [] } as never;
    render(<SchemaPreview preview={preview} />);
    expect(await screen.findByText("Превью недоступно")).toBeInTheDocument();
  });
});
