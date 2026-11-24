import { useState } from "react";
import type { Node } from "../types";
import { treeNesting } from "../types";
import { CloseIcon } from "../ui/icons";
import { ShapeGlyph } from "./nodeTree.shared";
import "./NodeTreePanel.css";
import "../ui/ds.css";
import "./nodeSearchPicker.css";
import { noAutofill } from "../ui/noAutofill";
import { useNodeSearch } from "./useNodeSearch";

/**
 * Поиск узла по имени среди всех уровней. Используется для выбора концов связи —
 * в т.ч. сквозной (узел с другого уровня). value — id выбранного узла ("" = нет).
 * initialLabel — подпись для предзаполненного выбора (при редактировании).
 *
 * Вид нового языка (редизайн, фаза 9в): поле окна ds-input, под ним список найденного
 * слоем меню — строки со значком формы объекта и тихой ролью справа (nodeSearchPicker.css).
 * Выбора с клавиатуры у списка нет: Enter в поле гасит место вызова (inspector/EdgeFields).
 */
export default function NodeSearchPicker({
  value,
  initialLabel,
  onChange,
}: {
  value: string;
  initialLabel?: string;
  onChange: (id: string, label?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(
    value ? { id: value, label: initialLabel ?? value } : null,
  );

  // Дебаунс-поиск (общий с деревом объектов). Компонент стоит под строкой конца связи в
  // панели связи редактора-карты и в окне «Связь» страницы объекта (inspector/EdgeFields,
  // value там всегда пустой), а очистку (clear) сам же зануляет локально — поэтому
  // зеркалящего value→selected эффекта нет.
  const search = useNodeSearch(query, 300);
  // Что показываем в списке: при пустом query — ничего (производное, не стейт).
  const shown = query.trim() ? (search.found ?? []) : [];

  function select(node: Node) {
    const label = node.name + (node.role ? ` (${node.role})` : "");
    setSelected({ id: node.id, label });
    onChange(node.id, label);
    setQuery("");
    search.reset();
  }

  function clear() {
    setSelected(null);
    onChange("");
  }

  if (selected) {
    return (
      <div className="nsp-selected">
        <span className="nsp-selected-name">{selected.label}</span>
        <button type="button" className="ds-icon-btn nsp-clear" onClick={clear} aria-label="Снять выбор">
          <CloseIcon size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="nsp">
      <input
        {...noAutofill("node-search-picker-1")}
        className="ds-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск по имени"
        autoFocus
      />
      {shown.length > 0 && (
        <div className="nsp-list">
          {shown.map((n) => (
            <div key={n.id} className="nsp-row" onClick={() => select(n)}>
              <ShapeGlyph nesting={treeNesting(n)} shape={n.shape} />
              <span className="nsp-name">{n.name}</span>
              {n.role && <span className="nsp-role">{n.role}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
