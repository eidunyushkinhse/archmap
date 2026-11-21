// Плашка «Документацию пора обновить» (components/project/CodeChangeNotice.tsx): строка на
// репозиторий из сигнала CI, «Документация актуальна» снимает напоминание вручную.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CodeChangeNotice from "../project/CodeChangeNotice";
import { changeLine } from "../project/codeChangeText";
import { codeChangesApi } from "../../api/codeChanges";
import type { CodeChangeAlert } from "../../types";

vi.mock("../../api/codeChanges", () => ({ codeChangesApi: { dismiss: vi.fn() } }));
// Окно обновления из кода в этих тестах не открывается: тяжёлые зависимости не нужны.
vi.mock("../docsImport/SyncRepoModal", () => ({
  default: ({ onApplied }: { onApplied: (m: string) => void }) => (
    <button onClick={() => onApplied("готово")}>применить</button>
  ),
}));

function change(over: Partial<CodeChangeAlert> = {}): CodeChangeAlert {
  return {
    id: "c-1", repo: "gitlab.example.org/market/shop", merges: 3,
    first_at: "2026-11-18T09:00:00Z", last_at: "2026-11-21T09:00:00Z",
    first_commit: "abcdef1", last_commit: "1234567", branch: "main",
    nodes: [
      { node_id: "n-1", node_name: "Заказы" },
      { node_id: "n-2", node_name: "Корзина" },
    ],
    ...over,
  };
}

describe("CodeChangeNotice", () => {
  beforeEach(() => vi.clearAllMocks());

  it("строка называет репозиторий, слияния и объекты", () => {
    expect(changeLine(change())).toBe(
      "gitlab.example.org/market/shop: с 18 ноября 3 слияния в main. Документацию 2 объектов пора обновить.",
    );
    expect(changeLine(change({ merges: 1, branch: null, nodes: [{ node_id: "n", node_name: "А" }] })))
      .toBe("gitlab.example.org/market/shop: с 18 ноября 1 слияние. Документацию 1 объекта пора обновить.");
  });

  it("нет напоминаний — плашки нет", () => {
    const { container } = render(
      <CodeChangeNotice projectId="p" changes={[]} onSynced={vi.fn()} onDismissed={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("«Документация актуальна» снимает напоминание, «Обновить из кода» открывает окно", async () => {
    vi.mocked(codeChangesApi.dismiss).mockResolvedValue(undefined);
    const onDismissed = vi.fn();
    const onSynced = vi.fn();
    render(<CodeChangeNotice projectId="p" changes={[change()]} onSynced={onSynced} onDismissed={onDismissed} />);

    expect(screen.getByText(/Документацию 2 объектов/)).toHaveAttribute("title", "Заказы, Корзина");
    await userEvent.click(screen.getByRole("button", { name: "Документация актуальна" }));
    expect(codeChangesApi.dismiss).toHaveBeenCalledWith("c-1");
    expect(onDismissed).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Обновить из кода" }));
    await userEvent.click(screen.getByRole("button", { name: "применить" }));
    expect(onSynced).toHaveBeenCalledTimes(1);
  });

  it("отказ снятия виден на плашке", async () => {
    vi.mocked(codeChangesApi.dismiss).mockRejectedValue(new Error("Нет связи"));
    render(<CodeChangeNotice projectId="p" changes={[change()]} onSynced={vi.fn()} onDismissed={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Документация актуальна" }));
    expect(await screen.findByText("Нет связи")).toBeInTheDocument();
  });
});
