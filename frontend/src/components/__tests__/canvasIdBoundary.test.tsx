// Граница слоёв в ProcessCanvas: диаграмма говорит УЧАСТНИКАМИ, а композитор,
// направления и каналы — узлами C4. Перевод делает канвас.
//
// Регрессия 2026-08-10 (нашёл пользователь): после переезда идентичности линии жизни
// с узла на участника колбэки продолжали ждать node_id. Композитор получал id
// участников, каналов по ним не находилось — и окно всегда показывало «между ними нет
// задокументированной связи», а вместо имён — сырые id. Тестов на эту проводку не было
// вовсе, поэтому гейт смолчал.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import type { ProcessDetail } from "../../types";

// Диаграмма подменена пультом: каждая кнопка дёргает свой колбэк ИМЕННО id участника —
// так же, как настоящая после смены идентичности.
vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: {
    onConnect?: (a: string, b: string) => void;
    canConnect?: (a: string, b: string) => boolean;
    onSelfConnect?: (id: string) => void;
    onDeleteParticipant?: (id: string) => void;
  }) => (
    <div>
      <button onClick={() => props.onConnect?.("pa", "pb")}>connect</button>
      <button onClick={() => props.onConnect?.("pa", "pu")}>connect-unbound</button>
      <button onClick={() => props.onSelfConnect?.("pu")}>self-unbound</button>
      <button onClick={() => props.onDeleteParticipant?.("pa")}>del-pa</button>
      <span data-testid="can">{String(props.canConnect?.("pa", "pb"))}</span>
      <span data-testid="can-unbound">{String(props.canConnect?.("pa", "pu"))}</span>
    </div>
  ),
}));
// Композитор отражает полученные пропсы: он живёт в слое C4 и обязан получить УЗЛЫ.
vi.mock("../MessageComposer", () => ({
  default: (props: { fromNode: string; toNode: string }) => (
    <div data-testid="composer">{props.fromNode}|{props.toNode}</div>
  ),
}));
vi.mock("../processes/ParticipantPicker", () => ({ default: () => null }));
vi.mock("../../api/processes", () => ({
  processesApi: { get: vi.fn(), directions: vi.fn(), addMessage: vi.fn(), removeParticipant: vi.fn(), reattach: vi.fn(), detachMessages: vi.fn() },
}));
vi.mock("../../api/nodes", () => ({ nodesApi: { get: vi.fn() } }));

const DETAIL = {
  id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
  participants: [
    { id: "pa", node_id: "na", name: "Покупатель", role: null, shape: "service",
      is_external: false, status: "existing", order: 0 },
    { id: "pb", node_id: "nb", name: "Заказы", role: null, shape: "service",
      is_external: false, status: "existing", order: 1 },
    { id: "pu", node_id: null, name: "Биллинг", role: null, shape: null,
      is_external: null, status: null, order: 2 },
  ],
  messages: [],
  fragments: [],
} as unknown as ProcessDetail;

function renderCanvas() {
  render(<ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
  return screen.findByText("connect");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  // Направления бэк отдаёт УЗЛАМИ — как и каналы.
  vi.mocked(processesApi.directions).mockResolvedValue([
    { from_id: "na", to_id: "nb" },
  ] as never);
  vi.mocked(processesApi.addMessage).mockResolvedValue({ id: "m1" } as never);
});

describe("ProcessCanvas: перевод участников в узлы на границе слоёв", () => {
  it("композитор получает УЗЛЫ, а не участников", async () => {
    await renderCanvas();

    await userEvent.click(screen.getByText("connect"));

    expect((await screen.findByTestId("composer")).textContent).toBe("na|nb");
  });

  it("с непривязанным участником композитор не открывается", async () => {
    // Узла у него нет, значит нет и каналов — открывать окно не на чем.
    await renderCanvas();

    await userEvent.click(screen.getByText("connect-unbound"));

    expect(screen.queryByTestId("composer")).toBeNull();
  });

  it("проверка направления переводит участников в узлы", async () => {
    await renderCanvas();

    await waitFor(() => expect(screen.getByTestId("can").textContent).toBe("true"));
  });

  it("к непривязанному направление невозможно", async () => {
    await renderCanvas();

    expect(screen.getByTestId("can-unbound").textContent).toBe("false");
  });

  it("самосообщение адресуется УЧАСТНИКОМ и работает у непривязанного", async () => {
    // Связи C4 у внутренней операции нет — узел ей не нужен вовсе.
    await renderCanvas();

    await userEvent.click(screen.getByText("self-unbound"));
    await userEvent.click(await screen.findByRole("button", { name: "Добавить" }));

    await waitFor(() =>
      expect(processesApi.addMessage).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ from_participant_id: "pu", to_participant_id: "pu" }),
      ),
    );
  });

  it("удаление участника находит его по id участника", async () => {
    await renderCanvas();

    await userEvent.click(screen.getByText("del-pa"));

    // У участника нет сообщений — удаляется сразу, без окна подтверждения.
    await waitFor(() => expect(processesApi.removeParticipant).toHaveBeenCalledWith("p1", "pa"));
  });
});

// ── Восстановление связей по процессу ───────────────────────────────────────────────
// Кейс с живых данных: пользователь импортировал процесс, увидел повисший ответ,
// сделал канал синхронным (у асинхронного нет плеча «ответ») — и шаг остался
// сломанным, потому что процесс о правке схемы не узнаёт.
const withDangling = {
  ...DETAIL,
  messages: [
    { id: "m1", order: 0, edge_id: null, leg: "return", kind: "return", caption: "ответ",
      technology: null, from_participant_id: "pb", to_participant_id: "pa",
      valid: false, invalid_reason: "edge_deleted" },
    // Самосообщение: связи C4 у него и не было, поэтому бэк помечает его valid=true —
    // в счётчик оно не попадает по контракту, а не по отдельной проверке.
    { id: "m2", order: 1, edge_id: null, leg: "forward", kind: "self", caption: "проверка",
      technology: null, from_participant_id: "pa", to_participant_id: "pa", valid: true },
  ],
} as unknown as ProcessDetail;

// Шаг, потерявший ПЛЕЧО: связь на месте, но канал стал асинхронным — «ответа» у него
// больше нет. Сломан, но подхватывать нечего: кнопка его чинить не умеет (AL28).
const withOrphanLeg = {
  ...DETAIL,
  messages: [
    { id: "m3", order: 0, edge_id: "e1", leg: "return", kind: "return", caption: "ответ",
      technology: null, from_participant_id: "pb", to_participant_id: "pa",
      valid: false, invalid_reason: "leg_gone" },
  ],
} as unknown as ProcessDetail;

const reattachBtn = () => screen.queryByRole("button", { name: /Восстановить связи/ });

describe("ProcessCanvas: подхват каналов", () => {
  it("кнопки нет, когда чинить нечего", async () => {
    await renderCanvas();
    expect(reattachBtn()).toBeNull();
  });

  it("кнопка считает шаги без связи, не считая самосообщений", async () => {
    vi.mocked(processesApi.get).mockResolvedValue(withDangling);
    await renderCanvas();

    expect((await screen.findByRole("button", { name: /Восстановить связи/ })).textContent)
      .toContain("(1)");
  });

  it("шаг с пропавшим плечом кнопку НЕ зажигает", async () => {
    // Он сломан, но связь у него на месте — подхватывать нечего. Попади он в счётчик,
    // кнопка обещала бы починку, которой не умеет (чинится возвратом синхронности
    // канала либо удалением шага).
    vi.mocked(processesApi.get).mockResolvedValue(withOrphanLeg);
    await renderCanvas();

    expect(reattachBtn()).toBeNull();
  });

  it("нажатие прогоняет процесс и показывает итог", async () => {
    vi.mocked(processesApi.get).mockResolvedValue(withDangling);
    vi.mocked(processesApi.reattach).mockResolvedValue(
      { attached: 1, dangling: 0, attached_ids: ["m1"] } as never,
    );
    await renderCanvas();

    await userEvent.click(await screen.findByRole("button", { name: /Восстановить связи/ }));

    await waitFor(() => expect(processesApi.reattach).toHaveBeenCalledWith("p1"));
    await screen.findByText("Восстановлено связей: 1");
  });

  it("когда каналов не нашлось — говорим почему, а не молчим", async () => {
    vi.mocked(processesApi.get).mockResolvedValue(withDangling);
    vi.mocked(processesApi.reattach).mockResolvedValue(
      { attached: 0, dangling: 1, attached_ids: [] } as never,
    );
    await renderCanvas();

    await userEvent.click(await screen.findByRole("button", { name: /Восстановить связи/ }));

    await screen.findByText(/подходящих несколько/);
  });
});
