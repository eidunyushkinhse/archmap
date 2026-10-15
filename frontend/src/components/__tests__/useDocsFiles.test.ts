// Тесты общего состояния файлов BYOA-модалок (docsImport/useDocsFiles.ts).
//
// Главный закрепляемый инвариант — ловушка, на которой окно синка потеряло
// возможность вставки (найдено ручной проверкой 2026-08-08): «Вставить текст»
// заводит ПУСТОЙ файл, поэтому files.length растёт, а hasContent остаётся false.
// Отсюда правило для разметки: редактор показывается по files.length, а отчёт
// (превью/план) — по hasContent. Кто перепутает — снова получит чип без поля.
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDocsFiles } from "../docsImport/useDocsFiles";

describe("useDocsFiles", () => {
  it("«Вставить текст» заводит пустой файл: он есть, но содержимого нет", () => {
    const { result } = renderHook(() => useDocsFiles());

    act(() => result.current.addPaste());

    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].content).toBe("");
    // Именно здесь и была ловушка: редактор под hasContent не показался бы.
    expect(result.current.hasContent).toBe(false);
    expect(result.current.nonEmpty).toEqual([]);
  });

  it("после ввода текста файл становится содержательным", () => {
    const { result } = renderHook(() => useDocsFiles());
    act(() => result.current.addPaste());

    act(() => result.current.setText(0, "nodes: []"));

    expect(result.current.hasContent).toBe(true);
    expect(result.current.nonEmpty).toHaveLength(1);
  });

  it("вставки нумеруются, имена не конфликтуют", () => {
    const { result } = renderHook(() => useDocsFiles());

    act(() => result.current.addPaste());
    act(() => result.current.addPaste());

    expect(result.current.files.map((f) => f.name)).toEqual(["вставка-1", "вставка-2"]);
  });

  it("файл с тем же именем замещает прежний, а не плодит дубль", () => {
    const { result } = renderHook(() => useDocsFiles());

    act(() => result.current.addFiles([{ name: "run.yaml", content: "первый" }]));
    act(() => result.current.addFiles([{ name: "run.yaml", content: "второй" }]));

    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].content).toBe("второй");
  });

  it("активный файл прижат к границам списка после удаления", () => {
    const { result } = renderHook(() => useDocsFiles());
    act(() => result.current.addFiles([
      { name: "a.yaml", content: "a" },
      { name: "b.yaml", content: "b" },
    ]));
    act(() => result.current.setActive(1));

    act(() => result.current.removeFile(1));

    expect(result.current.files).toHaveLength(1);
    expect(result.current.active).toBe(0);
  });

  // Аудит F-50: активный выставлялся вызовом setState изнутри апдейтера списка; теперь
  // файлы и активный — одно состояние, и добавление делает активным последний файл.
  it("добавленный файл становится активным, удаление до активного его сдвигает", () => {
    const { result } = renderHook(() => useDocsFiles());
    act(() => result.current.addFiles([
      { name: "a", content: "1" }, { name: "b", content: "2" }, { name: "c", content: "3" },
    ]));
    expect(result.current.active).toBe(2);
    act(() => result.current.removeFile(0));
    expect(result.current.files.map((f) => f.name)).toEqual(["b", "c"]);
    expect(result.current.active).toBe(1);
  });

  // Аудит F-31: кнопкой «Загрузить файлы…» файл больше 2 МБ принимался и падал уже на
  // сервере — перетаскивание же его отбивало сразу.
  it("файл больше предела документа не читается, причина — в sizeError", () => {
    const { result } = renderHook(() => useDocsFiles());
    const big = { name: "огромный.mmd", size: 3 * 1024 * 1024, text: async () => "x" } as unknown as File;
    act(() => result.current.pickFiles([big]));
    expect(result.current.sizeError).toBe("Слишком большой файл: огромный.mmd (больше 2 МБ).");
    expect(result.current.files.some((f) => f.name === "огромный.mmd")).toBe(false);
  });
});

