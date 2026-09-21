// Вьюер тела кандидата (§5.5 ТЗ): схема логики отрисованной, прочие тела —
// текстом. Выбор кандидата вслепую по имени источника возможен, но схему честнее
// показать целиком — «Выбрать этот вариант» отвечает на вопрос прямо отсюда.
//
// ⚠️ Вьюер НЕ <dialog>: вложенные диалоги в проекте запрещены (их cancel всплывает
// и гасит соседа — ui/Modal.tsx, memory native-dialog-gotchas). Поэтому обычный
// fixed-оверлей в портале и своя обработка Escape: клавиша закрывает ВЬЮЕР, а окно
// под ним остаётся (preventDefault гасит запрос браузера на закрытие <dialog>,
// stopPropagation — слушателей выше; приём тот же, что у стека оверлеев
// ProcessCanvas).
//
// Портал целится в ОТКРЫТЫЙ <dialog>, если он есть: showModal поднимает окно в
// top-layer и делает остальной документ инертным — оверлей, положенный в body,
// оказался бы под подложкой и не нажимался.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import MermaidRenderer from "../../MermaidRenderer";
import { CloseIcon } from "../../../ui/icons";

interface Props {
  /** Ключ тела: имя схемы, путь спеки, имя канала или параметра. */
  title: string;
  /** Источник кандидата: «От агента Grafana», «Из архива плагина», «Из проекта». */
  source: string;
  /** Тег справа от заголовка: «mermaid · flowchart», «openapi», «канал»… */
  tag: string;
  body: string;
  /** Рисовать диаграмму (схема логики) или показать текстом. */
  diagram: boolean;
  onPick: () => void;
  onClose: () => void;
}

export default function DocViewer({ title, source, tag, body, diagram, onPick, onClose }: Props) {
  const [host] = useState<HTMLElement>(() => {
    const dialogs = document.querySelectorAll<HTMLElement>("dialog[open]");
    return dialogs[dialogs.length - 1] ?? document.body;
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="rq-root rq-ov"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="rq-ov-w" role="dialog" aria-label={title}>
        <div className="rq-ov-hd">
          <div className="rq-ov-t">{title}<span> · {source}</span></div>
          <span className="rq-ov-tag">{tag}</span>
          <button type="button" className="rq-ov-x" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon size={17} />
          </button>
        </div>
        <div className="rq-ov-bd">
          {diagram ? <MermaidRenderer chart={body} /> : <pre className="rq-ov-pre">{body}</pre>}
        </div>
        <div className="rq-ov-ft">
          <button type="button" className="rq-soft" onClick={onClose}>Закрыть</button>
          <span className="rq-sp" />
          <button type="button" className="rq-pri" onClick={onPick}>Выбрать этот вариант</button>
        </div>
      </div>
    </div>,
    host,
  );
}
