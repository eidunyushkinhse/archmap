// Текст диаграммы процесса на стороне версии («Было в vN», «Стало…»; находка 2,
// 2026-11-24): после «Заменить из Mermaid» прежний вариант лежит в версии проекта, и вернуть
// его можно только текстом. Текст считает бэкенд тем же преобразованием, что экспорт
// процесса, из состояния на этой стороне (VersionView.mermaid). Вид — пояснение тихим
// текстом и «Скопировать» в одном ряду над блоком кода окна версий (vp-code), как в окне
// «Токен выпущен».
import { useState } from "react";
import { CopyFailed, copyText } from "../../../lib/copyText";
import "../../../ui/ds.css";
import "./versions.css";

export default function VersionMermaid({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    setFailed(false);
    try {
      await copyText(text);
      setCopied(true);
    } catch (e: unknown) {
      if (!(e instanceof CopyFailed)) throw e;
      setCopied(false);
      setFailed(true);
    }
  }

  return (
    <section className="ds-win-block" aria-label="Текст диаграммы">
      <div className="vp-mmd-row">
        <span className="vp-mmd-hint">Чтобы вернуть этот вариант процесса, вставьте текст в «Заменить из Mermaid».</span>
        <button type="button" className="ds-btn" onClick={() => void copy()}>
          {copied ? "Скопировано" : "Скопировать"}
        </button>
      </div>
      <pre className="vp-code">{text}</pre>
      {failed && <p className="ds-warn vp-flat">Браузер не дал скопировать. Выделите текст и скопируйте вручную.</p>}
    </section>
  );
}
