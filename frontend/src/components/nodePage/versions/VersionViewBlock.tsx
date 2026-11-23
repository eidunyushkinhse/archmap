// Одно представление элемента дельты версий («Изменения», «Было» или «Стало»). Форма
// ровно одна (контракт VersionView): lines — построчная дельта текста, text — полный
// текст на стороне, columns + rows — таблица (свойства, связи, факты, шаги процесса).
// Все четыре null — элемента на этой стороне нет («было» у добавленного).
//
// Вид (редизайн, фаза 9ж): дельта и полный текст — моноширинные блоки в рамке со своей
// прокруткой вбок, таблица — тихая ds-table в обёртке со своей прокруткой вбок; метка
// строки таблицы — словом-знаком цвета изменения, без пилюли.
//
// Ячейка «было → стало» рисуется по частям из row.changed (зачёркнутое «было» и
// «стало»), а не разбором текста: стрелка могла стоять и в самом значении.
import type { ReactNode } from "react";
import type { DiffMark, VersionView } from "../../../types";
import "../../../ui/ds.css";
import "./versions.css";

// Строка построчной дельты: класс цвета и знак слева, как в unified diff. mod в тексте —
// заголовок куска «@@ …» или смена свойства схемы: тихим цветом и без знака.
const LINE: Record<DiffMark, { cls: string; sign: string }> = {
  "": { cls: "ctx", sign: " " },
  add: { cls: "add", sign: "+" },
  del: { cls: "del", sign: "-" },
  mod: { cls: "hunk", sign: "" },
  move: { cls: "ctx", sign: " " },
};

// Метка строки таблицы: «+» новая (цветом добавления), «−» удалена (цветом опасности),
// «~» изменена (ячейка «было → стало») и «порядок» — только переставлена (тихим цветом).
const TAG: Record<Exclude<DiffMark, "">, { cls: string; text: string }> = {
  add: { cls: "add", text: "+" },
  del: { cls: "del", text: "−" },
  mod: { cls: "mod", text: "~" },
  move: { cls: "mod", text: "порядок" },
};

type Row = NonNullable<VersionView["rows"]>[number];

// Значение со «словом» от 40 знаков без пробелов (длинный адрес базы, ссылка, ключ): его
// ячейка переносится в любом месте (ds-td-long, ui/ds.css) и своей длины колонке не
// навязывает, иначе таблица шире окна, а соседние колонки сжаты. Прочие значения (тип,
// «да», имя параметра, короткий адрес) рвутся только по словам (редизайн, фаза 13в).
const LONG_RUN = /\S{40}/;
function cellClass(row: Row, j: number): string | undefined {
  const change = row.changed.find((c) => c.index === j);
  const texts = change ? [change.was, change.now] : [row.cells[j] ?? ""];
  return texts.some((t) => LONG_RUN.test(t)) ? "ds-td-long" : undefined;
}

// Ячейки строки таблицы: у отличающейся от другой стороны — «было» зачёркнуто, «стало»
// рядом; прочие — текстом как есть.
function rowCells(row: Row): ReactNode[] {
  const changed = new Map(row.changed.map((c) => [c.index, c]));
  return row.cells.map((cell, j) => {
    const change = changed.get(j);
    if (!change) return cell;
    return <><s className="vp-was">{change.was}</s> → <span className="vp-now">{change.now}</span></>;
  });
}

export default function VersionViewBlock({ view }: { view: VersionView }) {
  if (view.lines !== null) {
    return (
      <div className="vp-diff">
        <div className="vp-diff-in">
          {view.lines.map((line, i) => (
            <div key={i} className={`vp-l vp-l--${LINE[line.mark].cls}`}>
              {LINE[line.mark].sign}{line.text}
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (view.text !== null) {
    return <pre className="vp-code">{view.text}</pre>;
  }
  if (view.columns !== null && view.rows !== null) {
    if (view.rows.length === 0) return <p className="ds-empty vp-flat">Пусто</p>;
    // Колонка меток — только когда есть что помечать: в «было» и «стало» метки пусты.
    const marked = view.rows.some((r) => r.mark !== "");
    return (
      <div className="vp-scrollx">
        <table className="ds-table">
          <thead>
            <tr>
              {marked && <th className="vp-mark-col" aria-label="Изменение" />}
              {view.columns.map((c, i) => <th key={i}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, i) => (
              <tr key={i}>
                {marked && (
                  <td className="vp-mark-col">
                    {row.mark !== "" && (
                      <span className={`vp-tag vp-tag--${TAG[row.mark].cls}`}>{TAG[row.mark].text}</span>
                    )}
                  </td>
                )}
                {rowCells(row).map((cell, j) => <td key={j} className={cellClass(row, j)}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <p className="ds-empty vp-flat">На этой стороне элемента нет</p>;
}
