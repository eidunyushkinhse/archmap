import { useEffect, useRef, useState } from "react";
import Modal from "../ui/Modal";
import { CloseIcon } from "../ui/icons";
import { copyText } from "../lib/copyText";
import "../ui/ds.css";
import "./exportModal.css";

interface Props {
  // Заголовок модалки («Экспорт схемы», «Экспорт объекта с вложенными»).
  title: string;
  // Ключ области экспорта (scope) — "all" / id узла / id процесса. Дубль как dep эффекта.
  loadKey: string;
  // Загрузчик документа (YAML-схема или Mermaid-процесс). Вызывается на маунт.
  // Структурный минимум — { content }: ExportResponse подходит, как и Mermaid-обёртка.
  load: () => Promise<{ content: string }>;
  onClose: () => void;
}

// Сколько держится «Скопировано».
const COPIED_MS = 1500;

/**
 * Модалка экспорта в текст для скармливания LLM: C4-схема (или поддерево) в YAML
 * либо бизнес-процесс в Mermaid sequenceDiagram — определяется загрузчиком load.
 * Сама грузит документ (эффект только фетчит, loading/error/content — производные
 * от привязанного к loadKey стейта), показывает его в <pre> и даёт кнопку «Скопировать».
 *
 * Вид (редизайн, фаза 9г): каркас окна нового языка (ui/ds.css, ds-win), текст — блок
 * кода на всё тело, сам он и прокручивается по обеим осям (exportModal.css); шапка и
 * подвал видны всегда. В подвале «Скопировать» первой, «Закрыть» за ней, ряд слева;
 * после копирования кнопка ненадолго говорит «Скопировано», как кнопки задания агенту
 * (docsImport/PromptCopyButton).
 */
export default function ExportModal({ title, loadKey, load, onClose }: Props) {
  const [state, setState] = useState<{ forKey: string; content?: string; error?: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  // load пересоздаётся родителем на каждый рендер — держим в ref (обновляем в
  // эффекте, не в рендере), чтобы фетч-эффект зависел только от loadKey.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  useEffect(() => {
    let alive = true;
    loadRef
      .current()
      .then((r) => { if (alive) setState({ forKey: loadKey, content: r.content }); })
      .catch((e: unknown) => {
        if (alive) {
          setState({
            forKey: loadKey,
            error: e instanceof Error ? e.message : "Не удалось выгрузить схему",
          });
        }
      });
    return () => { alive = false; };
  }, [loadKey]);

  // Производные: результат «своей» области или null (идёт загрузка).
  const current = state?.forKey === loadKey ? state : null;
  const loading = current === null;
  const content = current?.content ?? null;
  const error = current?.error ?? null;

  const copy = async () => {
    if (!content) return;
    try {
      await copyText(content);
      // Повторный щелчок продлевает «Скопировано».
      window.clearTimeout(copiedTimer.current);
      setCopied(true);
      copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Буфер недоступен и запасной способ не сработал — текст и так виден в окне,
      // пользователь скопирует выделением вручную. Молча, чтобы не пугать ошибкой.
    }
  };

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 720, padding: 0 }}>
      <div className="ds ds-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">{title}</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {/* С текстом тело — один блок кода от края до края: прокручивается он сам. */}
        <div className={"ds-win-body" + (content !== null ? " ex-body" : "")}>
          {loading && <p className="ds-empty ex-note">Готовим экспорт</p>}
          {error && <p className="ds-danger ex-note" role="alert">{error}</p>}
          {content !== null && <pre className="ex-code">{content}</pre>}
        </div>

        <div className="ds-win-foot">
          {/* «Скачать архив» переехал в меню «Действия со схемой» (П1 приёмки
              2026-09-02): в модалке экспорта СХЕМЫ он читался как «что-то в zip». */}
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => void copy()} disabled={!content}>
            {copied ? "Скопировано" : "Скопировать"}
          </button>
          <button type="button" className="ds-btn" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </Modal>
  );
}
