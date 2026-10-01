// Гейт маршрутов проекта: роль в проекте (my_role) грузится ДО страниц и раздаётся
// контекстом — право правки стабильно с первого рендера страницы.
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ProjectAccessGate from "../ProjectAccessGate";
import { canEditProject, useProjectRole } from "../projectRole";
import { projectsApi } from "../../api/projects";
import type { Project } from "../../types";

vi.mock("../../api/projects", () => ({ projectsApi: { get: vi.fn() } }));

function Probe() {
  const role = useProjectRole();
  return <div data-testid="probe">{`${role ?? "нет"}:${canEditProject(role) ? "правит" : "смотрит"}`}</div>;
}

const карточка = (my_role: Project["my_role"]) => ({ id: "p1", my_role }) as Project;

describe("ProjectAccessGate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("до ответа страницы не рендерятся, после — получают роль", async () => {
    vi.mocked(projectsApi.get).mockResolvedValue(карточка("editor"));
    render(<ProjectAccessGate projectId="p1"><Probe /></ProjectAccessGate>);
    expect(screen.queryByTestId("probe")).not.toBeInTheDocument();
    expect(await screen.findByText("editor:правит")).toBeInTheDocument();
    expect(projectsApi.get).toHaveBeenCalledWith("p1");
  });

  it("читатель только смотрит", async () => {
    vi.mocked(projectsApi.get).mockResolvedValue(карточка("reader"));
    render(<ProjectAccessGate projectId="p1"><Probe /></ProjectAccessGate>);
    expect(await screen.findByText("reader:смотрит")).toBeInTheDocument();
  });

  it("карточка не загрузилась: страницы рендерятся только на чтение", async () => {
    vi.mocked(projectsApi.get).mockRejectedValue(new Error("Проект не найден"));
    render(<ProjectAccessGate projectId="p1"><Probe /></ProjectAccessGate>);
    expect(await screen.findByText("нет:смотрит")).toBeInTheDocument();
  });

  it("вне гейта роли нет: только чтение", () => {
    render(<Probe />);
    expect(screen.getByText("нет:смотрит")).toBeInTheDocument();
  });
});
