// Перенос в таблицах языка (редизайн, фаза 13в). Ячейка ds-table переносит только по словам:
// короткие значения (статус, «да», тип, дата) не рвутся посреди слова. Ячейка с длинным
// значением без пробелов (ds-td-long) переносится в любом месте и не растягивает колонку:
// логин на «Пользователях», значение со «словом» от 40 знаков в таблице версий. jsdom
// раскладку не считает: правила читаем текстом, классы проверяем в разметке.
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import VersionViewBlock from "../nodePage/versions/VersionViewBlock";
import type { VersionView } from "../../types";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function rule(text: string, selector: string): string {
  const at = text.split("}").find((chunk) => chunk.split("{")[0].trim() === selector);
  return at?.split("{")[1] ?? "";
}

const ADDRESS = "postgresql://orders:secret@db-primary.internal:5432/orders?sslmode=require";

describe("перенос в ds-table", () => {
  it("ячейка — по словам, длинная — в любом месте; своего правила у таблицы версий нет", () => {
    const ds = css("ui", "ds.css");
    expect(rule(ds, ".ds-table td")).toContain("overflow-wrap: break-word");
    expect(rule(ds, ".ds-table td.ds-td-long")).toContain("overflow-wrap: anywhere");
    expect(css("components", "nodePage", "versions", "versions.css")).not.toMatch(/\.ds-table td\s*\{/);
  });

  it("таблица версий: длинное значение — ds-td-long, короткие — без него; «было → стало» тоже", () => {
    const view: VersionView = {
      text: null, lines: null,
      columns: ["Параметр", "Тип", "Обязательный", "По умолчанию", "Описание"],
      rows: [
        { mark: "add", cells: ["DATABASE_URL", "string", "да", ADDRESS, "Адрес базы заказов"], changed: [] },
        // Короткий адрес (меньше 40 знаков) переносится по словам, как прежде.
        { mark: "", cells: ["CACHE_URL", "string", "нет", "redis://cache.internal:6379/0", "Кэш корзин"], changed: [] },
        { mark: "mod", cells: ["ORDER_TTL_H", "int", "нет", "24", "Срок жизни заказа"],
          changed: [{ index: 3, was: "48", now: ADDRESS }] },
      ],
    };
    const { container } = render(<VersionViewBlock view={view} />);
    const rows = [...container.querySelectorAll("tbody tr")];
    const longCells = (tr: Element) =>
      [...tr.querySelectorAll("td")].map((td, i) => (td.classList.contains("ds-td-long") ? i : -1)).filter((i) => i >= 0);
    // Первая колонка — метка строки, поэтому значение «По умолчанию» — ячейка 4.
    expect(longCells(rows[0])).toEqual([4]);
    expect(longCells(rows[1])).toEqual([]);
    expect(longCells(rows[2])).toEqual([4]);
  });
});
