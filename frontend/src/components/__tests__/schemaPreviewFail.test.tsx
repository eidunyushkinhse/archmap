// Миниатюра схемы на карточке проекта: упавшая раскладка ELK — подпись «Схему не
// удалось показать», а не вечный пустой каркас (аудит R-23).
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../project/schemaPreviewLayout", () => ({
  resolvePointsElk: () => Promise.reject(new Error("elk упал")),
}));

import SchemaPreview from "../project/SchemaPreview";

describe("SchemaPreview: сбой раскладки", () => {
  it("показывает «Схему не удалось показать»", async () => {
    const preview = { nodes: [{ id: "a", name: "A", shape: "service" }], edges: [] } as never;
    render(<SchemaPreview preview={preview} />);
    expect(await screen.findByText("Схему не удалось показать")).toBeInTheDocument();
  });
});
