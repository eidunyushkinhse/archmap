// Чистая часть ручки перевеса (RehangAnchor, Ф5 эпика «стрелки без жёстких хэндлов»):
// какой узел считается новым концом по connection от XYHandle и как ищется узел под
// точкой отпускания (дроп на тело узла внутри рамки, edge.md E1a).
import { describe, it, expect, afterEach } from "vitest";
import { movedEndOf, nodeIdAtPoint } from "../graph/RehangAnchor";

describe("movedEndOf", () => {
  // Тянем target-конец: RF ведёт жест от source и отдаёт {source: неподвижный, target: новый}.
  it("тянули target — новый конец в connection.target", () => {
    expect(movedEndOf({ source: "X", target: "K", sourceHandle: null, targetHandle: null }, "target")).toBe("K");
  });
  it("тянули source — новый конец в connection.source", () => {
    expect(movedEndOf({ source: "K", target: "Y", sourceHandle: null, targetHandle: null }, "source")).toBe("K");
  });
});

describe("nodeIdAtPoint", () => {
  const prev = document.elementFromPoint;
  afterEach(() => {
    document.elementFromPoint = prev;
    document.body.innerHTML = "";
  });

  it("узел холста под точкой — data-id ближайшего .react-flow__node", () => {
    const node = document.createElement("div");
    node.className = "react-flow__node";
    node.setAttribute("data-id", "K");
    const inner = document.createElement("span");
    node.appendChild(inner);
    document.body.appendChild(node);
    document.elementFromPoint = () => inner;
    expect(nodeIdAtPoint(10, 10)).toBe("K");
  });

  it("пустой холст — null", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    document.elementFromPoint = () => pane;
    expect(nodeIdAtPoint(10, 10)).toBeNull();
  });
});
