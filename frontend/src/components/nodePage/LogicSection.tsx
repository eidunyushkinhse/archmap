// Секция «Логика» страницы объекта (аудит F-5: вынесена из NodePage): описанные схемы
// группами по видам, бэклог заглушек под чертой, меню «+ Добавить».
//
// Узел с вложенными объектами — по элементу архитектуры (Ф8, Р34 эпика
// docs/plan-c4-elements.md). Схемы логики описывают код, поэтому своих схем у такого узла
// быть не должно: если они есть — предупреждение и «Перенести документацию», меню
// «+ Добавить» нет. Система документацию потомков не собирает; контейнер с компонентами и
// составной компонент показывают схемы компонентов группами по прямым детям.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeDocUsage } from "../../types";
import type { PageElement } from "../element/elementView";
import { nodeDocsApi } from "../../api/nodes";
import type { ContainerDocGroup } from "../../pages/useContainerChildren";
import AddDocsMenu from "../AddDocsMenu";
import { DocRowLabel } from "../docRow";
import NodeDocsList from "../NodeDocsList";
import UndescribedDocs from "../UndescribedDocs";
import { DescendantGroups, DocSplitRow } from "./DescendantGroups";
import type { DocTarget } from "./docTarget";

// Узел с вложенными объектами: свои схемы — предупреждение, пусто — пояснение.
type NestedKind = "system" | "container" | "composite";
const OWN_DOCS_WARN: Record<NestedKind, string> = {
  system: "У системы остались собственные схемы логики. Схемы описывают код, их место у контейнеров и компонентов",
  container: "У контейнера есть свои схемы логики. Схемы описывают код, их место у компонентов",
  composite: "У компонента есть свои схемы логики. Схемы описывают код, их место у вложенных компонентов",
};
const COMPONENTS_EMPTY = "Схемы логики компонентов появятся здесь, когда их опишут";
const NESTED_EMPTY: Record<NestedKind, string> = {
  system: "Это система, своих схем логики у неё нет. Схемы логики описывают у её контейнеров и компонентов",
  container: COMPONENTS_EMPTY,
  composite: COMPONENTS_EMPTY,
};

export default function LogicSection({
  node, element, isArchitect, allowed, legacy, groups, loading,
  onOpen, onTransfer, onDocsAgent, onReconAgent, onNavigateNode, onNavigateProcesses,
}: {
  node: Node;
  // Как страница читает объект (components/element/elementView.pageElement).
  element: PageElement;
  isArchitect: boolean;
  // Схемы логики уместны этой форме (types/shapeDocs).
  allowed: boolean;
  // Легаси: у формы схем быть не должно, а они есть — показываем с предупреждением.
  legacy: boolean;
  // Схемы компонентов по непосредственным детям (у контейнера с компонентами и у
  // составного компонента; у остальных пусто) и признак их загрузки.
  groups: ContainerDocGroup[];
  loading: boolean;
  onOpen: (target: DocTarget) => void;
  // «Перенести документацию» (Р19): собственные схемы узла с вложенными — потомкам.
  onTransfer: () => void;
  onDocsAgent: () => void;
  onReconAgent: () => void;
  onNavigateNode: (id: string) => void;
  onNavigateProcesses?: (processId: string) => void;
}) {
  // Схемы объекта делятся НАДВОЕ — производное в рендере (эффект с setState тут
  // запрещён линтом и рассинхронился бы с метой). «Логика» показывает только
  // описанные схемы (с телом); заглушки разведки — строки перечня без тела — это не
  // схемы, а бэклог документирования, и живут они в блоке «Не описано» под чертой
  // (решение пользователя 2026-09-03: витрина не смешивается с бэклогом, а счётчики
  // «описано N из M» при физически разделённых списках лишние).
  const describedDocs = useMemo(() => node.docs.filter((d) => d.described), [node.docs]);
  const stubDocs = useMemo(() => node.docs.filter((d) => !d.described), [node.docs]);

  // Открытие своей схемы из списка «Логики» (стабильная ссылка — список схем
  // монолита длинный, лишних ре-рендеров ему не нужно).
  const openDoc = useCallback((docId: string) => onOpen({ mode: "flowchart", docId }), [onOpen]);

  // Обратный индекс «используется в процессах» у СХЕМЫ (Ф8, У10): разворот привязок
  // шагов на чтении. Узловой вопрос закрывает секция «Участвует в процессах», а при
  // полусотне операций она не говорит, какие процессы висят на этой. Ошибка — молча
  // пусто: индекс — украшение списка, а не его опора.
  const [docUsage, setDocUsage] = useState<NodeDocUsage[]>([]);
  useEffect(() => {
    let alive = true;
    nodeDocsApi.usage(node.id)
      .then((u) => { if (alive) setDocUsage(u); })
      .catch(() => { if (alive) setDocUsage([]); });
    return () => { alive = false; };
  }, [node.id]);

  if (!(allowed || legacy || groups.length > 0)) return null;
  if (!(isArchitect || node.docs.length > 0 || groups.length > 0)) return null;

  // Меню «+ Добавить»: вручную (окно схемы сразу в «Вручную», схема создаётся только по
  // «Сохранить») / через ИИ-агента (модалка режимом «Пакетом» по умолчанию; на «По
  // одной» пользователь переключится в модалке сам) / «Составить список операций» —
  // нулевой шаг: агент приносит не документацию, а ПЕРЕЧЕНЬ, и он ложится заглушками
  // (docs/plan-recon.md). Оба агентских пути — в одной группе. Узлу с вложенными
  // объектами новую логику не заводят: её место у компонентов (Р9).
  const nested: NestedKind | null =
    element.kind === "system" || element.kind === "container" || element.kind === "composite" ? element.kind : null;
  const addMenu = nested === null && allowed && isArchitect ? (
    <AddDocsMenu
      groups={[
        [{ label: "Вручную", onSelect: () => onOpen({ mode: "flowchart", create: true }) }],
        [
          { label: "Через ИИ-агента", onSelect: onDocsAgent },
          { label: "Составить список операций", onSelect: onReconAgent },
        ],
      ]}
    />
  ) : null;

  return (
    <div className="np-card">
      <h3 className="np-card-title">Логика</h3>
      {nested !== null ? (
        <>
          {/* Собственные схемы узла с вложенными: схемы логики описывают код, их
              место у компонентов и объектов без вложенных — предупреждение и окно
              «Перенести документацию» (Р19 эпика «Элемент архитектуры»). */}
          {node.docs.length > 0 && (
            <>
              <p className="np-warn">{OWN_DOCS_WARN[nested]}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {node.docs.map((d) => (
                  <button
                    key={d.id}
                    className="np-doc-row"
                    onClick={() => onOpen({ mode: "flowchart", docId: d.id })}
                  >
                    <DocRowLabel name={d.name} kind={d.kind} stub={!d.described} operation={d.operation} />
                  </button>
                ))}
              </div>
              {isArchitect && (
                <button type="button" className="np-addbtn" onClick={onTransfer}>
                  Перенести документацию
                </button>
              )}
            </>
          )}
          {/* Схемы компонентов (дети и глубже), сгруппированные по непосредственным
              детям: собственные схемы ребёнка — плоские split-кнопки, схемы глубоких
              потомков — в раскрываемой группе под ребёнком. Левая часть split-кнопки
              открывает схему владельца напрямую, правая ведёт на его страницу. У
              системы групп нет (Р34): страница системы документацию детей не собирает. */}
          {groups.length > 0 && (
            <>
              {node.docs.length > 0 && <div className="np-sublabel">Схемы компонентов</div>}
              <DescendantGroups
                groups={groups}
                words={["схема", "схемы", "схем"]}
                own={(group) => group.own.map((doc) => (
                  <DocSplitRow key={doc.id} doc={doc} child={group.child} onOpen={onOpen} onNavigateNode={onNavigateNode} />
                ))}
                deep={(group) => group.deep}
                renderDeep={({ doc, child }) => (
                  <DocSplitRow key={`${child.id}:${doc.id}`} doc={doc} child={child} onOpen={onOpen} onNavigateNode={onNavigateNode} />
                )}
              />
            </>
          )}
          {nested !== "system" && loading && <p className="np-empty">Загрузка…</p>}
          {(nested === "system" || !loading) && node.docs.length === 0 && groups.length === 0 && (
            <p className="np-empty">{NESTED_EMPTY[nested]}</p>
          )}
        </>
      ) : (
        <>
          {legacy && (
            <p className="np-warn">
              Схемы логики описывают код сервиса, а у этого объекта его нет — перенесите их на сервис, который с ним работает
            </p>
          )}
          {/* Витрина — только ОПИСАННЫЕ схемы, группами по видам (после
              разведки монолита их может быть двести, и плоский столбец
              нечитаем; на маленьком объекте группы стартуют развёрнутыми).
              Одни заглушки и ни одной описанной — так выглядит объект сразу
              после разведки; «не заданы» тут соврало бы: перечень лежит ниже. */}
          {describedDocs.length === 0 ? (
            <p className="np-empty">
              {stubDocs.length > 0 ? "Описанных схем логики пока нет" : "Схемы логики не заданы"}
            </p>
          ) : (
            <NodeDocsList
              docs={describedDocs}
              onOpen={openDoc}
              usage={docUsage}
              onOpenProcess={onNavigateProcesses}
            />
          )}
          {addMenu}
          {/* Бэклог документирования — заглушки разведки — под чертой, в той же
              карточке и свёрнутым: строка открывает окно схемы, «Описать» —
              уже там. Нет заглушек — нет блока. */}
          {stubDocs.length > 0 && (
            <UndescribedDocs
              docs={stubDocs}
              onOpen={openDoc}
              usage={docUsage}
              onOpenProcess={onNavigateProcesses}
            />
          )}
        </>
      )}
    </div>
  );
}
