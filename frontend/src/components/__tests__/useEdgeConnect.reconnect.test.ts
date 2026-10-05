// Регресс «перевес связи открывает окно «Новая связь»» (приёмка тура демо, 2026-10-05).
//
// React Flow ведёт перепривязку конца-в-рамку (edge.md E1a) тем же протягиванием, что
// и новую связь, и зовёт для неё ОБЩИЕ onConnectStart/onConnectEnd (вместо onConnect —
// onReconnect). Порядок вызовов здесь повторяет @xyflow/system (XYHandle.onPointerDown +
// EdgeUpdateAnchors): onReconnectStart → onConnectStart … onReconnect → onConnectEnd →
// onReconnectEnd. Отпускание перевеса на теле узла не должно создавать связь.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Connection } from "@xyflow/react";
import { useEdgeConnect } from "../graph/interaction/useEdgeConnect";

// Узел холста под курсором: elementFromPoint в jsdom нет — подставляем свой.
function nodeUnderCursor(id: string): () => void {
  const el = document.createElement("div");
  el.className = "react-flow__node";
  el.setAttribute("data-id", id);
  document.body.appendChild(el);
  const prev = document.elementFromPoint;
  document.elementFromPoint = () => el;
  return () => {
    document.elementFromPoint = prev;
    el.remove();
  };
}

const mouseUp = () => new MouseEvent("mouseup", { clientX: 10, clientY: 10 });

function setup() {
  const onCreate = vi.fn();
  const onInto = vi.fn();
  const onExitUp = vi.fn();
  const { result } = renderHook(() => useEdgeConnect({
    isArchitect: true, disabled: false,
    resolveTarget: () => ({ kind: "direct" }),
    onCreate, onInto, onExitUp,
  }));
  return { result, onCreate, onInto, onExitUp };
}

describe("useEdgeConnect — перевес конца не создаёт новую связь", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it("перевес, отпущенный на теле узла: ни «Новой связи», ни выбора потомка", () => {
    cleanup = nodeUnderCursor("K");
    const { result, onCreate, onInto, onExitUp } = setup();
    // тянут конец, упёршийся в рамку; RF передаёт неподвижный конец X как «откуда»
    act(() => {
      result.current.handleReconnectStart();
      result.current.handleConnectStart(null, { nodeId: "X", handleId: "X--right--0", handleType: "source" });
    });
    expect(result.current.connecting).toBe(false); // поток новой связи не взведён
    act(() => {
      result.current.handleConnectEnd(mouseUp());
      result.current.handleReconnectEnd();
    });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onInto).not.toHaveBeenCalled();
    expect(onExitUp).not.toHaveBeenCalled();
  });

  it("после перевеса обычное протягивание снова создаёт связь", () => {
    cleanup = nodeUnderCursor("K");
    const { result, onCreate } = setup();
    act(() => {
      result.current.handleReconnectStart();
      result.current.handleConnectStart(null, { nodeId: "X", handleId: null, handleType: "source" });
      result.current.handleConnectEnd(mouseUp());
      result.current.handleReconnectEnd();
    });
    act(() => {
      result.current.handleConnectStart(null, { nodeId: "X", handleId: "X--right--0", handleType: "source" });
    });
    expect(result.current.connecting).toBe(true);
    act(() => { result.current.handleConnectEnd(mouseUp()); });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith("X", "K", "X--right--0", null);
  });

  it("новая связь на хэндл по-прежнему создаётся ровно один раз", () => {
    cleanup = nodeUnderCursor("K");
    const { result, onCreate } = setup();
    const conn: Connection = { source: "X", target: "K", sourceHandle: "X--right--0", targetHandle: "K--left--0" };
    act(() => {
      result.current.handleConnectStart(null, { nodeId: "X", handleId: "X--right--0", handleType: "source" });
      result.current.handleConnect(conn);
      result.current.handleConnectEnd(mouseUp());
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith("X", "K", "X--right--0", "K--left--0");
  });
});
