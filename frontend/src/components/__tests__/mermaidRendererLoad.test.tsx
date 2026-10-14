// Рендерер схем при отказе загрузки чанка mermaid (аудит R-7): после выката старый чанк
// пропадает с сервера — это не ошибка в тексте схемы, и показывать «Ошибка в синтаксисе»
// нельзя.
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../mermaidLoader", async () => {
  const real = await vi.importActual<typeof import("../mermaidLoader")>("../mermaidLoader");
  return {
    ...real,
    mermaidLoaded: () => false,
    loadMermaid: () => Promise.reject(new real.MermaidLoadError(real.MERMAID_LOAD_FAILED)),
  };
});

import MermaidRenderer from "../MermaidRenderer";
import { MERMAID_LOAD_FAILED } from "../mermaidLoader";

describe("MermaidRenderer: чанк не загрузился", () => {
  it("без колбэка — текст «обновите страницу», а не «Ошибка в синтаксисе»", async () => {
    render(<MermaidRenderer chart={"graph TD\n  A --> B"} />);
    expect(await screen.findByText(MERMAID_LOAD_FAILED)).toBeInTheDocument();
    expect(screen.queryByText("Ошибка в синтаксисе диаграммы")).toBeNull();
  });

  it("с колбэком — статус ошибки без номера строки", async () => {
    const onStatus = vi.fn();
    render(<MermaidRenderer chart={"graph TD\n  A --> B"} onStatus={onStatus} />);
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({ kind: "error", line: undefined, message: MERMAID_LOAD_FAILED }),
    );
  });
});
