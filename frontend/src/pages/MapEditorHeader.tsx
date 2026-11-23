// Шапка редактора-карты (редизайн, фаза 4б): слева логотип и крошки уровней, справа
// «Рекомендации», меню «Действия со схемой», вид схемы, «Принять переход» и «Готово». У
// читателя (экран в режиме просмотра, фаза 13д) из этого ряда только меню, вид схемы и
// вторичная «Закрыть»: завершать ему нечего, главной кнопки в шапке нет.
// Каркас — общий с шапкой оболочки проекта (ui/ds.css, ds-head*, фаза 5): при входе в
// редактор логотип и первая строка не прыгают. Крошки — pages/MapEditorPage.css (me-crumb*).
//
// Редкие действия над холстом — пунктами меню, а не кнопками: «Скрыть подписи связей»
// (все роли; состояние видно по самому холсту) и «Переразложить уровень» (только
// редактору проекта, подтверждение рисует страница).
import type { AncestorRef, SchemaAlerts as AlertsData } from "../types";
import SchemaAlerts, { type LocateTarget } from "../components/SchemaAlerts";
import SchemaActions, { type ExportScope, type SchemaMenuItem } from "../components/SchemaActions";
import { SchemaViewFilter } from "../components/SchemaViewFilter";
import type { SchemaView } from "../components/schemaView";
import TourHelpButton from "../components/tour/TourHelpButton";
import BrandLink from "../ui/BrandLink";
import { ChevronIcon } from "../ui/icons";
import "../ui/ds.css";
import "./MapEditorPage.css";

interface Props {
  // Логотип — на экран «Все проекты».
  onAllProjects: () => void;
  // Путь к уровню (сам уровень последним); пустой — корень проекта.
  crumbs: readonly AncestorRef[];
  // Корневая крошка («Контекст» на корне, «Проект» глубже) и звено пути по номеру.
  onRoot: () => void;
  onCrumb: (index: number) => void;
  // Может ли человек править проект: «Рекомендации», «Переразложить», «Принять переход».
  isArchitect: boolean;
  alerts: AlertsData;
  onLocate: (target: LocateTarget) => void;
  onOpenProcess: (processId: string) => void;
  // Меню «Действия со схемой»: экспорт открытого уровня, синк, архив.
  projectId: string;
  exportScope: ExportScope;
  onSynced: () => void;
  edgeLabelsHidden: boolean;
  onToggleEdgeLabels: () => void;
  // На уровне есть что переразложить.
  canRelayout: boolean;
  onRelayout: () => void;
  // Вид схемы; null — в проекте нет статусов: ни вида, ни «Принять переход».
  schemaView: SchemaView | null;
  onSchemaView: (view: SchemaView) => void;
  onAcceptTransition: () => void;
  // Выход туда, откуда открыли: «Готово» редактору проекта, «Закрыть» читателю.
  onDone: () => void;
}

export default function MapEditorHeader({
  onAllProjects, crumbs, onRoot, onCrumb, isArchitect, alerts, onLocate, onOpenProcess,
  projectId, exportScope, onSynced, edgeLabelsHidden, onToggleEdgeLabels, canRelayout, onRelayout,
  schemaView, onSchemaView, onAcceptTransition, onDone,
}: Props) {
  const items: SchemaMenuItem[] = [
    { label: edgeLabelsHidden ? "Показать подписи связей" : "Скрыть подписи связей", onSelect: onToggleEdgeLabels },
    ...(isArchitect ? [{ label: "Переразложить уровень", onSelect: onRelayout, disabled: !canRelayout }] : []),
  ];
  return (
    <header className="ds-head">
      <div className="ds-head-left">
        <BrandLink onClick={onAllProjects} />
        <span className="ds-head-sep" aria-hidden="true" />
        {/* Корневую крошку называют тексты обучающего тура: «Контекст» и «Проект». */}
        <button type="button" className="me-crumb me-crumb--root" data-tour="crumb-root" onClick={onRoot}>
          {crumbs.length === 0 ? "Контекст" : "Проект"}
        </button>
        {/* Шапка в одну строку: длинный путь не переносится, а обрезает имена многоточием,
            сначала у предков, текущий уровень последним. Полное имя — в подсказке. */}
        {crumbs.map((n, i) => {
          const current = i === crumbs.length - 1;
          return (
            <span key={n.id} className={"me-crumb-step" + (current ? " me-crumb-step--current" : "")}>
              <span className="me-crumb-chev" aria-hidden="true"><ChevronIcon /></span>
              {current ? (
                <button type="button" className="me-crumb me-crumb--current" title={n.name} disabled>{n.name}</button>
              ) : (
                <button type="button" className="me-crumb" title={n.name} onClick={() => onCrumb(i)}>{n.name}</button>
              )}
            </span>
          );
        })}
      </div>
      <div className="ds-head-acts">
        <div className="ds-head-icons">
          {isArchitect && (
            // Панель «Рекомендации» на новом языке, как в шапке оболочки.
            <SchemaAlerts alerts={alerts} onLocate={onLocate}
              // Процессные классы (AL26/AL27) на холсте чинить нечем: у повисшего шага
              // связь удалена, у непривязанного участника объекта нет. Уводим в процесс,
              // редактор при этом закрывается (решение пользователя: без вопроса и без
              // возврата).
              onOpenProcess={onOpenProcess} />
          )}
          <SchemaActions
            projectId={projectId}
            isArchitect={isArchitect}
            exportScope={exportScope}
            items={items}
            onSynced={onSynced}
          />
        </div>
        {schemaView !== null && <SchemaViewFilter view={schemaView} onChange={onSchemaView} variant="tabs" />}
        <div className="ds-head-btns">
          {/* «Принять переход» — рядом с видом схемы: обе вещи про статусы и есть,
              только когда принимать есть что. */}
          {isArchitect && schemaView !== null && (
            <button type="button" className="ds-btn" onClick={onAcceptTransition}>Принять переход</button>
          )}
          {isArchitect ? (
            <button type="button" className="ds-btn ds-btn--primary" onClick={onDone}>Готово</button>
          ) : (
            <button type="button" className="ds-btn" onClick={onDone}>Закрыть</button>
          )}
          {/* Гость демо-стенда: пилюля «Обучение» — пройти обучение заново, как в шапках
              оболочки и списка (у остальных она ничего не рисует). */}
          <TourHelpButton />
        </div>
      </div>
    </header>
  );
}
