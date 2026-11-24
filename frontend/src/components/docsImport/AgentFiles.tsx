// «Ответы агента» в окнах дозаливки от агента на новом языке (схемы логики, факты, список
// операций): общая зона файлов окон ввоза (FileZone) над пакетом файлов useDocsFiles. Здесь
// только своё у пакета агента: какой файл открыт в поле, строки отказа под зоной. Текст зоны
// и ключ имени поля задаёт окно.
//
// Поле текста: вставка текстом открыта всегда (выбранная или последняя), файл с диска — по
// клику на его имя, повторный клик закрывает. Так текст файла можно поправить до
// применения, как в прежних окнах, но поле не стоит под зоной, пока о нём не попросили.
import { useState } from "react";
import type { DocsFile } from "../../types";
import { MAX_FILES } from "./useDocsFiles";
import type { DocsFilesApi } from "./useDocsFiles";
import FileZone from "./FileZone";

const isPaste = (f: DocsFile | undefined): boolean => !!f && !f.name.includes(".");

/** Какая вставка показана в поле: выбранная, иначе последняя; -1 — вставок нет. */
function shownPaste(files: DocsFile[], active: number): number {
  if (isPaste(files[active])) return active;
  for (let i = files.length - 1; i >= 0; i--) if (isPaste(files[i])) return i;
  return -1;
}

export default function AgentFiles({ pkg, text, over, dropError, onRemove, autofill }: {
  pkg: DocsFilesApi;
  /** Строка в зоне: что сюда класть. */
  text: string;
  /** Над окном тащат файлы: зона подсвечена. */
  over: boolean;
  /** Что из перетащенного не взято и почему. */
  dropError: string | null;
  /** Снять файл (у окна своя уборка отчёта вместе с последним файлом). */
  onRemove: (i: number) => void;
  /** Ключ имени поля текста для noAutofill: свой у каждого окна. */
  autofill: string;
}) {
  // Имя файла с диска, открытого кликом; null — в поле вставка (если есть).
  const [opened, setOpened] = useState<string | null>(null);
  const openedAt = opened === null ? -1 : pkg.files.findIndex((f) => f.name === opened);
  const shown = openedAt >= 0 ? openedAt : shownPaste(pkg.files, pkg.active);

  function open(i: number) {
    const f = pkg.files[i];
    if (i === shown && !isPaste(f)) {
      setOpened(null);
      return;
    }
    setOpened(f.name);
    pkg.setActive(i);
  }

  return (
    <FileZone
      text={text}
      // Расширения не сужаем: состав пакета задаёт агент, файл опознаёт превью.
      accept={[]}
      over={over}
      full={pkg.files.length >= MAX_FILES}
      onFiles={(list) => { setOpened(null); pkg.pickFiles(list); }}
      onPaste={() => { setOpened(null); pkg.addPaste(); }}
      files={pkg.files.map((f, i) => ({ key: f.name, name: f.name, openable: true, active: i === shown }))}
      onOpen={open}
      onRemove={onRemove}
      editor={shown >= 0 ? {
        value: pkg.files[shown].content,
        onChange: (t) => pkg.setText(shown, t),
        label: `Текст ${pkg.files[shown].name}`,
        placeholder: "вставьте содержимое файла",
        autofill,
      } : null}
      notes={<>
        {dropError && <p className="ds-warn fz-line">{dropError}</p>}
        {pkg.sizeError && <p className="ds-danger fz-line">{pkg.sizeError}</p>}
      </>}
    />
  );
}
