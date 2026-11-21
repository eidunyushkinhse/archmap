// Раздел «Логика» страницы объекта (аудит F-5: вынесен из NodePage): описанные схемы
// подгруппами по видам, бэклог заглушек под чертой, «Добавить» в строке заголовка.
//
// Видимость (редизайн, направление А «Документ»): раздел рисуется, только если в нём
// есть что показать или что сделать. Подходит объекту и пуст — у редактора одна строка
// (заголовок и «Добавить»), у читателя раздела нет. Не подходит — раздела нет, пока в
// нём не лежит старое содержимое: тогда оно показано с предупреждением.
//
// Узел с вложенными объектами — по элементу архитектуры (Ф8, Р34 эпика
// docs/plan-c4-elements.md). Схемы логики описывают код, поэтому своих схем у такого узла
// быть не должно: если они есть — предупреждение и «Перенести документацию», меню
// «Добавить» нет. Система документацию потомков не собирает; контейнер с компонентами и
// составной компонент показывают схемы компонентов подгруппами по прямым детям.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeDocUsage } from "../../types";
import type { PageElement } from "../element/elementView";
import { nodeDocsApi } from "../../api/nodes";
import type { ContainerDocGroup } from "../../pages/useContainerChildren";
import AddDocsMenu from "../AddDocsMenu";
import { DocRow, DocRowLabel } from "../docRow";
import NodeDocsList from "../NodeDocsList";
import UndescribedDocs from "../UndescribedDocs";
import Section from "../../ui/Section";
import "../../ui/ds.css";
import { DescendantGroups, DocSplitRow } from "./DescendantGroups";
import type { DocTarget } from "./docTarget";

// Узел с вложенными объектами: свои схемы — предупреждение.
type NestedKind = "system" | "container" | "composite";
const OWN_DOCS_WARN: Record<NestedKind, string> = {
  system: "У системы остались собственные схемы логики. Схемы описывают код, их можно перенести контейнерам и компонентам",
  container: "У контейнера есть свои схемы логики. Схемы описывают код, их можно перенести компонентам",
  composite: "У компонента есть свои схемы логики. Схемы описывают код, их можно перенести вложенным компонентам",
};

export default function LogicSection({
  node, element, isArchitect, allowed, legacy, groups,
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
  // составного компонента; у остальных пусто).
  groups: ContainerDocGroup[];
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
  // (решение пользователя 2026-09-03: витрина не смешивается с бэклогом).
  const describedDocs = useMemo(() => node.docs.filter((d) => d.described), [node.docs]);
  const stubDocs = useMemo(() => node.docs.filter((d) => !d.described), [node.docs]);

  // Открытие своей схемы из списка «Логики» (стабильная ссылка — список схем
  // монолита длинный, лишних ре-рендеров ему не нужно).
  const openDoc = useCallback((docId: string) => onOpen({ mode: "flowchart", docId }), [onOpen]);

  // Обратный индекс «используется в процессах» у СХЕМЫ (Ф8, У10): разворот привязок
  // шагов на чтении. Узловой вопрос закрывает раздел «Процессы», а при полусотне
  // операций он не говорит, какие процессы висят на этой. Ошибка — молча пусто:
  // индекс — украшение списка, а не его опора.
  const [docUsage, setDocUsage] = useState<NodeDocUsage[]>([]);
  useEffect(() => {
    let alive = true;
    nodeDocsApi.usage(node.id)
      .then((u) => { if (alive) setDocUsage(u); })
      .catch(() => { if (alive) setDocUsage([]); });
    return () => { alive = false; };
  }, [node.id]);

  const nested: NestedKind | null =
    element.kind === "system" || element.kind === "container" || element.kind === "composite" ? element.kind : null;
  const own = node.docs.length > 0;
  // Раздел подходит объекту, если схемы логики заводятся у него самого: форма их
  // допускает и вложенных объектов нет (их место у компонентов, Р9).
  const suitable = allowed && nested === null;
  if (!suitable && !own && groups.length === 0) return null;
  if (suitable && !own && !isArchitect) return null;

  // Меню «Добавить»: вручную (окно схемы сразу в «Вручную», схема создаётся только по
  // «Сохранить») / через ИИ-агента (модалка режимом «Пакетом» по умолчанию; на «По
  // одной» пользователь переключится в модалке сам) / «Составить список операций» —
  // нулевой шаг: агент приносит не документацию, а ПЕРЕЧЕНЬ, и он ложится заглушками
  // (docs/plan-recon.md). Оба агентских пути — в одной группе.
  const actions = suitable && isArchitect ? (
    <AddDocsMenu
      align="right"
      groups={[
        [{ label: "Вручную", onSelect: () => onOpen({ mode: "flowchart", create: true }) }],
        [
          { label: "Через ИИ-агента", onSelect: onDocsAgent },
          { label: "Составить список операций", onSelect: onReconAgent },
        ],
      ]}
    />
  ) : nested !== null && own && isArchitect ? (
    <button type="button" className="ds-btn" onClick={onTransfer}>Перенести документацию</button>
  ) : null;

  return (
    <Section title="Логика" actions={actions}>
      {nested !== null ? (
        <>
          {/* Собственные схемы узла с вложенными: схемы логики описывают код, их
              место у компонентов и объектов без вложенных — предупреждение и окно
              «Перенести документацию» (Р19 эпика «Элемент архитектуры»). */}
          {own && (
            <>
              <p className="np-warn">{OWN_DOCS_WARN[nested]}</p>
              <div className="ds-rows">
                {node.docs.map((d) => (
                  <DocRow key={d.id} onOpen={() => onOpen({ mode: "flowchart", docId: d.id })}>
                    <DocRowLabel name={d.name} kind={d.kind} stub={!d.described} operation={d.operation} />
                  </DocRow>
                ))}
              </div>
            </>
          )}
          {/* Схемы компонентов (дети и глубже) подгруппами по непосредственным детям:
              строка открывает схему владельца напрямую, подпись подгруппы ведёт на
              страницу ребёнка. У системы групп нет (Р34): страница системы
              документацию детей не собирает. */}
          {groups.length > 0 && (
            <DescendantGroups
              groups={groups}
              onNavigateNode={onNavigateNode}
              own={(group) => group.own.map((doc) => (
                <DocSplitRow key={doc.id} doc={doc} child={group.child} onOpen={onOpen} onNavigateNode={onNavigateNode} />
              ))}
              deep={(group) => group.deep}
              renderDeep={({ doc, child }) => (
                <DocSplitRow key={`${child.id}:${doc.id}`} doc={doc} child={child} deep onOpen={onOpen} onNavigateNode={onNavigateNode} />
              )}
            />
          )}
        </>
      ) : (
        <>
          {/* Схемы у формы без кода (база данных, брокер, пользователь): кнопки переноса
              здесь нет, словарь — как у совета рекомендаций о системах и контейнерах. */}
          {legacy && (
            <p className="np-warn">
              Схемы логики описывают код контейнера или компонента, а у этого объекта его нет. Перенесите их объекту, который с ним работает.
            </p>
          )}
          {/* Витрина — только ОПИСАННЫЕ схемы, подгруппами по видам. */}
          {describedDocs.length > 0 && (
            <NodeDocsList
              docs={describedDocs}
              onOpen={openDoc}
              usage={docUsage}
              onOpenProcess={onNavigateProcesses}
            />
          )}
          {/* Бэклог документирования — заглушки разведки — под чертой, в том же
              разделе и свёрнутым: строка открывает окно схемы, «Описать» — уже там.
              Нет заглушек — нет блока. */}
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
    </Section>
  );
}
