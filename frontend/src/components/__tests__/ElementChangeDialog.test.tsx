// Окно последствий смены элемента архитектуры и переноса (Р18): шесть видов текстов
// прототипа v2, секции «Площадки» и «Документация» — только когда им есть что показать.
// Решение «нужно ли окно» (hasConsequences) — чистая функция рядом.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { ElementChangePreview } from "../../types";
import ElementChangeDialog from "../element/ElementChangeDialog";
import { hasConsequences, joinNames } from "../element/elementChange";

const row = (name: string, sites: string[]) => ({ node_id: `id-${name}`, name, sites });

function preview(over: Partial<ElementChangePreview>): ElementChangePreview {
  return { kind: "none", before: [], after: [], docs_names: [], container_name: null, ...over };
}

function show(p: ElementChangePreview, name: string) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ElementChangeDialog preview={p} nodeName={name} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
}

describe("окно последствий", () => {
  it("система → контейнер: таблица было → стало, пояснение, документация компонентов", () => {
    const { onConfirm, onCancel } = show(preview({
      kind: "system_to_container",
      before: [row("api", ["prod-eu", "prod-ru"]), row("scheduler", ["prod-eu"])],
      after: [row("orders", ["prod-eu", "prod-ru"])],
      docs_names: ["api", "scheduler"],
    }), "orders");
    expect(screen.getByText("Сделать «orders» контейнером?")).toBeInTheDocument();
    expect(screen.getByText("Объекты внутри станут частями «orders» и перестанут считаться отдельными приложениями.")).toBeInTheDocument();
    expect(screen.getByText("Площадки")).toBeInTheDocument();
    expect(screen.getAllByText("prod-eu")).toHaveLength(3);
    expect(screen.getByText("«orders» займёт все площадки, где сейчас стоят его части.")).toBeInTheDocument();
    expect(screen.getByText("Документация")).toBeInTheDocument();
    expect(screen.getByText(
      "У api и scheduler есть своя документация. Она останется на месте: ArchMap отметит это "
      + "подсказкой, а на странице «orders» будет кнопка, чтобы перенести её одним нажатием.",
    )).toBeInTheDocument();
    fireEvent.click(screen.getByText("Сделать контейнером"));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Отмена"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("контейнер → система: площадки получает каждый, документация самого узла", () => {
    show(preview({
      kind: "container_to_system",
      before: [row("orders", ["prod-eu"])],
      after: [row("api", ["prod-eu"]), row("scheduler", ["prod-eu"])],
      docs_names: ["orders"],
    }), "orders");
    expect(screen.getByText("Сделать «orders» системой?")).toBeInTheDocument();
    expect(screen.getByText("Объекты внутри станут отдельными приложениями, каждое со своими площадками и документацией.")).toBeInTheDocument();
    expect(screen.getByText("Каждый получит площадки «orders». Лишние можно убрать на холсте «Развёртывание».")).toBeInTheDocument();
    expect(screen.getByText(
      "Документация самого «orders» останется у него. ArchMap отметит это подсказкой, а на "
      + "странице «orders» будет кнопка, чтобы раздать её объектам внутри.",
    )).toBeInTheDocument();
    expect(screen.getByText("Сделать системой")).toBeInTheDocument();
  });

  it("перенос в контейнер: одна документация, кнопка «Перенести»", () => {
    show(preview({
      kind: "join_container",
      before: [row("orders", ["prod-eu"]), row("api", ["prod-ru"])],
      after: [row("orders", ["prod-eu", "prod-ru"])],
      docs_names: ["api"],
      container_name: "orders",
    }), "api");
    expect(screen.getByText("Сделать «api» частью «orders»?")).toBeInTheDocument();
    expect(screen.getByText("«api» станет компонентом контейнера «orders» и перестанет считаться отдельным приложением.")).toBeInTheDocument();
    expect(screen.getByText("«orders» займёт и площадки «api».")).toBeInTheDocument();
    expect(screen.getByText(/^У api есть своя документация\. Она останется на месте/)).toBeInTheDocument();
    expect(screen.getByText("Перенести")).toBeInTheDocument();
  });

  it("перенос из контейнера: без секции документации", () => {
    show(preview({
      kind: "leave_container",
      before: [row("orders", ["prod-eu"])],
      after: [row("orders", ["prod-eu"]), row("api", ["prod-eu"])],
      container_name: "orders",
    }), "api");
    expect(screen.getByText("Сделать «api» отдельным приложением?")).toBeInTheDocument();
    expect(screen.getByText("«api» перестанет быть частью «orders» и получит свои площадки.")).toBeInTheDocument();
    expect(screen.getByText("«api» получит площадки «orders». Лишние можно убрать на холсте «Развёртывание».")).toBeInTheDocument();
    expect(screen.queryByText("Документация")).not.toBeInTheDocument();
  });

  it("перенос в лист с площадками: лист станет системой, площадки — вложенным", () => {
    const { onConfirm } = show(preview({
      kind: "first_child",
      before: [row("orders", ["prod-eu", "prod-ru"])],
      after: [row("api", ["prod-eu", "prod-ru"])],
      container_name: "orders",
    }), "api");
    expect(screen.getByText("Перенести «api» в «orders»?")).toBeInTheDocument();
    expect(screen.getByText("«orders» станет системой из вложенных объектов, и его площадки перейдут к ним.")).toBeInTheDocument();
    expect(screen.getByText("Площадки")).toBeInTheDocument();
    expect(screen.getByText("«api» получит площадки «orders». Лишние можно убрать на холсте «Развёртывание».")).toBeInTheDocument();
    expect(screen.queryByText("Документация")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Перенести"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("лист становится пустой системой: площадки ждут первого вложенного контейнера", () => {
    show(preview({
      kind: "empty_system",
      before: [row("orders", ["prod-eu"])],
      after: [],
      docs_names: ["orders"],
    }), "orders");
    expect(screen.getByText("Сделать «orders» системой?")).toBeInTheDocument();
    expect(screen.getByText("Система сама не запускается: площадки и документацию ведут объекты внутри неё.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Площадки до" })).toBeInTheDocument();
    // Площадки отдать некому — строки «после» и стрелки нет.
    expect(screen.queryByRole("list", { name: "Площадки после" })).not.toBeInTheDocument();
    expect(screen.getByText("Площадки «orders» перейдут первому вложенному контейнеру.")).toBeInTheDocument();
    expect(screen.getByText(/^Документация самого «orders» останется у него/)).toBeInTheDocument();
    expect(screen.getByText("Сделать системой")).toBeInTheDocument();
    expect(hasConsequences(preview({ kind: "empty_system", before: [row("orders", ["prod-eu"])] }))).toBe(true);
    expect(hasConsequences(preview({ kind: "empty_system" }))).toBe(false);
  });

  it("площадки не переезжают — секции «Площадки» нет, документация есть", () => {
    show(preview({ kind: "container_to_system", docs_names: ["orders"] }), "orders");
    expect(screen.queryByText("Площадки")).not.toBeInTheDocument();
    expect(screen.getByText("Документация")).toBeInTheDocument();
  });
});

describe("нужно ли окно", () => {
  it("последствий нет: none, одинаковые строки без документации", () => {
    expect(hasConsequences(preview({}))).toBe(false);
    expect(hasConsequences(preview({
      kind: "join_container", before: [row("orders", ["prod-eu"])], after: [row("orders", ["prod-eu"])],
    }))).toBe(false);
  });
  it("последствия есть: площадки переезжают или документация останется не на месте", () => {
    expect(hasConsequences(preview({ kind: "system_to_container", before: [row("api", ["prod-eu"])] }))).toBe(true);
    expect(hasConsequences(preview({ kind: "container_to_system", docs_names: ["orders"] }))).toBe(true);
  });
  it("имена через запятую, последнее — через «и»", () => {
    expect(joinNames(["api"])).toBe("api");
    expect(joinNames(["api", "scheduler"])).toBe("api и scheduler");
    expect(joinNames(["api", "checkout", "scheduler"])).toBe("api, checkout и scheduler");
  });
});
