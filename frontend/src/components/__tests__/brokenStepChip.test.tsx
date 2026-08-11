// Чип сломанного шага говорит, ЧЕМ он сломан.
//
// Поломки две, и чинятся они по-разному: связь удалили из схемы (шаг повис,
// «Восстановить связи» умеет вернуть ему канал) либо канал стал асинхронным и
// потерял плечо «ответ» (связь на месте, подхватывать нечего). Один текст на оба
// случая врал бы в половине из них.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SequenceDiagram from "../processes/SequenceDiagram";
import { toSeqMessages } from "../processes/sequence/fromDetail";
import type { ProcessMessage } from "../../types";
import type { SeqMessage, SeqParticipant } from "../processes/sequence/layout";

const P = (id: string): SeqParticipant =>
  ({ id, name: id.toUpperCase(), shape: "service", external: false, status: "existing", role: null }) as SeqParticipant;

const M = (over: Partial<SeqMessage>): SeqMessage =>
  ({ id: "m0", r: 0, n: 1, from: "a", to: "b", kind: "return", label: "ответ",
     tech: null, valid: true, invalidReason: null, ...over }) as SeqMessage;

const diagram = (m: SeqMessage) =>
  render(<SequenceDiagram participants={[P("a"), P("b")]} messages={[m]} ghost />);

describe("чип сломанного шага", () => {
  it("удалённая связь названа удалённой", () => {
    diagram(M({ valid: false, invalidReason: "edge_deleted" }));

    expect(screen.getByText("связь удалена")).toBeTruthy();
  });

  it("пропавшее плечо названо своим именем, а не «связь удалена»", () => {
    diagram(M({ valid: false, invalidReason: "leg_gone" }));

    expect(screen.getByText("канал без ответа")).toBeTruthy();
    expect(screen.queryByText("связь удалена")).toBeNull();
  });

  it("у целого шага чипа нет", () => {
    diagram(M({}));

    expect(screen.queryByText("связь удалена")).toBeNull();
    expect(screen.queryByText("канал без ответа")).toBeNull();
  });

  it("причина доезжает из контракта в презентационную модель", () => {
    // Иначе диаграмма получала бы undefined и молча показывала «связь удалена».
    const out = toSeqMessages([
      { id: "m1", order: 0, edge_id: "e1", leg: "return", kind: "return", caption: "ответ",
        technology: null, from_participant_id: "pb", to_participant_id: "pa",
        valid: false, invalid_reason: "leg_gone" } as unknown as ProcessMessage,
    ]);

    expect(out[0].invalidReason).toBe("leg_gone");
  });
});
