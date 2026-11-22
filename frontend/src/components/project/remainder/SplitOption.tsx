// Вариант с просмотром «источник … Открыть» (§5.2 ТЗ). Только у схем логики: их тела
// длинные, и выбирать вслепую нельзя — «Открыть» открывает просмотр (§5.5), не меняя
// выбора. У коротких тел (спецификация, таблица, канал, параметр) просмотра нет.
//
// Две кнопки в одной строке (вложенная кнопка невалидна). В окнах ввоза строка и есть
// вариант: рамка и фон выбора у строки целиком, «Открыть» — тихая кнопка-текст у её правого
// края (importResult.css, фаза 8а); в «Собрать с компонентов» вид прежний.
import type { ReactNode } from "react";
import Option from "./Option";

interface Props {
  main: ReactNode;
  sub?: ReactNode;
  selected: boolean;
  /** Вариант действует без ответа: тег «по умолчанию». */
  byDefault?: boolean;
  onSelect: () => void;
  /** Просмотр этого кандидата открыт — кнопка подписана «Открыто». */
  open: boolean;
  onOpen: () => void;
}

export default function SplitOption({ main, sub, selected, byDefault, onSelect, open, onOpen }: Props) {
  return (
    <div className={"rq-opt-row" + (selected ? " rq-opt-row--on" : "")}>
      <Option main={main} sub={sub} selected={selected} byDefault={byDefault} onClick={onSelect} />
      <button type="button" className={"rq-opt-r" + (open ? " rq-opt-r--open" : "")} onClick={onOpen}>
        {open ? "Открыто" : "Открыть"}
      </button>
    </div>
  );
}
