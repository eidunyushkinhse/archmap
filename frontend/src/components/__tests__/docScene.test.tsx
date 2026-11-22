// Единый вид сцены превью (редизайн, фаза 7б): ровный фон окна и пилюля масштаба на
// токенах при чтении и при правке, у схемы логики, спецификации, ER-диаграммы базы и
// просмотра документа в вопросах слияния. Модификатора сцены чтения (doc-pv--read) больше
// нет. jsdom раскладку и стили не считает, поэтому стережём правила docOverlay.css (с
// диска) и то, что разметка всех четырёх мест ставит одни и те же классы.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import FlowchartDoc from "../inspector/FlowchartDoc";
import OpenApiDoc from "../inspector/OpenApiDoc";
import ErDiagramModal from "../ErDiagramModal";
import DocViewer from "../project/remainder/DocViewer";

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "..", "inspector", "docOverlay.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

vi.mock("../../ui/Modal", () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../../api/dataRefs", () => ({ dataRefsApi: { preview: vi.fn(() => Promise.resolve([])) } }));
vi.mock("../MermaidRenderer", () => ({ default: ({ chart }: { chart: string }) => <div data-testid="mmd">{chart}</div> }));
vi.mock("../OpenApiViewer", () => ({ default: () => <div data-testid="swagger" /> }));

// Тело правила по точному селектору.
function rule(selector: string): string {
  const at = css.split("}").find((chunk) => chunk.split("{")[0].trim() === selector);
  return at?.split("{")[1] ?? "";
}

const SPEC = "openapi: 3.0.0\ninfo:\n  title: T\n  version: 1.0.0\npaths: {}\n";

describe("правила сцены", () => {
  it("сцена — ровный фон окна, без точек и без модификатора чтения", () => {
    expect(rule(".doc-pv")).toMatch(/background:\s*var\(--c-bg\)/);
    expect(css).not.toMatch(/radial-gradient/);
    expect(css).not.toMatch(/doc-pv--read/);
  });

  it("пилюля масштаба на токенах, без тяжёлой тени", () => {
    const zoom = rule(".doc-zoom");
    expect(zoom).toMatch(/border:\s*1px solid var\(--c-line\)/);
    expect(zoom).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(zoom).not.toMatch(/rgba\(|#[0-9a-f]{3,6}/i);
    expect(rule(".doc-zval")).toMatch(/font-size:\s*var\(--fs-caption\)/);
  });

  it("спецификация — колонка до 860 px без карточки", () => {
    const card = rule(".doc-oascard");
    expect(card).toMatch(/max-width:\s*860px/);
    expect(card).not.toMatch(/border|box-shadow|background/);
  });
});

describe("разметка сцены одна во всех местах", () => {
  it("схема логики: при правке и при чтении — одна сцена", () => {
    const { unmount } = render(<FlowchartDoc initial="graph TD\n  A" nodeId="n1" isArchitect showCode />);
    expect(document.querySelector(".doc-pv")?.className).toBe("doc-pv");
    expect(document.querySelector(".doc-pv .doc-zoom")).not.toBeNull();
    unmount();
    render(<FlowchartDoc initial="graph TD\n  A" nodeId="n1" isArchitect={false} showCode={false} />);
    expect(document.querySelector(".doc-pv")?.className).toBe("doc-pv");
  });

  it("пустая схема при правке: «Схема пуста» тихим текстом посреди сцены", () => {
    render(<FlowchartDoc initial="" nodeId="n1" isArchitect showCode />);
    expect(screen.getByText("Схема пуста")).toHaveClass("doc-pvempty");
  });

  it("спецификация при правке: та же сцена и колонка, что при чтении", () => {
    render(<OpenApiDoc initial={SPEC} isArchitect showCode />);
    expect(document.querySelector(".doc-pv")?.className).toBe("doc-pv");
    expect(screen.getByTestId("swagger").closest(".doc-oascard")?.parentElement).toHaveClass("doc-pvscroll");
  });

  it("ER-диаграмма и просмотр документа в вопросах слияния — те же классы сцены", () => {
    const { unmount } = render(<ErDiagramModal chart={"erDiagram\n  a {\n  }"} title="Структура: БД заказов" onClose={vi.fn()} />);
    expect(document.querySelector(".doc-pv .doc-pvstage .doc-zoom .doc-zval")).not.toBeNull();
    unmount();
    render(<DocViewer title="Создание заказа" source="Из проекта" tag="mermaid" body="graph TD\n  A" diagram onPick={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector(".doc-pv.rq-ov-stage .doc-pvstage .doc-zoom .doc-zval")).not.toBeNull();
  });
});
