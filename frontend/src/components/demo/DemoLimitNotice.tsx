// Сообщения пределов демо-стенда (docs/tasks/demo-mode.md, экран 3 прототипа): «Проект не
// помещается в демо» с полоской «142 из 100» и «Файл слишком большой для демо» в окнах
// ввоза, отказ записи по пределу в разделах страницы объекта. Тексты — demoLimits.ts. Вид
// нового языка (ui/ds.css, ds-limit*): абзац цветом опасности без коробки, выделенное начало
// тем же цветом; ширина заполнения полоски — единственный инлайн-стиль (она считается).
import type { DemoExcess } from "../../types";
import { excessText, fileTooBigText, humanSize, kb, METER_LABEL } from "./demoLimits";
import type { ExcessScope, LimitMessage } from "./demoLimits";
import "../../ui/ds.css";

/** Проект не помещается в пределы: сообщение и полоска «142 из 100». */
export function DemoExcessNotice({ excess, scope }: { excess: DemoExcess; scope: ExcessScope }) {
  const value = excess.kind === "text"
    ? `${humanSize(excess.actual)} из ${kb(excess.limit)}`
    : `${excess.actual} из ${excess.limit}`;
  const fill = Math.min(100, Math.round((excess.actual / Math.max(1, excess.limit)) * 100));
  return (
    <div className="ds-limit">
      <p className="ds-danger ds-limit-msg" role="alert">
        <strong>Проект не помещается в демо.</strong> {excessText(excess, scope)}
      </p>
      <div className="ds-limit-meter">
        <div className="ds-limit-meter-label">
          <span>{METER_LABEL[excess.kind]}</span>
          <span>{value}</span>
        </div>
        <div className="ds-limit-track"><i className="ds-limit-fill" style={{ width: `${fill}%` }} /></div>
      </div>
    </div>
  );
}

export function FileTooBigNotice({ name, size, limit }: { name: string; size: number; limit: number }) {
  return (
    <p className="ds-danger ds-limit-msg" role="alert">
      <strong>Файл слишком большой для демо.</strong> {fileTooBigText(name, size, limit)}
    </p>
  );
}

/** Отказ записи по пределу («Не сохранилось. Текста в проекте стало больше…») —
 *  абзацем в разделах страницы объекта (конфигурация, таблицы, каналы). */
export function LimitNotice({ message }: { message: LimitMessage }) {
  return (
    <p className="ds-danger ds-limit-note" role="alert">
      <strong>{message.head}</strong> {message.text}
    </p>
  );
}
