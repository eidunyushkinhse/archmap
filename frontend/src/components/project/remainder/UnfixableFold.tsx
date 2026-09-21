// Свёртка «Что исправит только новый прогон агента (N)» (§6 ТЗ): замечания, к
// которым вопроса не задать — их не закрывает ВЫБОР, потому что дело не в
// решении пользователя, а в том, как написаны сами файлы.
//
// Поэтому каждая карточка отвечает на «а что с этим делать»: путь починки
// («попросите агента… файл подмените здесь же»), кнопка копирования замечания
// его агенту и строка «Если оставить» — где это будет ждать после импорта.
import { useEffect, useRef, useState } from "react";
import type { UnfixableOut } from "../../../types";
import { ChevronIcon } from "../../../ui/icons";

interface Props {
  items: UnfixableOut[];
  /** Вступление копии — то же, что у кнопки «Скопировать замечания для агента». */
  intro: string;
}

export default function UnfixableFold({ items, intro }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  if (items.length === 0) return null;

  function copy(item: UnfixableOut) {
    void navigator.clipboard.writeText(`${intro}\n- ${item.text}`).then(() => {
      setCopied(item.id);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1800);
    });
  }

  return (
    <div className={"rq-root rq-uf" + (open ? " rq-uf--open" : "")}>
      <button type="button" className="rq-uf-hd" onClick={() => setOpen(!open)}>
        <span className="rq-uf-car"><ChevronIcon size={12} /></span>
        Что исправит только новый прогон агента ({items.length})
      </button>
      {open && (
        <div className="rq-uf-bd">
          <div className="rq-uf-lead">
            Это замечания о том, как написаны сами файлы: выбором их не закрыть. Каждое
            замечание можно унести своему агенту и подменить файл здесь же (или оставить,
            тогда придется исправить вручную).
          </div>
          {items.map((item) => (
            <div key={item.id} className="rq-uf-r">
              <div className="rq-uf-t">{item.text}</div>
              <div className="rq-uf-how">{item.how}</div>
              <div className="rq-uf-acts">
                <button type="button" className="rq-soft" onClick={() => copy(item)}>
                  {copied === item.id
                    ? "Скопировано ✓"
                    // Владельца у замечания может не быть (общее для нескольких
                    // файлов) — тогда кнопка зовётся без имени (Р6).
                    : `Скопировать замечание для агента${item.agent !== null && item.agent !== undefined ? ` ${item.agent}` : ""}`}
                </button>
              </div>
              <div className="rq-uf-if">{item.if_left}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
