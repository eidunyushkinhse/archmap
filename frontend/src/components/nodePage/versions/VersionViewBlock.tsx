// Одно представление элемента дельты версий («Изменения», «Было» или «Стало»). Форма
// ровно одна (контракт VersionView): lines — построчная дельта текста, text — полный
// текст на стороне, columns + rows — таблица (свойства, связи, факты, шаги процесса).
// Все четыре null — элемента на этой стороне нет («было» у добавленного).
//
// Ячейка «было → стало» рисуется по частям из row.changed (зачёркнутое «было» и
// «стало»), а не разбором текста: стрелка могла стоять и в самом значении.
import type { ReactNode } from "react";
import type { DiffMark, VersionView } from "../../../types";
import "./versions.css";

// Строка построчной дельты: класс цвета и знак слева, как в unified diff. mod в тексте —
// заголовок куска «@@ …» или смена свойства схемы, у него свой цвет и без знака.
const LINE: Record<DiffMark, { cls: string; sign: string }> = {
  "": { cls: "ctx", sign: " " },
  add: { cls: "add", sign: "+" },
  del: { cls: "del", sign: "-" },
  mod: { cls: "hunk", sign: "" },
  move: { cls: "ctx", sign: " " },
};

// Метка строки таблицы: «+» новая, «−» удалена, «~» изменена (ячейка «было → стало»),
// «порядок» — только переставлена.
const TAG: Record<Exclude<DiffMark, "">, { cls: string; text: string }> = {
  add: { cls: "add", text: "+" },
  del: { cls: "del", text: "−" },
  mod: { cls: "mod", text: "~" },
  move: { cls: "mod", text: "порядок" },
};

type Row = NonNullable<VersionView["rows"]>[number];

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
    if (view.rows.length === 0) return <p className="vp-empty">Пусто</p>;
    // Колонка меток — только когда есть что помечать: в «было» и «стало» метки пусты.
    const marked = view.rows.some((r) => r.mark !== "");
    return (
      <div className="vp-scrollx">
        <table className="vp-table">
          <thead>
            <tr>
              {marked && <th aria-label="Изменение" />}
              {view.columns.map((c, i) => <th key={i}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, i) => (
              <tr key={i}>
                {marked && (
                  <td>
                    {row.mark !== "" && (
                      <span className={`vp-tag vp-tag--${TAG[row.mark].cls}`}>{TAG[row.mark].text}</span>
                    )}
                  </td>
                )}
                {rowCells(row).map((cell, j) => <td key={j}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <p className="vp-empty">На этой стороне элемента нет</p>;
}
