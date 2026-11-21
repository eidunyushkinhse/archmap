// Конец связи «Откуда»/«Куда» в окне связи на странице объекта (EdgeEditModal, прежний
// язык до фазы окон): пикер сквозного поиска по проекту (работает и «углубление» с
// контейнера на ребёнка). Панель связи редактора-карты рисует концы своим видом
// (inspector/EdgeInspector).
import NodeSearchPicker from "../NodeSearchPicker";
import MetaRow from "./MetaRow";
import { META_ICON } from "./metaIcons";

export default function EdgeEndRow({ end, value, label, onPick }: {
  end: "source" | "target";
  // id конца и его имя (подпись пикера).
  value: string;
  label: string;
  onPick: (id: string, label?: string) => void;
}) {
  return (
    <MetaRow icon={META_ICON[end]} label={end === "source" ? "Откуда" : "Куда"} top layout="block">
      <NodeSearchPicker value={value} initialLabel={label} onChange={onPick} />
    </MetaRow>
  );
}
