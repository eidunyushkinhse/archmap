import type { Edge } from "../types";
import Modal from "../ui/Modal";
import { CloseIcon, PlusIcon } from "../ui/icons";
import "../ui/ds.css";

// Окно «Выберите связь» (редизайн, фаза 9б: каркас окна нового языка ui/ds.css, ds-win).
// Под заголовком тихой строкой пара концов, ниже связи тихими строками списка (ds-rows):
// вся строка — одна кнопка, без рамки и заливки, подложка при наведении. Слева описание
// связи основным цветом и под ним настоящий конец связи (endOf), справа тихо технология;
// склейки описания с технологией точкой нет. Под списком тихое «Добавить связь» (onAdd).
// Длинный список прокручивается в теле окна, заголовок остаётся на месте.

// Строка окна — любая связь с подписью: связь холста (Edge с original_*) или строка
// таблицы «Связи» страницы объекта (NodeEdgeInfo). Окну нужны только id и текст.
type ChoiceEdge = Pick<Edge, "id" | "label" | "technology">;

// Дженерик по типу ребра: onPick возвращает РОВНО тот объект, что пришёл в edges
// (с original_* полями), не теряя их в типе при сужении до базового Edge.
interface Props<E extends ChoiceEdge> {
  edges: E[];
  sourceLabel?: string;
  targetLabel?: string;
  // Настоящий конец строки («→ Каталог», «Уведомления →»), когда связи пучка расходятся
  // концами: десять одинаковых «пользуется» без него не различить. undefined — строка
  // без второй строчки (концы у всех общие, их называет шапка).
  endOf?: (edge: E) => string | undefined;
  onPick: (edge: E) => void;
  // Опционально (только для архитектора): дозаписать новую связь к паре концов стрелки,
  // по которой открыто окно, не протягивая отдельную стрелку (edge.md E97). Куда она
  // ведёт, решает хозяин окна. Кнопки нет, если проп не передан.
  onAdd?: () => void;
  onClose: () => void;
}

// Текст строки: слева описание, справа технология. Без описания слева технология, а
// справа пусто; без того и другого слева «связь».
function edgeTexts(e: ChoiceEdge): { main: string; side: string | null } {
  if (e.label) return { main: e.label, side: e.technology || null };
  return { main: e.technology || "связь", side: null };
}

export default function EdgeChoiceModal<E extends ChoiceEdge>({
  edges,
  sourceLabel,
  targetLabel,
  endOf,
  onPick,
  onAdd,
  onClose,
}: Props<E>) {
  return (
    <Modal onClose={onClose} boxStyle={{ width: 440, padding: 0 }}>
      <div className="ds ds-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Выберите связь</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <p className="ds-win-lead">{`${sourceLabel} → ${targetLabel}`}</p>
          <div className="ds-rows" role="list">
            {edges.map((e) => {
              const end = endOf?.(e);
              const { main, side } = edgeTexts(e);
              // Пробелы между частями строки раскладка не рисует (это соседи во flex), но
              // они разделяют слова в имени кнопки для скринридера: «пользуется → Каталог».
              return (
                <div key={e.id} className="ds-row" role="listitem">
                  <button type="button" className="ds-row-main" onClick={() => onPick(e)}>
                    <span className="ds-row-text">
                      <span className="ds-row-name">{main}</span>
                      {end && <>{" "}<span className="ds-row-sub">{end}</span></>}
                    </span>
                    {side && <>{" "}<span className="ds-row-quiet">{side}</span></>}
                  </button>
                </div>
              );
            })}
          </div>
          {onAdd && (
            <button type="button" className="ds-add" onClick={onAdd}>
              <PlusIcon size={12} />
              Добавить связь
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
