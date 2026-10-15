// Конец связи «Откуда»/«Куда» в правой панели редактора и модалке связи страницы
// объекта: у архитектора — пикер сквозного поиска по проекту (работает и «углубление» с
// контейнера на ребёнка), у наблюдателя — имя конца с глифом формы.
import type { ReactNode } from "react";
import NodeSearchPicker from "../NodeSearchPicker";
import MetaRow from "./MetaRow";
import { META_ICON } from "./metaIcons";

export default function EdgeEndRow({ end, value, label, onPick, glyph }: {
  end: "source" | "target";
  // id конца и его имя (подпись пикера).
  value: string;
  label: string;
  // Выбор в пикере; нет — конец только читается.
  onPick?: (id: string, label?: string) => void;
  glyph?: ReactNode;
}) {
  return (
    <MetaRow icon={META_ICON[end]} label={end === "source" ? "Откуда" : "Куда"} top={!!onPick} layout="block">
      {onPick ? (
        <NodeSearchPicker value={value} initialLabel={label} onChange={onPick} />
      ) : (
        <span className="insp-value">{glyph}<span className="insp-endname">{label}</span></span>
      )}
    </MetaRow>
  );
}
