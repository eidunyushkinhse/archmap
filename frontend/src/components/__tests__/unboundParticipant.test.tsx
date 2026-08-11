// Непривязанный участник: узла в схеме у него нет (пришёл импортом или потерял узел
// при удалении). Он виден на диаграмме в «сломанном» стиле — как повисшая стрелка —
// и несёт путь исправления прямо на шапке: без него алерт был бы тупиком.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SequenceDiagram from "../processes/SequenceDiagram";
import type { SeqMessage, SeqParticipant } from "../processes/sequence/layout";

// Привязанный участник: узел есть, свойства узла на месте.
const bound = (id: string, name: string): SeqParticipant => ({
  id, nodeId: "node-" + id, name, role: "сервис",
  shape: "service", external: false, status: "existing",
});
// Непривязанный: узла нет, свойств узла нет — подставлять их нельзя.
const unbound = (id: string, name: string): SeqParticipant => ({
  id, nodeId: null, name, role: null, shape: null, external: false, status: null,
});

const M = (id: string, r: number, from: string, to: string): SeqMessage =>
  ({ id, r, n: r + 1, from, to, kind: "forward", label: id, tech: null, valid: false }) as SeqMessage;

function renderDiagram(over: {
  participants?: SeqParticipant[];
  onBindParticipant?: (participantId: string) => void;
} = {}) {
  const participants = over.participants ?? [bound("a", "Клиент"), unbound("u", "Биллинг")];
  return render(
    <SequenceDiagram
      participants={participants}
      messages={[M("m0", 0, participants[0].id, participants[1].id)]}
      ghost
      onBindParticipant={over.onBindParticipant}
    />,
  );
}

const bindBtns = () =>
  screen.queryAllByRole("button", { name: "привязать" });

describe("непривязанный участник", () => {
  it("его шапка предлагает привязку", () => {
    renderDiagram({ onBindParticipant: vi.fn() });
    expect(bindBtns()).toHaveLength(1); // только у непривязанного, у второго узел есть
  });

  it("привязанному привязка не предлагается", () => {
    renderDiagram({ participants: [bound("a", "Клиент"), bound("b", "Заказы")], onBindParticipant: vi.fn() });
    expect(bindBtns()).toHaveLength(0);
  });

  it("без обработчика (просмотр) кнопки нет", () => {
    renderDiagram();
    expect(bindBtns()).toHaveLength(0);
  });

  it("нажатие отдаёт id УЧАСТНИКА, а не узла", () => {
    // Ключ дорожки — участник: у непривязанного узла нет вовсе, а двое таких по
    // node_id были бы неразличимы.
    const onBind = vi.fn();
    renderDiagram({ onBindParticipant: onBind });

    fireEvent.click(bindBtns()[0]);

    expect(onBind).toHaveBeenCalledWith("u");
  });

  it("на шапке сказано, что узла нет", () => {
    renderDiagram({ onBindParticipant: vi.fn() });
    expect(screen.getByText("нет узла в схеме")).toBeTruthy();
  });

  it("линия жизни непривязанного нарисована «сломанным» цветом", () => {
    // Тот же янтарный, что у повисшей стрелки: расхождение со схемой выглядит
    // одинаково, где бы ни встретилось.
    const { container } = renderDiagram({ onBindParticipant: vi.fn() });
    const lifelines = Array.from(container.querySelectorAll("line")).filter(
      (l) => l.getAttribute("stroke-dasharray") === "5 5",
    );
    const colors = lifelines.map((l) => l.getAttribute("stroke"));

    expect(colors).toContain("#d97706"); // BROKEN.ln — непривязанный
    expect(colors).toContain("#94a3b8"); // обычный existing — привязанный
  });
});
