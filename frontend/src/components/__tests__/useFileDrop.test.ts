// Тесты приёма файлов перетаскиванием (docsImport/useFileDrop.ts).
//
// Хук — обработчики событий, поэтому дёргаем их напрямую поддельным DragEvent:
// jsdom не умеет настоящий drag-and-drop, а вся логика тут в разборе события.
// Закрепляем две вещи, на которых такие зоны обычно и ломаются:
//  1) dragleave стреляет при переходе на ВЛОЖЕННЫЙ элемент зоны — подсветка от
//     этого гаснуть не должна, иначе она мигает под курсором;
//  2) перетаскивание ТЕКСТА зона не перехватывает — иначе перестанет работать
//     обычное перетаскивание текста внутрь textarea.
import { describe, it, expect, vi } from "vitest";
import type { DragEvent } from "react";
import { act, renderHook } from "@testing-library/react";
import { useFileDrop } from "../docsImport/useFileDrop";

/** Файл-заглушка: хук читает только name/size/type. */
function file(name: string, size = 100, type = "application/yaml"): File {
  return { name, size, type } as File;
}

interface FakeOpts {
  types?: string[];
  relatedTarget?: object | null;
  /** Что зона считает своим содержимым (для dragleave). */
  contains?: (n: unknown) => boolean;
}

function dragEvent(files: File[], o: FakeOpts = {}) {
  return {
    dataTransfer: { types: o.types ?? ["Files"], files, dropEffect: "" },
    preventDefault: vi.fn(),
    relatedTarget: o.relatedTarget ?? null,
    currentTarget: { contains: o.contains ?? (() => false) },
  } as unknown as DragEvent<HTMLElement>;
}

const YAML = [".yaml", ".yml"];

describe("useFileDrop", () => {
  it("принимает подходящие файлы и отдаёт их наружу", () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFileDrop({ accept: YAML, onFiles }));

    act(() => result.current.bind.onDrop(dragEvent([file("vote.yaml"), file("worker.yml")])));

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(["vote.yaml", "worker.yml"]);
    expect(result.current.error).toBeNull();
    expect(result.current.over).toBe(false);
  });

  it("не тот формат не принимает и называет причину", () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFileDrop({ accept: YAML, onFiles }));

    act(() => result.current.bind.onDrop(dragEvent([file("схема.png")])));

    expect(onFiles).not.toHaveBeenCalled();
    expect(result.current.error).toContain("схема.png");
    expect(result.current.error).toContain(".yaml");
  });

  it("слишком большой файл отсекает, остальные принимает", () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFileDrop({ accept: YAML, onFiles }));

    act(() =>
      result.current.bind.onDrop(dragEvent([file("big.yaml", 3_000_000), file("ok.yaml")])),
    );

    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(["ok.yaml"]);
    expect(result.current.error).toContain("big.yaml");
    expect(result.current.error).toContain("2 МБ");
  });

  it("папку не принимает и подсказывает, что делать", () => {
    const onFiles = vi.fn();
    // Папка приезжает в dataTransfer файлом без типа, без размера и без расширения.
    const { result } = renderHook(() => useFileDrop({ onFiles }));

    act(() => result.current.bind.onDrop(dragEvent([file("archmap-docs", 0, "")])));

    expect(onFiles).not.toHaveBeenCalled();
    expect(result.current.error).toContain("перетащите файлы");
  });

  it("без списка расширений берёт любой файл", () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFileDrop({ onFiles }));

    act(() => result.current.bind.onDrop(dragEvent([file("схема.mmd")])));

    expect(onFiles.mock.calls[0][0]).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("подсветка не гаснет при переходе на вложенный элемент зоны", () => {
    const { result } = renderHook(() => useFileDrop({ onFiles: vi.fn() }));
    act(() => result.current.bind.onDragOver(dragEvent([])));
    expect(result.current.over).toBe(true);

    const child = { tag: "textarea" };
    act(() => result.current.bind.onDragLeave(dragEvent([], { relatedTarget: child, contains: (n) => n === child })));
    expect(result.current.over).toBe(true);

    // А выход за пределы зоны — гасит.
    act(() => result.current.bind.onDragLeave(dragEvent([], { relatedTarget: { tag: "body" } })));
    expect(result.current.over).toBe(false);
  });

  it("перетаскивание текста зона не перехватывает", () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFileDrop({ onFiles }));
    const e = dragEvent([], { types: ["text/plain"] });

    act(() => result.current.bind.onDragOver(e));
    act(() => result.current.bind.onDrop(e));

    // Ни preventDefault, ни подсветки: текст должен спокойно уехать в textarea.
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(result.current.over).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("выключённая зона не подсвечивается и не принимает", () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useFileDrop({ onFiles, disabled: true }));

    act(() => result.current.bind.onDragOver(dragEvent([])));
    expect(result.current.over).toBe(false);

    act(() => result.current.bind.onDrop(dragEvent([file("vote.yaml")])));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("жалоба гаснет при следующем заходе в зону", () => {
    const { result } = renderHook(() => useFileDrop({ accept: YAML, onFiles: vi.fn() }));
    act(() => result.current.bind.onDrop(dragEvent([file("a.png")])));
    expect(result.current.error).not.toBeNull();

    act(() => result.current.bind.onDragOver(dragEvent([])));

    expect(result.current.error).toBeNull();
  });
});
