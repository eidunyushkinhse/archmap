// Когда показывать управление статусами («Вид схемы», «Принять переход»).
//
// Правило родилось из находки 2026-08-09: признак считался по составу ТЕКУЩЕГО
// уровня, и архитектор, пометивший узел выводимым внутри контейнера, не находил
// переключатель ни в редакторе, ни на странице — он стоял уровнем выше.
import { describe, expect, it } from "vitest";
import { showStatusControls } from "../schemaView";
import type { NodeStatus } from "../../types";

const at = (...statuses: NodeStatus[]) => statuses.map((status) => ({ status }));

describe("showStatusControls", () => {
  it("показывает, когда статусы лежат ГЛУБЖЕ текущего уровня", () => {
    // Ровно сценарий находки: на уровне всё existing, признак проекта — true.
    expect(showStatusControls(true, at("existing", "existing"))).toBe(true);
  });

  it("молчит в проекте без перехода", () => {
    expect(showStatusControls(false, at("existing"), at("existing"))).toBe(false);
  });

  it("реагирует на правку статуса до перезагрузки уровня", () => {
    // Правка узла в редакторе меняет только локальный стейт: серверный признак
    // ещё false, а переключатель нужен сразу.
    expect(showStatusControls(false, at("existing", "deprecated"))).toBe(true);
  });

  it("учитывает гостей уровня наравне с локальными узлами", () => {
    expect(showStatusControls(false, at("existing"), at("planned"))).toBe(true);
  });
});
