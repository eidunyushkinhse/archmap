// Обратный индекс «используется в процессах» у схемы логики (Ф8 эпика «процессы →
// доки шага», барьер У10). Что закрепляем:
//   • счётчик — СОСЕД строки (split-паттерн), а не вложенная кнопка: клик по нему
//     не открывает схему;
//   • подсписок процессов раскрывается ПО ЗАПРОСУ — на экране по умолчанию нет
//     второго списка процессов рядом с узловой секцией «Участвует в процессах»;
//   • клик по процессу ведёт в него; схема без привязок счётчика не имеет.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import NodeDocsList from "../NodeDocsList";
import type { NodeDocMeta, NodeDocUsage } from "../../types";

const doc = (id: string, name: string): NodeDocMeta =>
  ({ id, name, kind: "operation", operation: null, version: 1, described: true }) as NodeDocMeta;

const ИНДЕКС: NodeDocUsage[] = [
  { doc_id: "d1", process_id: "p1", process_name: "Оплата", steps: 2 },
  { doc_id: "d1", process_id: "p2", process_name: "Возврат", steps: 1 },
];

describe("NodeDocsList: используется в процессах", () => {
  it("счётчик раскрывает подсписок, клик по процессу ведёт в него", async () => {
    const onOpen = vi.fn();
    const onOpenProcess = vi.fn();
    render(
      <NodeDocsList
        docs={[doc("d1", "POST /orders"), doc("d2", "email_senders")]}
        onOpen={onOpen}
        usage={ИНДЕКС}
        onOpenProcess={onOpenProcess}
      />,
    );

    // Подсписка нет, пока не попросили (У10: не дублируем узловую секцию).
    expect(screen.queryByText("Оплата")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "в 2 процессах" }));

    expect(screen.getByText("Оплата")).toBeTruthy();
    // Счётчик — сосед строки: схему он не открывает.
    expect(onOpen).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("Оплата"));

    expect(onOpenProcess).toHaveBeenCalledWith("p1");
  });

  it("схема без привязок счётчика не имеет", () => {
    render(
      <NodeDocsList docs={[doc("d2", "email_senders")]} onOpen={vi.fn()} usage={ИНДЕКС} />,
    );

    expect(screen.queryByRole("button", { name: /процесс/ })).toBeNull();
  });
});
