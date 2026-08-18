import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Modal from "../ui/Modal";
import { primaryBtn, secondaryBtn } from "../ui/styles";

interface Props {
  // Заголовок модалки («Экспорт схемы» / «Экспорт поддерева …»).
  title: string;
  // Ключ области экспорта (scope) — "all" / id узла / id процесса. Дубль как dep эффекта.
  loadKey: string;
  // Загрузчик документа (YAML-схема или Mermaid-процесс). Вызывается на маунт.
  // Структурный минимум — { content }: ExportResponse подходит, как и Mermaid-обёртка.
  load: () => Promise<{ content: string }>;
  // Полный архив знания (zip) — кнопка «Скачать архив» в футере. Передаётся только
  // для скоупа «вся схема»: у поддерева и процесса архива нет. filename — имя
  // сохраняемого файла (браузеру), loadArchive — фетч blob с авторизацией.
  archive?: { filename: string; load: () => Promise<Blob> };
  onClose: () => void;
}

/**
 * Модалка экспорта в текст для скармливания LLM: C4-схема (или поддерево) в YAML
 * либо бизнес-процесс в Mermaid sequenceDiagram — определяется загрузчиком load.
 * Сама грузит документ (эффект только фетчит, loading/error/content — производные
 * от привязанного к loadKey стейта), показывает его в <pre> и даёт кнопку «Скопировать».
 */
export default function ExportModal({ title, loadKey, load, archive, onClose }: Props) {
  const [state, setState] = useState<{ forKey: string; content?: string; error?: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
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
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API может быть недоступен (нет https/разрешения) — пользователь
      // скопирует выделением вручную. Молча проглатываем, чтобы не пугать ошибкой.
    }
  };

  // Скачивание архива: фетч с авторизацией → blob → временная ссылка. Прямой
  // <a href> не годится — заголовок Authorization в него не вписать.
  const [archiveState, setArchiveState] = useState<"idle" | "busy" | "error">("idle");
  const downloadArchive = async () => {
    if (!archive || archiveState === "busy") return;
    setArchiveState("busy");
    try {
      const blob = await archive.load();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = archive.filename;
      a.click();
      URL.revokeObjectURL(url);
      setArchiveState("idle");
    } catch {
      setArchiveState("error");
    }
  };

  return (
    <Modal onClose={onClose} boxStyle={boxStyle}>
      <h2 style={heading}>{title}</h2>

      {loading && <div style={statusBox}>Готовим экспорт…</div>}
      {error && <div style={{ ...statusBox, color: "#dc2626" }}>{error}</div>}
      {content !== null && <pre style={pre}>{content}</pre>}

      <div style={footer}>
        {archive && (
          <button
            onClick={() => void downloadArchive()}
            style={{ ...secondaryBtn, marginRight: "auto" }}
            disabled={archiveState === "busy"}
            title="Полный архив знания проекта: C4, схемы логики, спеки, структуры, конфигурация, процессы"
          >
            {archiveState === "busy" ? "Собираем архив…"
              : archiveState === "error" ? "Не удалось — повторить"
              : "Скачать архив (.zip)"}
          </button>
        )}
        <button onClick={onClose} style={secondaryBtn}>Закрыть</button>
        <button onClick={copy} style={primaryBtn} disabled={!content}>
          {copied ? "Скопировано ✓" : "Скопировать"}
        </button>
      </div>
    </Modal>
  );
}

const boxStyle: CSSProperties = {
  width: 720,
  maxHeight: "85vh",
  display: "flex",
  flexDirection: "column",
};
const heading: CSSProperties = {
  margin: "0 0 16px",
  fontSize: 18,
  fontWeight: 700,
  color: "#1e293b",
};
const statusBox: CSSProperties = {
  padding: "24px 0",
  textAlign: "center",
  color: "#64748b",
  fontSize: 14,
};
const pre: CSSProperties = {
  // Прокручивается ТОЛЬКО блок YAML (заголовок и футер обёртки остаются на месте —
  // эффект sticky). maxHeight = высота бокса (85vh) минус хром модалки (padding
  // обёртки + заголовок + футер ≈ 160px), чтобы длинный экспорт не распирал бокс.
  maxHeight: "calc(85vh - 160px)",
  overflow: "auto",
  margin: 0,
  padding: 14,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 12.5,
  lineHeight: 1.5,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  color: "#0f172a",
  whiteSpace: "pre",
};
const footer: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 10,
  marginTop: 16,
};
