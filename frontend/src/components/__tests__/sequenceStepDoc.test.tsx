// Шаг процесса и его схема логики в просмотре; подпись шага — компактная.
//
// В просмотре шаг, к которому привязана схема логики, открывает её кликом (стрелка или
// подпись); шаг без схемы не кликается вовсе — курсор-рука на нём обещала бы то, чего
// нет. В правке клик по любому шагу открывает его карточку, как прежде.
// Подпись: номер, type-глиф и технология — одной колонкой слева, текст — справа на всю
// оставшуюся ширину (между соседними участниками иначе слова рвались посередине).
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SequenceDiagram from "../processes/SequenceDiagram";
import { toSeqMessages } from "../processes/sequence/fromDetail";
import type { ProcessMessage } from "../../types";
import type { SeqMessage, SeqParticipant } from "../processes/sequence/layout";

const P = (id: string): SeqParticipant =>
  ({ id, name: id.toUpperCase(), shape: "service", external: false, status: "existing", role: null }) as SeqParticipant;

const M = (over: Partial<SeqMessage>): SeqMessage =>
  ({ id: "m0", r: 0, n: 1, from: "a", to: "b", kind: "forward", label: "создать заказ",
     tech: "REST", valid: true, invalidReason: null, ...over }) as SeqMessage;

const WITH_DOC = M({ id: "m1", label: "создать заказ", doc: "POST /orders" });
const NO_DOC = M({ id: "m2", r: 1, n: 2, label: "вернуть номер", doc: null });
const label = (id: string) => document.querySelector<HTMLElement>(`[data-mid="${id}"]`)!;

describe("шаг процесса в просмотре: схема логики", () => {
  it("шаг со схемой открывает её кликом по подписи и по стрелке; без схемы — не кликается", () => {
    const onOpenDoc = vi.fn();
    const { container } = render(
      <SequenceDiagram participants={[P("a"), P("b")]} messages={[WITH_DOC, NO_DOC]} onOpenDoc={onOpenDoc} />,
    );
    expect(label("m1").style.cursor).toBe("pointer");
    expect(label("m1")).toHaveAttribute("title", "Схема логики «POST /orders»");
    fireEvent.click(label("m1"));
    expect(onOpenDoc).toHaveBeenCalledWith("m1");
    // невидимая полоса поверх стрелки — та же цель клика
    const strips = container.querySelectorAll("line[stroke='transparent']");
    expect(strips).toHaveLength(1);
    fireEvent.click(strips[0]);
    expect(onOpenDoc).toHaveBeenCalledTimes(2);
    // шаг без схемы — ни руки, ни клика, ни полосы
    expect(label("m2").style.pointerEvents).toBe("none");
    expect(label("m2")).not.toHaveAttribute("title");
    fireEvent.click(label("m2"));
    expect(onOpenDoc).toHaveBeenCalledTimes(2);
  });

  it("в правке клик по любому шагу открывает его карточку, ссылкой подпись не выделяется", () => {
    const onMessageClick = vi.fn();
    render(
      <SequenceDiagram
        participants={[P("a"), P("b")]} messages={[WITH_DOC, NO_DOC]} onMessageClick={onMessageClick} onOpenDoc={vi.fn()}
      />,
    );
    fireEvent.click(label("m2"));
    expect(onMessageClick).toHaveBeenCalledWith("m2");
    expect(label("m1")).not.toHaveAttribute("title");
  });

  it("схема шага доезжает из контракта: только когда известны и схема, и её узел", () => {
    const base = {
      edge_id: "e1", leg: "forward", kind: "forward", caption: "x", technology: null,
      from_participant_id: "pa", to_participant_id: "pb", valid: true, invalid_reason: null,
    };
    const out = toSeqMessages([
      { ...base, id: "m1", order: 0, doc_id: "d1", doc_node_id: "nb", doc_name: "POST /orders" },
      { ...base, id: "m2", order: 1, doc_id: "d2", doc_node_id: null, doc_name: "сирота" },
      { ...base, id: "m3", order: 2, doc_id: null, doc_node_id: null, doc_name: null },
    ] as unknown as ProcessMessage[]);
    expect(out.map((m) => m.doc)).toEqual(["POST /orders", null, null]);
  });
});

describe("подпись шага", () => {
  it("номер и технология — одним блоком слева, текст его обтекает", () => {
    render(<SequenceDiagram participants={[P("a"), P("b")]} messages={[WITH_DOC]} />);
    const wrap = label("m1").firstElementChild as HTMLElement;
    // обёртка держит высоту обтекаемого блока — подпись не наезжает на стрелку
    expect(wrap.style.display).toBe("flow-root");
    const [meta, text] = Array.from(wrap.children) as HTMLElement[];
    expect(meta.style.float).toBe("left");
    expect(meta.style.flexDirection).toBe("column");
    expect(meta.textContent).toBe("1REST");
    expect(text.textContent).toBe("создать заказ");
  });
});
