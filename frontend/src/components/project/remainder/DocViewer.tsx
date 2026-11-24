// Вьюер тела кандидата (§5.5 ТЗ): схема логики отрисованной, прочие тела —
// текстом. Выбор кандидата вслепую по имени источника возможен, но схему честнее
// показать целиком — «Выбрать этот вариант» отвечает на вопрос прямо отсюда.
//
// Пан/зум — ОБЩИЙ хук usePanZoom, тот же, что у превью схемы в инспекторе и у
// полноэкранной ER-диаграммы: открывается видом для чтения (текст не мельче 0,9, верх
// схемы у поля), колёсико прокручивает, Ctrl или ⌘ с колёсиком зумят к курсору,
// перетаскивание панорамит, пилюля «− / % / + / вписать» стоит в углу сцены. Своего зума
// здесь нет принципиально — жесты обязаны совпадать с оверлеем доков, иначе одна и та же
// диаграмма ведёт себя в двух местах по-разному. Колёсико над сценой не прокручивает
// окно под ней: хук вешает wheel с passive:false и гасит дефолт.
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
//
// Вид — новый язык (фаза 8а редизайна): корень в области .ds (портал уходит из области
// окна .imp-res, поэтому стили просмотра свои, в remainder.css на токенах), в шапке
// название и тихая подпись источника рядом, крестик — кнопка-значок; в подвале «Выбрать
// этот вариант» первой, «Закрыть» за ней. Тега формата нет.
//
// Размер (фаза 8б): схема — во весь экран, как окно документа (до 1120px в ширину, высота
// экрана без 64px), сцена занимает всё между шапкой и подвалом. Текст (таблица, канал,
// параметр, спецификация) — прежней ширины, высотой по содержимому до экрана без 64px,
// тело прокручивается.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import MermaidRenderer from "../../MermaidRenderer";
import type { MmdStatus } from "../../MermaidRenderer";
import { pinSvgSize, usePanZoom } from "../../usePanZoom";
import { CloseIcon } from "../../../ui/icons";
import "../../../ui/ds.css";
import "../../inspector/docOverlay.css";
import "./remainder.css";

interface Props {
  /** Ключ тела: имя схемы, путь спецификации, имя канала или параметра. */
  title: string;
  /** Источник кандидата: «Из файла grafana.yaml», «Из архива plugin-a.zip», «Из проекта». */
  source: string;
  body: string;
  /** Рисовать диаграмму (схема логики) или показать текстом. */
  diagram: boolean;
  onPick: () => void;
  onClose: () => void;
}

export default function DocViewer({ title, source, body, diagram, onPick, onClose }: Props) {
  const [host] = useState<HTMLElement>(() => {
    const dialogs = document.querySelectorAll<HTMLElement>("dialog[open]");
    return dialogs[dialogs.length - 1] ?? document.body;
  });

  const stageRef = useRef<HTMLDivElement>(null);
  const pzRef = useRef<HTMLDivElement>(null);
  const pz = usePanZoom(stageRef, pzRef);
  const { fitInitial } = pz;
  const fitted = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // Первый удачный рендер ставит вид для чтения один раз; дальше масштаб — дело пользователя.
  const onStatus = useCallback((s: MmdStatus) => {
    setError(s.kind === "error" ? s.message : null);
    if (s.kind !== "ok") return;
    pinSvgSize(pzRef.current);
    if (!fitted.current) {
      fitted.current = true;
      fitInitial();
    }
  }, [fitInitial]);

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
      className="ds rq-ov"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={"rq-ov-w" + (diagram ? " rq-ov-w--diagram" : "")} role="dialog" aria-label={title}>
        <div className="rq-ov-hd">
          <span className="rq-ov-t" title={title}>{title}</span>
          <span className="rq-ov-src">{source}</span>
          <button type="button" className="ds-icon-btn rq-ov-x" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {diagram ? (
          <div className="doc-pv rq-ov-stage">
            <div
              ref={stageRef}
              className={"doc-pvstage" + (pz.dragging ? " doc-pvstage--drag" : "")}
              {...pz.handlers}
            >
              <div ref={pzRef} className="doc-pz" style={pz.style}>
                <MermaidRenderer chart={body} onStatus={onStatus} />
              </div>
              {error !== null && (
                <div className="doc-pvcenter">
                  <div className="doc-mmderr">В схеме ошибка синтаксиса: {error}</div>
                </div>
              )}
              <div className="doc-zoom">
                <button type="button" onClick={pz.zoomOut} aria-label="Уменьшить">−</button>
                <span className="doc-zval">{Math.round(pz.scale * 100)}%</span>
                <button type="button" onClick={pz.zoomIn} aria-label="Увеличить">+</button>
                <span className="doc-zsep" />
                <button type="button" onClick={pz.fit} title="Вписать" aria-label="Вписать">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rq-ov-bd"><pre className="rq-ov-pre">{body}</pre></div>
        )}
        {/* Главная кнопка первой, «Закрыть» за ней (правило окон владельца). */}
        <div className="rq-ov-ft">
          <button type="button" className="ds-btn ds-btn--primary" onClick={onPick}>Выбрать этот вариант</button>
          <button type="button" className="ds-btn" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>,
    host,
  );
}
