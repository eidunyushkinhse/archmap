// Переключатель вида схемы вкладками-текстом (редизайн; прежнего вида сегментом больше
// нет): выбор «Как есть / Переход / Как будет», активный вид — подчёркнутая вкладка, а
// пояснение вида — в подсказке.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SchemaViewFilter } from "../SchemaViewFilter";
import { VIEW_BY_ID } from "../schemaView";

describe("SchemaViewFilter: вкладки", () => {
  it("три вида вкладками, активный отмечен, клик меняет вид", async () => {
    const onChange = vi.fn();
    render(<SchemaViewFilter view="all" onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Вид схемы" });
    expect(group).toHaveClass("ds-tabs");
    const tabs = screen.getAllByRole("radio");
    expect(tabs.map((t) => t.textContent)).toEqual(["Как есть", "Переход", "Как будет"]);
    const active = screen.getByRole("radio", { name: "Переход" });
    expect(active).toHaveAttribute("aria-checked", "true");
    expect(active).toHaveClass("ds-tab", "is-active");
    expect(screen.getByRole("radio", { name: "Как есть" })).toHaveAttribute("title", VIEW_BY_ID.asis.hint);
    await userEvent.click(screen.getByRole("radio", { name: "Как будет" }));
    expect(onChange).toHaveBeenCalledWith("tobe");
  });
});
