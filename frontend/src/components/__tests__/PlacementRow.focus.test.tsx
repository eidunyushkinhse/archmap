// «Изменить размещение» на странице объекта (редизайн, фаза 13в-2, хвост приёмки 13в-1):
// пока читаются площадки, кнопка не запирается. Запертая кнопка теряла фокус ещё до
// открытия окна, окно запоминало как «откуда открыли» пустое место, и после закрытия окна
// фокус клавиатуры оставался нигде. Теперь повторное нажатие во время чтения гасится, а
// после закрытия окна фокус снова на кнопке. Окно настоящее (ui/Modal): возврат фокуса
// делает оно.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PlacementRow from "../nodePage/PlacementRow";
import { deploymentApi } from "../../api/deployment";
import type { Node, SiteOut } from "../../types";

vi.mock("../../api/deployment", () => ({
  deploymentApi: { sites: vi.fn(), setPlacements: vi.fn(), createSite: vi.fn() },
}));
vi.mock("../../api/nodes", () => ({ nodesApi: { getAll: vi.fn() } }));

const NODE: Node = {
  id: "n1", name: "Витрина", description: null, role: null, technology: null, parent_id: null,
  openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
  child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
  element: null, element_effective: "container", container_name: null,
  version: 1, created_at: "", updated_at: "", sites: [],
};
const SITES: SiteOut[] = [
  { id: "vm1", name: "vm-1", kind: "vm", technology: null, description: null, parent_id: null, version: 1, instance_count: 0 },
];

// Ответ чтения площадок, который тест отдаёт сам: так видно состояние «читается».
function deferredSites() {
  let resolve: (v: SiteOut[]) => void = () => {};
  vi.mocked(deploymentApi.sites).mockReturnValue(new Promise<SiteOut[]>((r) => { resolve = r; }));
  return (v: SiteOut[]) => resolve(v);
}

describe("PlacementRow: фокус кнопки «Изменить размещение»", () => {
  beforeEach(() => vi.clearAllMocks());

  it("во время чтения кнопка не заперта и держит фокус, повторное нажатие гасится", async () => {
    const user = userEvent.setup();
    const answer = deferredSites();
    render(<PlacementRow node={NODE} element={{ kind: "container" }} containerSites={null} isArchitect onChanged={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Изменить размещение" });
    btn.focus();
    await user.keyboard("{Enter}");
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(document.activeElement).toBe(btn);
    await user.keyboard("{Enter}");
    await user.click(btn);
    expect(deploymentApi.sites).toHaveBeenCalledTimes(1);
    answer(SITES);
    await waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
    expect(btn).toHaveAttribute("aria-busy", "false");
  });

  it("после закрытия окна фокус снова на кнопке", async () => {
    const user = userEvent.setup();
    const answer = deferredSites();
    render(<PlacementRow node={NODE} element={{ kind: "container" }} containerSites={null} isArchitect onChanged={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Изменить размещение" });
    btn.focus();
    await user.keyboard("{Enter}");
    answer(SITES);
    await waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
    const dialog = document.querySelector("dialog[open]") as HTMLDialogElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
    const cancel = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Отмена");
    expect(cancel).toBeDefined();
    await user.click(cancel as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull());
    expect(document.activeElement).toBe(btn);
  });
});
