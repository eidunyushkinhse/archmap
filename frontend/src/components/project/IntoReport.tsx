// Дифф превью и отчёт применения окна «Догрузить архив» на новом языке (редизайн, фаза 6г).
// Слова прежние; склейки частей через «·» нет: части строки идут через запятую, основание
// находки и пометка «без источника» тихим цветом после пути (как строка плана «Обновить из
// кода»). Состояние — useImportInto, окно — ImportIntoModal.
import { useState } from "react";
import type { IntoApplyOut, IntoPreviewOut } from "../../types";
import { plural } from "../../ui/plural";
import { anchorKind, basisLabel } from "../anchor/anchorText";
import { FactLines, ReportTail } from "./ImportReportParts";
import { familyLine } from "./useImportInto";
import "../../ui/ds.css";
import "./importInto.css";

// Сколько путей видно сразу; остальное открывает «и ещё N».
const PATHS_SHOWN = 8;

const objects = (n: number) => `${n} ${plural(n, ["объект", "объекта", "объектов"])}`;

// Дифф превью: числа тут про то, что ПОЯВИТСЯ, а не про содержимое архивов.
export function IntoDiff({ preview }: { preview: IntoPreviewOut }) {
  const families = familyLine(preview.families);
  return (
    <div className="ii-diff">
      <p className="ii-new">
        Нового: {objects(preview.nodes_new)}, {preview.edges_new}{" "}
        {plural(preview.edges_new, ["связь", "связи", "связей"])}
      </p>
      {families && <p className="ii-line ii-quiet">Добавится: {families}</p>}
      {/* Догрузка сопоставляет узлы ИСТОЧНИКОМ, и самое спорное её решение («это тот же
          объект») названо вслух, вместе с основанием каждой находки. */}
      {preview.nodes_matched > 0 && (
        <PathList
          title={`Найдено в проекте: ${objects(preview.nodes_matched)}`}
          total={preview.nodes_matched}
          rows={preview.matched_nodes.map((m) => ({ path: m.path, note: `: ${basisLabel(m.basis, m.path)}` }))}
        />
      )}
      {preview.new_nodes.length > 0 && (
        <PathList
          title="Появятся:"
          total={preview.nodes_new}
          // Без источника объект будет опознаваться только по имени: следующая догрузка
          // не узнает его, если имя изменится.
          rows={preview.new_nodes.map((n) => ({
            path: n.path,
            note: anchorKind(n.source) === null ? " (без источника)" : null,
          }))}
        />
      )}
      {/* Сырых строк «Проверьте» здесь нет (Ф2г): всё, что не стало вопросом, показывает
          свёртка «Придется подправить вручную» дружелюбными пунктами. */}
    </div>
  );
}

// Перечень путей: первые PATHS_SHOWN, «и ещё N» кнопкой-текстом раскрывает список целиком.
// Сервер присылает не все пути, а начало (полное число рядом): чего в ответе нет, то
// остаётся тихим «и ещё N» и после раскрытия.
function PathList({ title, total, rows }: {
  title: string;
  total: number;
  rows: { path: string; note: string | null }[];
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, PATHS_SHOWN);
  const notSent = total - rows.length;
  return (
    <div className="ii-sec">
      <p className="ii-sec-title">{title}</p>
      <ul className="ii-rows">
        {shown.map((r) => (
          <li key={r.path}>
            {r.path}
            {r.note && <span className="ii-quiet">{r.note}</span>}
          </li>
        ))}
        {shown.length < rows.length ? (
          <li>
            <button type="button" className="ds-add ii-more" onClick={() => setOpen(true)}>
              и ещё {total - shown.length}
            </button>
          </li>
        ) : notSent > 0 && (
          <li className="ii-quiet">и ещё {notSent}</li>
        )}
      </ul>
    </div>
  );
}

// Отчёт применения: «сколько записей тронуто» (форма догрузки), отчёты семей — родные.
// Что придётся поправить руками, показывает свёртка до закрытия окна.
export function IntoApplyReport({ result }: { result: IntoApplyOut }) {
  return (
    <section className="ds-win-block ii-report">
      <h3 className="ds-win-block-title">Архивы догружены</h3>
      <div>
        <div>
          Создано объектов: {result.nodes_created}, связей: {result.edges_created}
          {result.nodes_filled > 0 && `, дополнено объектов: ${result.nodes_filled}`}
        </div>
        <div>
          Схем логики: {result.docs_created}
          {result.docs_replaced > 0 && `, заменено: ${result.docs_replaced}`}
          {", спецификаций: "}{result.specs_applied}
        </div>
        <FactLines result={result} />
        {result.config && (
          <div>
            Параметров конфигурации: {result.config.params_written}
            {result.params_replaced > 0 && `, заменено: ${result.params_replaced}`}
          </div>
        )}
        <ReportTail result={result} />
      </div>
    </section>
  );
}
