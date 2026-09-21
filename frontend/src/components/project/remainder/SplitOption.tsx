// Сплит-кнопка «источник | Открыть» (§5.2 ТЗ). Только у схем логики: их тела
// длинные, и выбирать вслепую нельзя — правая половина открывает вьюер (§5.5), не
// меняя выбора. У коротких тел (спека, таблица, канал, параметр) сплита нет.
import type { ReactNode } from "react";
import Option from "./Option";

interface Props {
  main: ReactNode;
  sub?: ReactNode;
  selected: boolean;
  onSelect: () => void;
  /** Вьюер этого кандидата открыт — правая половина подписана «Открыто». */
  open: boolean;
  onOpen: () => void;
}

export default function SplitOption({ main, sub, selected, onSelect, open, onOpen }: Props) {
  return (
    <div className="rq-opt-row">
      <Option main={main} sub={sub} selected={selected} onClick={onSelect} />
      <button type="button" className="rq-opt-r" onClick={onOpen}>
        {open ? "Открыто" : "Открыть"}
      </button>
    </div>
  );
}
