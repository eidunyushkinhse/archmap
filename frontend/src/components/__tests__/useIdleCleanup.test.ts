// ТАЙМЕР ФОНОВОЙ УБОРКИ СКОУПНОЙ ГРЯЗИ (спека perf.md P14, хук
// graph/interaction/useIdleCleanup.ts). Здесь — ЧИСТАЯ ЛОГИКА защёлки: когда
// уборка взводится, когда перезаводится, когда снимается и когда её НЕ бывает.
// Сам прогон (вход без sig/сцены/скоупа, записи без применения) — оркестрация LevelGraph,
// проверяется отдельно (routeCache/idleCleanup-интеграция).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useIdleCleanup, CLEANUP_IDLE_MS } from "../graph/interaction/useIdleCleanup";

const SCOPED = { scoped: true, authoritative: false, cleanup: false };
const FULL = { scoped: false, authoritative: true, cleanup: false };
/** прогон без скоупа, но и не авторитетный: пропуск P10 / частичные замеры / ступень P13 */
const NEUTRAL = { scoped: false, authoritative: false, cleanup: false };

function setup(busyAtStart = false) {
  const run = vi.fn();
  const busy = { current: busyAtStart };
  const h = renderHook(() => useIdleCleanup({ run, isBusy: () => busy.current }));
  return { run, busy, ...h };
}

const tick = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms); }); };

describe("useIdleCleanup — фоновая уборка по бездействию (P14)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("скоупный прогон взводит уборку: она уходит по паузе бездействия, ровно один раз", () => {
    const { run, result } = setup();
    result.current.noteRunFinished(SCOPED);
    tick(CLEANUP_IDLE_MS - 1);
    expect(run, "до конца паузы уборки быть не должно").not.toHaveBeenCalled();
    tick(1);
    expect(run).toHaveBeenCalledTimes(1);
    // сама по себе уборка не повторяется: таймер не самозаводится
    tick(CLEANUP_IDLE_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("следующий скоупный прогон ПЕРЕЗАВОДИТ паузу (уборка ждёт тишины)", () => {
    const { run, result } = setup();
    result.current.noteRunFinished(SCOPED);
    tick(CLEANUP_IDLE_MS - 500);
    result.current.noteRunStarted();   // пошёл второй прогон правки
    result.current.noteRunFinished(SCOPED);
    tick(CLEANUP_IDLE_MS - 1);         // от ПЕРВОГО прогона времени прошло больше паузы
    expect(run).not.toHaveBeenCalled();
    tick(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("старт любого прогона снимает взведённую уборку (её переармирует исход)", () => {
    const { run, result } = setup();
    result.current.noteRunFinished(SCOPED);
    result.current.noteRunStarted();
    tick(CLEANUP_IDLE_MS * 2);
    expect(run, "прогон в полёте — уборке не время").not.toHaveBeenCalled();
    // исход этого прогона и решает: полный авторитетный смыл грязь — уборки нет
    result.current.noteRunFinished(FULL);
    tick(CLEANUP_IDLE_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("размонтирование снимает таймер (уборка не переживает холст)", () => {
    const { run, result, unmount } = setup();
    result.current.noteRunFinished(SCOPED);
    unmount();
    tick(CLEANUP_IDLE_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("нескоупный прогон уборку НЕ взводит", () => {
    const { run, result } = setup();
    result.current.noteRunFinished(FULL);
    tick(CLEANUP_IDLE_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("активный жест ОТКЛАДЫВАЕТ уборку, а не отменяет её", () => {
    const { run, busy, result } = setup(true);
    result.current.noteRunFinished(SCOPED);
    tick(CLEANUP_IDLE_MS);
    expect(run, "в драге уборка не стартует").not.toHaveBeenCalled();
    tick(CLEANUP_IDLE_MS);             // жест всё ещё идёт — снова ждём
    expect(run).not.toHaveBeenCalled();
    busy.current = false;              // отпустили
    tick(CLEANUP_IDLE_MS);
    expect(run, "по тишине уборка обязана уйти").toHaveBeenCalledTimes(1);
  });

  it("ОДНА ПОПЫТКА: не ставшая авторитетной уборка по кругу не гоняется", () => {
    const { run, result } = setup();
    result.current.noteRunFinished(SCOPED);
    tick(CLEANUP_IDLE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    // уборочный прогон вернулся со ступенью бюджета / незамеренными узлами
    result.current.noteRunStarted();
    result.current.noteRunFinished({ scoped: false, authoritative: false, cleanup: true });
    tick(CLEANUP_IDLE_MS * 5);
    expect(run, "петля уборки запрещена — грязь ждёт полного пересчёта").toHaveBeenCalledTimes(1);
    // НОВАЯ порция грязи отказ снимает: следующий скоупный прогон снова взводит уборку
    result.current.noteRunStarted();
    result.current.noteRunFinished(SCOPED);
    tick(CLEANUP_IDLE_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("удавшаяся уборка гасит защёлку (авторитетный прогон = грязи нет)", () => {
    const { run, result } = setup();
    result.current.noteRunFinished(SCOPED);
    tick(CLEANUP_IDLE_MS);
    result.current.noteRunStarted();
    result.current.noteRunFinished({ scoped: false, authoritative: true, cleanup: true });
    tick(CLEANUP_IDLE_MS * 5);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("грязь переживает НЕЙТРАЛЬНЫЙ прогон: уборка взводится заново", () => {
    const { run, result } = setup();
    result.current.noteRunFinished(SCOPED);
    result.current.noteRunStarted();
    // пропуск P10 (незамеренная пачка) грязь не смыл и не добавил — уборка всё ещё нужна
    result.current.noteRunFinished(NEUTRAL);
    tick(CLEANUP_IDLE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
