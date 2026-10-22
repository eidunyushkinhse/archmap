// Окно «Площадки»: дерево с числом объектов; архитектору — добавить, изменить (CAS,
// чужая правка перечитывает окно), удалить с подтверждением (с вложенными — нельзя);
// читателю — только просмотр.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SitesDialog from "../deployment/SitesDialog";
import { deploymentApi } from "../../api/deployment";
import { ApiError } from "../../api/client";
import type { SiteOut } from "../../types";

vi.mock("../../ui/Modal", () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../../api/deployment", () => ({
  deploymentApi: { sites: vi.fn(), createSite: vi.fn(), updateSite: vi.fn(), deleteSite: vi.fn() },
}));

function site(id: string, over: Partial<SiteOut> = {}): SiteOut {
  return { id, name: id, kind: "vm", technology: null, description: null, parent_id: null, version: 3, instance_count: 0, ...over };
}
const SITES = [
  site("Облако", { kind: "cloud", technology: "AWS" }),
  site("Кластер", { parent_id: "Облако", instance_count: 3 }),
  site("Стойка", { kind: "physical", instance_count: 1 }),
];

function setup(isArchitect = true) {
  const props = { onClose: vi.fn(), onChanged: vi.fn() };
  render(<SitesDialog isArchitect={isArchitect} {...props} />);
  return props;
}
const row = (name: string) => screen.getByText(name, { selector: ".site-row-name" }).closest(".site-row") as HTMLElement;

describe("SitesDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deploymentApi.sites).mockResolvedValue(SITES);
  });

  it("дерево с числом объектов; читателю — без правки", async () => {
    setup(false);
    expect(await screen.findByText("Кластер")).toBeInTheDocument();
    expect(within(row("Кластер")).getByText("3 объекта")).toBeInTheDocument();
    expect(within(row("Стойка")).getByText("1 объект")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Добавить площадку" })).toBeNull();
  });

  it("создание: форма → createSite → список перечитан, хозяин извещён", async () => {
    vi.mocked(deploymentApi.createSite).mockResolvedValue(site("ВМ-1"));
    const props = setup();
    await screen.findByText("Кластер");
    await userEvent.click(screen.getByRole("button", { name: "+ Добавить площадку" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Имя" }), "ВМ-1");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Вид" }), "vm");
    await userEvent.type(screen.getByRole("textbox", { name: "Технология" }), "Ubuntu 24.04");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(deploymentApi.createSite).toHaveBeenCalledWith({
      name: "ВМ-1", kind: "vm", technology: "Ubuntu 24.04", description: null, parent_id: null,
    }));
    expect(props.onChanged).toHaveBeenCalled();
    await waitFor(() => expect(deploymentApi.sites).toHaveBeenCalledTimes(2));
  });

  it("правка с CAS: base_version — версия площадки; родителем нельзя выбрать саму и вложенные", async () => {
    vi.mocked(deploymentApi.updateSite).mockResolvedValue(site("Облако"));
    const props = setup();
    await screen.findByText("Кластер");
    await userEvent.click(within(row("Облако")).getByRole("button", { name: "изменить" }));
    const parent = screen.getByRole("combobox", { name: "Внутри площадки" });
    const options = within(parent).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Нет, корневая", "Стойка"]);
    const name = screen.getByRole("textbox", { name: "Имя" });
    await userEvent.clear(name);
    await userEvent.type(name, "Облако AWS");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(deploymentApi.updateSite).toHaveBeenCalledWith("Облако", {
      name: "Облако AWS", kind: "cloud", technology: "AWS", description: null, parent_id: null, base_version: 3,
    }));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("правка, а площадку уже изменили в другой сессии: сообщение и перечитанное окно", async () => {
    vi.mocked(deploymentApi.updateSite).mockRejectedValue(new ApiError(409, "Площадка изменена в другой сессии"));
    const props = setup();
    await screen.findByText("Кластер");
    await userEvent.click(within(row("Стойка")).getByRole("button", { name: "изменить" }));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Площадка изменена в другой сессии, окно перечитано");
    await waitFor(() => expect(deploymentApi.sites).toHaveBeenCalledTimes(2));
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("удаление — через подтверждение с числом объектов", async () => {
    vi.mocked(deploymentApi.deleteSite).mockResolvedValue(undefined);
    const props = setup();
    await screen.findByText("Кластер");
    await userEvent.click(within(row("Кластер")).getByRole("button", { name: "удалить" }));
    expect(screen.getByText("Удалить площадку «Кластер»?")).toBeInTheDocument();
    expect(screen.getByText("Размещение 3 объектов на ней будет снято.")).toBeInTheDocument();
    expect(deploymentApi.deleteSite).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(deploymentApi.deleteSite).toHaveBeenCalledWith("Кластер"));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("площадку с вложенными удалить нельзя — кнопка выключена с подсказкой", async () => {
    setup();
    await screen.findByText("Кластер");
    const del = within(row("Облако")).getByRole("button", { name: "удалить" });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute("title", "Сначала перенесите вложенные площадки");
  });
});
