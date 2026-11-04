// Ссылка на файл сборщика фактов (фаза 3 docs/tasks/fact-collector.md): путь без агента
// начинается со скачивания archmap-scan.pyz. Сервер называет версию по GET /scan; без файла
// в поставке он отвечает 404, и тогда абзаца нет вовсе: ссылка в никуда хуже никакой.
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ScanFileLink from "../project/ScanFileLink";

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ScanFileLink", () => {
  it("файл есть: ссылка на него с download и версией сборщика", async () => {
    const fetchMock = respond(200, { version: "0.1.0", sha256: "ab".repeat(32), size: 123456 });
    vi.stubGlobal("fetch", fetchMock);

    render(<ScanFileLink />);

    const link = await screen.findByRole("link", { name: "сборщик фактов" });
    expect(link).toHaveAttribute("href", "/api/v1/scan/archmap-scan.pyz");
    expect(link).toHaveAttribute("download");
    expect(screen.getByText(/версия 0\.1\.0/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/scan", expect.anything());
  });

  it("файла в поставке нет (404): ничего не рисует", async () => {
    const fetchMock = respond(404, { detail: "Сборщик фактов в эту поставку не входит" });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ScanFileLink />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Ответ дошёл, а абзаца так и нет.
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
