// Окно «Площадки»: дерево площадок (SiteTree — общее с окном «Размещение»): шеврон у
// каждой строки, свёрнуто по умолчанию, «+» под вложенными и под корнями заводит
// площадку с тем родителем; архитектору — карандаш (CAS, чужая правка перечитывает
// окно) и корзина с подтверждением (с вложенными — нельзя); читателю — только просмотр.
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
const expand = (name: string) => userEvent.click(screen.getByRole("button", { name: `Развернуть «${name}»` }));

describe("SitesDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deploymentApi.sites).mockResolvedValue(SITES);
  });

  it("дерево свёрнуто: вложенные видны после шеврона; счётчика объектов в строке нет", async () => {
    setup();
    expect(await screen.findByText("Облако")).toBeInTheDocument();
    expect(screen.queryByText("Кластер")).toBeNull();
    expect(screen.queryByText(/объект/)).toBeNull();
    await expand("Облако");
    expect(screen.getByText("Кластер")).toBeInTheDocument();
    // технология — серым рядом с именем
    expect(within(row("Облако")).getByText("AWS")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Свернуть «Облако»" }));
    expect(screen.queryByText("Кластер")).toBeNull();
  });

  it("читателю — без правки: ни значков, ни «+», шеврон только у площадки с вложенными", async () => {
    setup(false);
    await screen.findByText("Облако");
    expect(screen.queryByRole("button", { name: /Изменить площадку/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Удалить площадку/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Добавить площадку/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Развернуть «Облако»" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Развернуть «Стойка»" })).toBeNull();
  });

  it("«+» под корнями: форма без поля родителя → createSite с parent_id null → окно перечитано", async () => {
    vi.mocked(deploymentApi.createSite).mockResolvedValue(site("ВМ-1"));
    const props = setup();
    await screen.findByText("Облако");
    await userEvent.click(screen.getByRole("button", { name: "Добавить площадку" }));
    expect(screen.queryByRole("combobox", { name: "Внутри площадки" })).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: "Имя" }), "ВМ-1");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Вид" }), "vm");
    await userEvent.type(screen.getByRole("textbox", { name: "Технология" }), "Ubuntu 24.04");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(deploymentApi.createSite).toHaveBeenCalledWith({
      name: "ВМ-1", kind: "vm", technology: "Ubuntu 24.04", description: null, parent_id: null,
    }));
    expect(props.onChanged).toHaveBeenCalled();
    await waitFor(() => expect(deploymentApi.sites).toHaveBeenCalledTimes(2));
    // форма закрылась, «+» снова на месте
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Имя" })).toBeNull());
    expect(screen.getByRole("button", { name: "Добавить площадку" })).toBeInTheDocument();
  });

  it("«+» под вложенными площадки (и у площадки без вложенных) — родитель та площадка", async () => {
    vi.mocked(deploymentApi.createSite).mockResolvedValue(site("Узел"));
    setup();
    await screen.findByText("Облако");
    await expand("Стойка");
    await userEvent.click(screen.getByRole("button", { name: "Добавить площадку внутри «Стойка»" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Имя" }), "Узел");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(deploymentApi.createSite).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Узел", parent_id: "Стойка" }),
    ));
  });

  it("отказ при создании (предел демо) — строкой в окне, форма остаётся", async () => {
    vi.mocked(deploymentApi.createSite).mockRejectedValue(
      new ApiError(409, "Демо-проект поддерживает до 20 площадок.", "demo_limit"),
    );
    setup();
    await screen.findByText("Облако");
    await userEvent.click(screen.getByRole("button", { name: "Добавить площадку" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Имя" }), "Ещё одна");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Не получилось добавить площадку. Демо-проект поддерживает до 20 площадок.");
    expect(screen.getByRole("textbox", { name: "Имя" })).toHaveValue("Ещё одна");
  });

  it("правка с CAS: base_version — версия площадки; родителем нельзя выбрать саму и вложенные", async () => {
    vi.mocked(deploymentApi.updateSite).mockResolvedValue(site("Облако"));
    const props = setup();
    await screen.findByText("Облако");
    await userEvent.click(within(row("Облако")).getByRole("button", { name: "Изменить площадку «Облако»" }));
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

  it("перенос под другого родителя раскрывает его: площадка не пропадает из виду", async () => {
    const moved = site("Стойка", { kind: "physical", parent_id: "Облако", instance_count: 1 });
    vi.mocked(deploymentApi.updateSite).mockResolvedValue(moved);
    vi.mocked(deploymentApi.sites).mockResolvedValueOnce(SITES).mockResolvedValue([SITES[0], SITES[1], moved]);
    setup();
    await screen.findByText("Облако");
    await userEvent.click(within(row("Стойка")).getByRole("button", { name: "Изменить площадку «Стойка»" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Внутри площадки" }), "Облако");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(deploymentApi.sites).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Кластер")).toBeInTheDocument();
    expect(screen.getByText("Стойка")).toBeInTheDocument();
  });

  it("правка, а площадку уже изменили в другой сессии: сообщение и перечитанное окно", async () => {
    vi.mocked(deploymentApi.updateSite).mockRejectedValue(new ApiError(409, "Площадка изменена в другой сессии"));
    const props = setup();
    await screen.findByText("Облако");
    await userEvent.click(within(row("Стойка")).getByRole("button", { name: "Изменить площадку «Стойка»" }));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Площадка изменена в другой сессии, окно перечитано");
    await waitFor(() => expect(deploymentApi.sites).toHaveBeenCalledTimes(2));
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("удаление — через подтверждение с числом объектов", async () => {
    vi.mocked(deploymentApi.deleteSite).mockResolvedValue(undefined);
    const props = setup();
    await screen.findByText("Облако");
    await expand("Облако");
    await userEvent.click(within(row("Кластер")).getByRole("button", { name: "Удалить площадку «Кластер»" }));
    expect(screen.getByText("Удалить площадку «Кластер»?")).toBeInTheDocument();
    expect(screen.getByText("Размещение 3 объектов на ней будет снято.")).toBeInTheDocument();
    expect(deploymentApi.deleteSite).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(deploymentApi.deleteSite).toHaveBeenCalledWith("Кластер"));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("площадку с вложенными удалить нельзя — корзина выключена с подсказкой", async () => {
    setup();
    await screen.findByText("Облако");
    const del = within(row("Облако")).getByRole("button", { name: "Удалить площадку «Облако»" });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute("title", "Сначала перенесите вложенные площадки");
  });
});
