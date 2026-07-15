// Рендерер Mermaid-диаграмм. Библиотека тяжёлая, поэтому грузится лениво через
// import() при первом фактическом рендере — в главный бандл не попадает (проверка:
// vite build кладёт mermaid в отдельный чанк). Экспортирует статус парсинга для
// статус-строки редактора DocOverlay; без onStatus ведёт себя как раньше
// (текст ошибки в контейнер) — NodeModal не замечает разницы.
import { useEffect, useId, useRef } from "react";
import type { Mermaid } from "mermaid";

// Статус парсинга для статус-строки редактора (Часть D ТЗ визуализации доков).
export type MmdStatus =
  | { kind: "ok" }
  | { kind: "error"; line?: number; message: string }
  | { kind: "loading" };

// Модульный синглтон: один import и один initialize на всё приложение.
let mermaidP: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  mermaidP ??= import("mermaid").then((mod) => {
    mod.default.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
    return mod.default;
  });
  return mermaidP;
}

// Номер строки из ошибки mermaid: у Jison-ошибок это hash.loc.first_line,
// у остальных пробуем вытащить «on line N» из текста сообщения.
function errorLine(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "hash" in err) {
    const hash = (err as { hash?: { loc?: { first_line?: unknown } } }).hash;
    if (typeof hash?.loc?.first_line === "number") return hash.loc.first_line;
  }
  const m = /on line (\d+)/i.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : undefined;
}

interface Props {
  chart: string;
  // Задержка перерисовки при смене chart (живое превью не дёргается на каждый символ).
  // Первый рендер после маунта — всегда без задержки.
  debounceMs?: number;
  // Статус парсинга: с колбэком ошибки НЕ пишутся в DOM (держим последний удачный svg).
  onStatus?: (s: MmdStatus) => void;
}

export default function MermaidRenderer({ chart, debounceMs = 0, onStatus }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const rawId = useId();
  const id = "m" + rawId.replace(/:/g, "");
  // Свежий колбэк без перезапуска эффекта рендера (писать в ref в рендере нельзя).
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  });
  const firstRun = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (mermaidP === null) onStatusRef.current?.({ kind: "loading" });
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;
        if (!chart.trim()) {
          if (ref.current) ref.current.innerHTML = "";
          onStatusRef.current?.({ kind: "ok" });
          return;
        }
        await mermaid.parse(chart);
        if (cancelled) return;
        const { svg } = await mermaid.render(id, chart);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        onStatusRef.current?.({ kind: "ok" });
      } catch (err) {
        if (cancelled) return;
        // Упавший render оставляет в body временный контейнер d{id} — подчищаем.
        document.getElementById("d" + id)?.remove();
        if (onStatusRef.current) {
          onStatusRef.current({
            kind: "error",
            line: errorLine(err),
            message: err instanceof Error ? err.message : String(err),
          });
        } else if (ref.current) {
          ref.current.textContent = "Ошибка в синтаксисе диаграммы";
        }
      }
    };
    let timer: number | undefined;
    if (firstRun.current || debounceMs <= 0) {
      firstRun.current = false;
      void run();
    } else {
      timer = window.setTimeout(run, debounceMs);
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [chart, id, debounceMs]);

  return <div ref={ref} />;
}
