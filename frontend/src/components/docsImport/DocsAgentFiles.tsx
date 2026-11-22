// «Ответы агента» в окне «Описать схемы логики с помощью ИИ-агента»: общая зона файлов окон
// ввоза (FileZone) над пакетом файлов useDocsFiles. Здесь только своё у этого окна: текст
// зоны по режиму, какой файл открыт в поле, строки отказа.
//
// Поле текста: вставка текстом открыта всегда (выбранная или последняя), файл с диска — по
// клику на его имя, повторный клик закрывает. Так текст файла можно поправить до
// применения, как в прежней панели, но поле не стоит под зоной, пока о нём не попросили.
import { useState } from "react";
import type { DocsFile } from "../../types";
import { MAX_FILES } from "./useDocsFiles";
import type { DocsAgent } from "./useDocsAgent";
import FileZone from "./FileZone";

const isPaste = (f: DocsFile | undefined): boolean => !!f && !f.name.includes(".");

/** Какая вставка показана в поле: выбранная, иначе последняя; -1 — вставок нет. */
function shownPaste(files: DocsFile[], active: number): number {
  if (isPaste(files[active])) return active;
  for (let i = files.length - 1; i >= 0; i--) if (isPaste(files[i])) return i;
  return -1;
}

export default function DocsAgentFiles({ agent, single, over, dropError }: {
  agent: DocsAgent;
  // «По одной схеме»: агент отдаёт один файл.
  single: boolean;
  // Над окном тащат файлы: зона подсвечена.
  over: boolean;
  // Что из перетащенного не взято и почему.
  dropError: string | null;
}) {
  const { pkg } = agent;
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
      text={single ? "Перетащите сюда файл схемы от агента" : "Перетащите сюда файлы схем от агента"}
      // Расширения не сужаем: состав пакета задаёт агент, схему опознаёт превью.
      accept={[]}
      over={over}
      full={pkg.files.length >= MAX_FILES}
      onFiles={(list) => { setOpened(null); pkg.pickFiles(list); }}
      onPaste={() => { setOpened(null); pkg.addPaste(); }}
      files={pkg.files.map((f, i) => ({ key: f.name, name: f.name, openable: true, active: i === shown }))}
      onOpen={open}
      onRemove={agent.removeFile}
      editor={shown >= 0 ? {
        value: pkg.files[shown].content,
        onChange: (text) => pkg.setText(shown, text),
        label: `Текст ${pkg.files[shown].name}`,
        placeholder: "вставьте содержимое файла",
        autofill: "docs-agent-paste",
      } : null}
      notes={<>
        {dropError && <p className="ds-warn fz-line">{dropError}</p>}
        {pkg.sizeError && <p className="ds-danger fz-line">{pkg.sizeError}</p>}
      </>}
    />
  );
}
