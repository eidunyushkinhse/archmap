import { ChevronDownIcon } from "../ui/icons";
import "../ui/ds.css";

/**
 * Выбор типа связи: синхронная (вызов и ответ) или асинхронная (событие). Нативный список
 * языка (ds-select) с полными словами; синхронность канала задаётся явно, без вывода из
 * технологии. Имя для скринридера — «Тип связи» (видимая подпись, где она есть, стоит
 * рядом текстом). className — место вызова (ширина, отступ в строке).
 */
export default function SyncSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: boolean; // true = синхронная
  onChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span className={"ds-select" + (className ? " " + className : "")}>
      <select
        aria-label="Тип связи"
        value={value ? "sync" : "async"}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "sync")}
      >
        <option value="sync">Синхронная</option>
        <option value="async">Асинхронная</option>
      </select>
      <ChevronDownIcon />
    </span>
  );
}
