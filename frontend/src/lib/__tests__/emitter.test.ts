import { describe, it, expect, vi } from "vitest";
import { createEmitter } from "../emitter";

describe("createEmitter", () => {
  it("будит всех подписчиков значением; отписка снимает только своего", () => {
    const bus = createEmitter<number>();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on(a);
    bus.on(b);
    bus.emit(1);
    offA();
    bus.emit(2);
    expect(a.mock.calls).toEqual([[1]]);
    expect(b.mock.calls).toEqual([[1], [2]]);
  });

  it("без значения — сигнал; подписчик, отписавшийся посреди emit, больше не зовётся", () => {
    const bus = createEmitter();
    const late = vi.fn();
    let offLate = (): void => {};
    bus.on(() => { offLate(); });
    offLate = bus.on(late);
    bus.emit();
    bus.emit();
    expect(late).not.toHaveBeenCalled();
  });

  it("повторная подписка того же слушателя — один вызов", () => {
    const bus = createEmitter();
    const listener = vi.fn();
    bus.on(listener);
    bus.on(listener);
    bus.emit();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
