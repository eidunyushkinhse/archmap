// Свёртка «Придется подправить вручную (N)» (§6 ТЗ, правка Ф2г): замечания, к
// которым вопроса не задать — их не закрывает ВЫБОР, потому что дело не в
// решении пользователя, а в том, как написаны сами файлы.
//
// Сюда едут ВСЕ такие замечания принятых входов — и о слитой схеме, и о
// конкретном файле (отдельной карточки «Замечания к файлу N» в панели больше нет).
// Каждый пункт — готовый текст бэка: что не так и что придётся сделать руками.
// Кнопок копирования «для агента» и путей починки нет намеренно: окно ввоза не
// знает, откуда пользователь взял файлы, и советовать «прогоните агента» ему не с
// чего (мотив правки Ф2г).
import { useState } from "react";
import type { UnfixableOut } from "../../../types";
import { ChevronIcon } from "../../../ui/icons";
import "./remainder.css";

interface Props {
  items: UnfixableOut[];
  /** Экран отчёта ПОСЛЕ импорта: «не закрыть вопросом» там звучит неточно —
   *  вопросов уже не будет, остаётся только ручная правка. */
  after?: boolean;
}

export default function UnfixableFold({ items, after = false }: Props) {
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <div className={"rq-root rq-uf" + (open ? " rq-uf--open" : "")}>
      <button
        type="button"
        className="rq-uf-hd"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="rq-uf-car"><ChevronIcon size={12} /></span>
        Придется подправить вручную ({items.length})
      </button>
      {open && (
        <div className="rq-uf-bd">
          <div className="rq-uf-lead">
            {after
              ? "После импорта остались нестыковки, которые нужно поправить вручную:"
              : "В файлах есть нестыковки, которые ArchMap не сможет закрыть одним вопросом. Вот их список:"}
          </div>
          <ul className="rq-ul">
            {items.map((item) => <li key={item.id}>{item.text}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
