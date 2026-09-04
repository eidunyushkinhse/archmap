// Поле «Якорь» (components/anchor/AnchorField.tsx) — видимость и управляемость
// того, что до Ф1 было скрытой метаданной прогона агента.
//
// Закрепляем ровно то, ради чего поле заведено: три состояния читаются словами
// (в том числе «якоря нет» — с последствием, а не пустотой); ⓘ раскрывает
// принятый пользователем текст целиком (четыре абзаца); нормализация приходит
// С СЕРВЕРА (форма не считает её сама и потому не может обещать не то, что
// сохранится); отказ сервера остаётся под формой, а не уводит её со сцены;
// наблюдатель не видит ни одной кнопки правки.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AnchorField from "../anchor/AnchorField";
import { ANCHOR_HELP } from "../anchor/anchorText";
import { nodesApi } from "../../api/nodes";
import type { NodeSource } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { anchorPreview: vi.fn() },
}));

const preview = vi.mocked(nodesApi.anchorPreview);

function отрисовать(source: NodeSource | null, over: { isArchitect?: boolean } = {}) {
  const onSave = vi.fn<(s: NodeSource | null) => Promise<string | null>>(() => Promise.resolve(null));
  render(<AnchorField source={source} isArchitect={over.isArchitect ?? true} onSave={onSave} />);
  return onSave;
}

const кнопкаПояснения = () => screen.getByRole("button", { name: "Что такое якорь" });

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue({ source: { repo: "github.com/org/repo", path: null, host: null }, kind: "code", key: "git:github.com/org/repo" });
});

describe("AnchorField — чтение", () => {
  it("код показан видом и значением", () => {
    отрисовать({ repo: "github.com/org/mono", path: "services/orders", host: null });
    expect(screen.getByText("код:")).toBeTruthy();
    expect(screen.getByText("github.com/org/mono, путь services/orders")).toBeTruthy();
  });

  it("имя зависимости показано своим видом", () => {
    отрисовать({ repo: null, path: null, host: "payments" });
    expect(screen.getByText("имя зависимости:")).toBeTruthy();
    expect(screen.getByText("payments")).toBeTruthy();
  });

  it("без якоря сказано последствие, а не пустота", () => {
    отрисовать(null);
    expect(screen.getByText("нет — опознаётся по имени")).toBeTruthy();
  });

  it("наблюдателю доступно чтение и ⓘ, но не правка", () => {
    отрисовать({ repo: "github.com/org/repo", path: null, host: null }, { isArchitect: false });
    expect(кнопкаПояснения()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Очистить" })).toBeNull();
  });
});

describe("AnchorField — ⓘ", () => {
  it("раскрывает пояснение целиком: четыре абзаца с подзаголовками", async () => {
    отрисовать(null);
    await userEvent.click(кнопкаПояснения());
    const panel = screen.getByRole("dialog");
    expect(ANCHOR_HELP).toHaveLength(4);
    for (const p of ANCHOR_HELP) {
      expect(panel).toHaveTextContent(p.head);
      // Тело абзаца — целиком, а не первой фразой: текст принят пользователем.
      expect(panel.textContent).toContain(p.body);
    }
  });
});

describe("AnchorField — правка", () => {
  it("нормализацию показывает сервер, а сохраняется вид «код»", async () => {
    const onSave = отрисовать(null);
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "https://github.com/Org/Repo.git");

    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview).toHaveBeenLastCalledWith({ repo: "https://github.com/Org/Repo.git", path: null });
    expect(await screen.findByText("будет сохранено как: github.com/org/repo")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    // На сервер уходит СЫРОЙ ввод: нормализует его сервер, не форма.
    expect(onSave).toHaveBeenCalledWith({ repo: "https://github.com/Org/Repo.git", path: null });
  });

  it("переключение вида сохраняет якорь другого вида", async () => {
    const onSave = отрисовать(null);
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("radio", { name: "Имя зависимости" }));
    await userEvent.type(screen.getByLabelText("Имя"), "kafka");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(onSave).toHaveBeenCalledWith({ host: "kafka" });
  });

  it("отказ сервера остаётся под формой, форма не закрывается", async () => {
    const onSave = vi.fn<(s: NodeSource | null) => Promise<string | null>>(() =>
      Promise.resolve("localhost, 127.0.0.1 и адреса конкретных серверов принадлежат среде"),
    );
    render(<AnchorField source={null} isArchitect onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText(/принадлежат среде/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeTruthy();
  });

  it("«Очистить» снимает якорь", async () => {
    const onSave = отрисовать({ repo: "github.com/org/repo", path: null, host: null });
    await userEvent.click(screen.getByRole("button", { name: "Очистить" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("Отмена возвращает чтение, ничего не сохранив", async () => {
    const onSave = отрисовать({ repo: null, path: null, host: "payments" });
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("payments")).toBeTruthy();
  });

  it("пустая форма обещает очистку и сервер не тревожит", async () => {
    отрисовать(null);
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    expect(screen.getByText("Если якоря не будет, то объект будет опознаваться по имени")).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
  });
});
