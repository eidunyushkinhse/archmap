// Гвард «вход не изменился» — общий для пяти BYOA-панелей (agentModalShared).
//
// Находка полевой приёмки: агент в трёх кругах замечаний подряд отчитывался
// «Исправление: добавлена связь…», не тронув файл; пользователь трижды нёс в ArchMap
// байт-в-байт тот же документ и трижды получал то же замечание. Здесь закрепляется
// то, чем гвард отличается от бесполезного счётчика: сравнивается СОДЕРЖИМОЕ, а
// заходом считается новый вход пользователя, а не любой рендер.
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { inputFingerprint, useRepeatedInput } from "../docsImport/agentModalShared";

describe("отпечаток входа", () => {
  it("различает содержимое при том же числе файлов и тех же именах", () => {
    const было = [{ name: "a.mmd", content: "flowchart TD" }];
    const стало = [{ name: "a.mmd", content: "flowchart LR" }];
    expect(inputFingerprint(было)).not.toBe(inputFingerprint(стало));
    // …и совпадает, когда содержимое действительно то же самое.
    expect(inputFingerprint(было)).toBe(inputFingerprint([{ name: "a.mmd", content: "flowchart TD" }]));
  });

  it("границу файлов не размывает: «ab» + «» ≠ «a» + «b»", () => {
    expect(inputFingerprint(["ab", ""])).not.toBe(inputFingerprint(["a", "b"]));
  });
});

describe("гвард повторного входа", () => {
  // Хук получает вход по ссылке: новый массив = пользователь снова принёс файлы.
  function прогон(входы: string[][]) {
    const { result, rerender } = renderHook(
      ({ docs }: { docs: string[] }) => useRepeatedInput(docs, inputFingerprint(docs)),
      { initialProps: { docs: входы[0] } },
    );
    const вердикты = [result.current];
    for (const docs of входы.slice(1)) {
      rerender({ docs });
      вердикты.push(result.current);
    }
    return вердикты;
  }

  it("тот же вход вторым и третьим заходом — повтор", () => {
    expect(прогон([["nodes: a"], ["nodes: a"], ["nodes: a"]])).toEqual([false, true, true]);
  });

  it("изменившийся вход гвард снимает", () => {
    expect(прогон([["nodes: a"], ["nodes: a"], ["nodes: b"]])).toEqual([false, true, false]);
  });

  it("повторный рендер с тем же массивом заходом не считается", () => {
    const docs = ["nodes: a"];
    // Один и тот же объект: превью могло переспроситься от тумблера, но пользователь
    // ничего не приносил — обвинять агента не в чем.
    expect(прогон([docs, docs, docs])).toEqual([false, false, false]);
  });

  it("пустая панель историю сбрасывает", () => {
    // Убрали файлы («Убрать из панели») → принесли тот же документ снова: сравнивать
    // не с чем, как и у соседнего гварда диффа попыток.
    expect(прогон([["nodes: a"], [""], ["nodes: a"]])).toEqual([false, false, false]);
  });
});
