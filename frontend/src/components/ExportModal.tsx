import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ExportResponse } from "../types";
import Modal from "../ui/Modal";
import { primaryBtn, secondaryBtn } from "../ui/styles";

interface Props {
  // Заголовок модалки («Экспорт схемы» / «Экспорт поддерева …»).
  title: string;
  // Ключ области экспорта (scope) — "all" или id узла. Дубль как dep эффекта.
  loadKey: string;
  // Загрузчик документа (exportApi.all / exportApi.subtree). Вызывается на маунт.
  load: () => Promise<ExportResponse>;
  onClose: () => void;
}

/**
 * Модалка экспорта схемы (или поддерева) в текст (YAML) для скармливания LLM.
 * Сама грузит документ (по той же схеме, что NodeContextModal: эффект только
 * фетчит, loading/error/content — производные от привязанного к loadKey стейта),
 * показывает его в <pre> и даёт кнопку «Скопировать».
 */
export default function ExportModal({ title, loadKey, load, onClose }: Props) {
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

  return (
    <Modal onClose={onClose} boxStyle={boxStyle}>
      <h2 style={heading}>{title}</h2>

      {loading && <div style={statusBox}>Готовим экспорт…</div>}
      {error && <div style={{ ...statusBox, color: "#b91c1c" }}>{error}</div>}
      {content !== null && <pre style={pre}>{content}</pre>}

      <div style={footer}>
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
  color: "#111827",
};
const statusBox: CSSProperties = {
  padding: "24px 0",
  textAlign: "center",
  color: "#6b7280",
  fontSize: 14,
};
const pre: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  margin: 0,
  padding: 14,
  background: "#f8fafc",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  fontSize: 12.5,
  lineHeight: 1.5,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  color: "#1f2937",
  whiteSpace: "pre",
};
const footer: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 10,
  marginTop: 16,
};
