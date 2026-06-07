import mermaid from "mermaid";
import { useEffect, useId, useRef } from "react";

mermaid.initialize({ startOnLoad: false, theme: "neutral" });

interface Props {
  chart: string;
}

export default function MermaidRenderer({ chart }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const rawId = useId();
  const id = "m" + rawId.replace(/:/g, "");

  useEffect(() => {
    if (!chart.trim()) return;
    let cancelled = false;
    mermaid
      .render(id, chart)
      .then(({ svg }) => {
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      })
      .catch(() => {
        if (!cancelled && ref.current)
          ref.current.textContent = "Ошибка в синтаксисе диаграммы";
      });
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  return <div ref={ref} />;
}
