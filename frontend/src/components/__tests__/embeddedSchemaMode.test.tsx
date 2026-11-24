// Режим холста страничной схемы (EmbeddedSchemaBlock → LevelGraph): структура только для
// чтения у обеих ролей, расстановка — тоже у обеих (читателю на время просмотра, задание
// П2); «Переразложить» в углу холста — команда самого холста (mode.relayoutButton,
// history.md U26), хозяину своего сброса не нужно. Холст заглушён:
// здесь проверяются пропсы, которые блок ему отдаёт.
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EmbeddedSchemaBlock from "../EmbeddedSchemaBlock";
import type { LevelPersistenceProps } from "../graph/types";
import type { Node } from "../../types";

const graphProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../LevelGraph", () => ({
  default: (p: Record<string, unknown>) => { graphProps.current = p; return <div data-testid="level-graph" />; },
}));
vi.mock("../SchemaViewFilter", () => ({ SchemaViewFilter: () => null }));

const nodes = [{ id: "n1", name: "Заказы", shape: "service" }] as Node[];

function mount(isArchitect: boolean, persistence?: LevelPersistenceProps) {
  return render(
    <EmbeddedSchemaBlock
      title="Схема" nodes={nodes} endpoints={[]} edges={[]} viewLayout={{}} containerId={null}
      persistence={persistence} ancestorNames={[]} ancestorIds={[]} ancestorElements={[]} depth={0}
      isArchitect={isArchitect} schemaView="all" onSchemaViewChange={vi.fn()} onNavigateNode={vi.fn()}
      showViewFilter={false}
    />,
  );
}

describe("EmbeddedSchemaBlock: режим холста", () => {
  it("архитектор с персистом: расстановка, раскрытия из вида, кнопка «Переразложить» у холста", () => {
    mount(true, { onLayoutChanged: vi.fn() });
    expect(graphProps.current?.mode).toMatchObject({
      readOnly: true, arrangeOnly: true, ignorePersistedExpanded: false, relayoutButton: true,
      fitOnLoad: true, fitOnExpand: true, edgesInspectable: true,
    });
    expect(graphProps.current).not.toHaveProperty("onRelayout");
    expect(graphProps.current).not.toHaveProperty("relayoutToken");
  });

  it("читатель: расстановка без записи (роль решает холст), стартует свёрнутым", () => {
    mount(false, { onLayoutChanged: vi.fn() });
    expect(graphProps.current?.isArchitect).toBe(false);
    expect(graphProps.current?.mode).toMatchObject({
      readOnly: true, arrangeOnly: true, ignorePersistedExpanded: true, relayoutButton: true,
    });
  });
});
