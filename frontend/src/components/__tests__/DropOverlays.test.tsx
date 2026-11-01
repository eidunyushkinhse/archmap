// Подсказки броска плитки палитры (приёмка Ф12 2026-10-31, canvas.md CV20c): цель броска
// проверяет тип. Тип невозможен на уровне — принимающие его раскрытые рамки залиты зелёным
// на всё время драга, над прочими местами превью запретное; без сведений — как до приёмки.
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import DropOverlays from "../graph/DropOverlays";
import type { DropFrame } from "../graph/interaction/useTemplateDrop";
import type { DropEligible } from "../graph/types";

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const orders: DropFrame = { id: "orders", depth: 1, rect: { x: 0, y: 0, w: 400, h: 300 } };
const auth: DropFrame = { id: "auth", depth: 1, rect: { x: 600, y: 0, w: 400, h: 300 } };
const billing: DropFrame = { id: "billing", depth: 1, rect: { x: 1200, y: 0, w: 400, h: 300 } };
const frames = [orders, auth, billing];
// Компонент на уровне системы: принимают только рамки контейнеров orders и auth.
const component: DropEligible = { levelOk: false, frameIds: new Set(["orders", "auth"]) };
const preview = (x: number, y: number) => ({ shape: "service" as const, x, y });

function overlays(props: Partial<Parameters<typeof DropOverlays>[0]>) {
  const { container } = render(
    <DropOverlays preview={null} targetFrame={null} emptyFrame={undefined} frames={frames}
      eligible={null} dragging {...props} />,
  );
  const invites = Object.fromEntries([...container.querySelectorAll<HTMLElement>("[data-drop-invite]")]
    .map((el) => [el.dataset.frameId, el.dataset.dropInvite]));
  const previewState = container.querySelector<HTMLElement>("[data-drop-preview]")?.dataset.dropPreview;
  const stroke = container.querySelector("[data-drop-preview] path, [data-drop-preview] rect")?.getAttribute("stroke");
  return { container, invites, previewState, stroke };
}

describe("DropOverlays: цель броска проверяет тип", () => {
  it("тип невозможен на уровне — принимающие рамки зелёные с начала драга, прочие нет", () => {
    const { invites } = overlays({ eligible: component });
    expect(invites).toEqual({ orders: "idle", auth: "idle" });
  });

  it("центр будущего узла в принимающей рамке — она заметнее, превью обычное", () => {
    const { invites, previewState, stroke, container } = overlays({
      eligible: component, preview: preview(100, 100), targetFrame: orders,
    });
    expect(invites).toEqual({ orders: "hit", auth: "idle" });
    expect(previewState).toBe("ok");
    expect(stroke).toBe("#475569");
    // индиго-подсветки цели нет: её роль играет зелёная рамка
    expect(container.querySelector("[data-drop-target]")).toBeNull();
  });

  it("мимо рамок или над рамкой, которая тип не принимает, — превью запретное", () => {
    const level = overlays({ eligible: component, preview: preview(1000, 1000) });
    expect(level.previewState).toBe("forbidden");
    expect(level.stroke).toBe("#ef4444");
    const wrongFrame = overlays({ eligible: component, preview: preview(1300, 100), targetFrame: billing });
    expect(wrongFrame.previewState).toBe("forbidden");
    expect(wrongFrame.invites).toEqual({ orders: "idle", auth: "idle" });
  });

  it("тип возможен на уровне — рамки не красятся, принимающая цель под курсором — индиго", () => {
    const db: DropEligible = { levelOk: true, frameIds: new Set(["billing"]) };
    const ok = overlays({ eligible: db, preview: preview(1300, 100), targetFrame: billing });
    expect(ok.invites).toEqual({});
    expect(ok.previewState).toBe("ok");
    expect(ok.container.querySelector("[data-drop-target]")?.getAttribute("data-drop-target")).toBe("billing");
    // база данных над рамкой контейнера — запрет, индиго нет
    const refused = overlays({ eligible: db, preview: preview(100, 100), targetFrame: orders });
    expect(refused.previewState).toBe("forbidden");
    expect(refused.container.querySelector("[data-drop-target]")).toBeNull();
  });

  it("без сведений о целях — как до приёмки: зелёных рамок нет, превью обычное", () => {
    const { invites, previewState } = overlays({ eligible: null, preview: preview(1300, 100), targetFrame: billing });
    expect(invites).toEqual({});
    expect(previewState).toBe("ok");
  });

  it("тип невозможен на уровне — приглашения пустого слоя нет", () => {
    const empty = { x: -30, y: -30, w: 250, h: 190 };
    const refused = overlays({ eligible: component, preview: preview(0, 0), emptyFrame: empty });
    expect(refused.container.querySelector("[data-empty-frame-hint]")).toBeNull();
    const allowed = overlays({ eligible: { levelOk: true, frameIds: new Set() }, preview: preview(0, 0), emptyFrame: empty });
    expect(allowed.container.querySelector("[data-empty-frame-hint]")?.getAttribute("data-empty-frame-hint")).toBe("hit");
  });

  it("драга нет — зелёных рамок нет", () => {
    expect(overlays({ eligible: component, dragging: false }).invites).toEqual({});
  });
});
