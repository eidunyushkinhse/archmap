// Страница объекта (single-schema): шапка (breadcrumb, имя, статус), свойства
// (inline CAS), схема (контекст объекта виртуальным корневым уровнем — SchemaSection),
// связи (таблица), участие в процессах, логика (node_docs), OpenAPI.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AncestorRef, Node, NodeDocMeta, NodeDocUsage, NodeEdgeInfo, NodeUpdate } from "../types";
import { canHaveChildren, shapeDocs } from "../types";
import { nodesApi, nodeDocsApi, exportApi, viewsApi } from "../api/nodes";
import { isConflict, isDemoLimit } from "../api/client";
import { getNodeColors } from "../components/graph/colors";
import { ChevronDownIcon } from "../ui/icons";
import { useNodePatch } from "./useNodePatch";
import { ancestorRef, chainTo } from "./ancestorPath";
import { useAsyncLoad } from "../lib/useAsyncLoad";
import LoadError from "../ui/LoadError";
import { useToast } from "./useToast";
import { useContainerChildren } from "./useContainerChildren";
import DbStructureSection from "../components/DbStructureSection";
import BrokerChannelsSection from "../components/BrokerChannelsSection";
import { useShrinkAnchor } from "../components/useShrinkAnchor";
import ConfigParamsSection from "../components/ConfigParamsSection";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import DistributeDocsModal from "../components/DistributeDocsModal";
import EdgeEditModal from "../components/EdgeEditModal";
import ExportModal from "../components/ExportModal";
import AddDocsMenu from "../components/AddDocsMenu";
import NodeDocsList from "../components/NodeDocsList";
import { DocRowLabel, OwnerSplitRow } from "../components/docRow";
import UndescribedDocs from "../components/UndescribedDocs";
import DocsAgentModal from "../components/docsImport/DocsAgentModal";
import ReconAgentModal from "../components/docsImport/ReconAgentModal";
import DocOverlay from "../components/inspector/DocOverlay";
import type { NodeDocEvent } from "../components/inspector/FlowchartDocs";
import type { DocStage } from "../components/inspector/OpenApiPane";
import type { ViewMetaState } from "../components/graph/types";
import { plural } from "../ui/plural";
import "./NodePage.css";
import { noAutofill } from "../ui/noAutofill";
import NodeProperties from "../components/nodePage/NodeProperties";
import EdgeRow from "../components/nodePage/EdgeRow";
import HeaderGlyph from "../components/nodePage/HeaderGlyph";
import ProcessesSection from "../components/nodePage/ProcessesSection";
import SchemaSection from "../components/nodePage/SchemaSection";

// Сигнатура узла в том виде, в каком его показывает страница, — для сверки при
// удалённом изменении: совпала → изменение своё (уже применено локально), тост не
// нужен; отличается → чужая сессия, освежить и показать тост. Несёт и СТРУКТУРНЫЕ
// поля (имя, форма): они двигают graph_rev, а не meta_rev (view.md V48/V53), но
// «Свойства» страницы показывают именно их — сигнатура обязана их различать.
const nodeSig = (n: Node): string => JSON.stringify([
  n.name, n.shape, n.role, n.technology, n.status, n.description, n.is_external, n.openapi_spec,
  // Якорь — тоже строка «Свойств» (Ф1): чужая смена якоря обязана освежить
  // страницу, иначе поле показывало бы снятый или прежний ключ.
  n.source_ref,
  [...(n.docs ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map((d) => [d.id, d.name, d.kind, d.operation, d.version]),
]);

// Тост «Данные изменены в другой сессии» — поверх страницы (fixed).
const metaToastStyle: CSSProperties = {
  position: "fixed", top: 74, right: 24, zIndex: 60,
  background: "#eef2ff", border: "1px solid #c7d2fe", color: "#3730a3",
  borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 600,
  boxShadow: "0 4px 12px rgba(30,41,59,.12)",
};

interface Props {
  nodeId: string;
  isArchitect: boolean;
  // Навигация: страница другого узла / страница проекта
  onNavigateNode: (nodeId: string) => void;
  onNavigateProject: () => void;
  // Навигация в редактор-карту
  onNavigateMap?: (level: string | null, opts?: { locate?: string; ret?: string }) => void;
  // Навигация в режим «Процессы» с выбором процесса (секция «Участвует в процессах»)
  onNavigateProcesses?: (processId: string) => void;
  // Удаление узла со страницы → редирект на родителя
  onNodeDeleted?: (parentId: string | null) => void;
}

// Узел, предки (breadcrumb) и связи — одной загрузкой страницы.
async function loadNodePage(id: string): Promise<{ node: Node; ancestors: AncestorRef[]; edges: NodeEdgeInfo[] }> {
  const [node, all, edges] = await Promise.all([
    nodesApi.get(id),
    nodesApi.getAll(),
    nodesApi.getEdges(id),
  ]);
  return { node, ancestors: chainTo(all, node.parent_id).map(ancestorRef), edges };
}

export default function NodePage({ nodeId, isArchitect, onNavigateNode, onNavigateProject, onNavigateMap, onNavigateProcesses, onNodeDeleted }: Props) {
  // Отказ (404 — узел удалили, 403, сеть) — экран с причиной, а не вечная «Загрузка…»
  // (аудит R-2).
  const page = useAsyncLoad(nodeId, () => loadNodePage(nodeId));

  if (page.error) {
    return (
      <LoadError what="объект" error={page.error} onRetry={page.reload} onBack={onNavigateProject} />
    );
  }
  if (!page.data) {
    return <div className="np-loading">Загрузка…</div>;
  }
  const { node, ancestors, edges } = page.data;

  return (
    <NodePageInner
      key={node.id}
      node={node}
      ancestors={ancestors}
      edges={edges}
      isArchitect={isArchitect}
      onNavigateNode={onNavigateNode}
      onNavigateProject={onNavigateProject}
      onNavigateMap={onNavigateMap}
      onNavigateProcesses={onNavigateProcesses}
      onNodeDeleted={onNodeDeleted}
      onEdgesReload={() => {
        // Сбой загрузки связей: список останется прежним, догонит поллинг/перезаход
        nodesApi.getEdges(nodeId).then((fresh) => page.update((d) => ({ ...d, edges: fresh }))).catch(() => {});
      }}
    />
  );
}

// Внутренний компонент с key=node.id: перемонтируется при смене узла,
// сбрасывая локальные значения полей (как ObjectInspector в TreePage).
function NodePageInner({
  node: initialNode,
  ancestors,
  edges,
  isArchitect,
  onNavigateNode,
  onNavigateProject,
  onNavigateMap,
  onNavigateProcesses,
  onNodeDeleted,
  onEdgesReload,
}: {
  node: Node;
  ancestors: AncestorRef[];
  edges: NodeEdgeInfo[];
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onNavigateProject: () => void;
  onNavigateMap?: (level: string | null, opts?: { locate?: string; ret?: string }) => void;
  onNavigateProcesses?: (processId: string) => void;
  onNodeDeleted?: (parentId: string | null) => void;
  onEdgesReload: () => void;
}) {
  // Общий с секцией «Схема» курсор конкурентности (viewMeta): СОБСТВЕННЫЕ
  // записи страницы (свойства/доки/спеки) тихо обновляют его после коммита,
  // чтобы тик поллинга не принял своё изменение за чужое (echo-suppression, V53).
  const viewMetaRef = useRef<ViewMetaState>({ version: 0, graphRev: 0, metaRev: undefined });
  const syncCursors = useCallback(() => {
    viewsApi.state(null)
      .then((s) => { viewMetaRef.current = { version: s.version, graphRev: s.graph_rev, metaRev: s.meta_rev }; })
      .catch(() => { /* best-effort: сбой синхронизации курсора молчалив, следующий тик догонит */ });
  }, []);
  const patch = useNodePatch(initialNode, syncCursors);
  const node = patch.node;
  const shape = node.shape;
  const isContainer = canHaveChildren(shape) && node.has_children;
  // Какая документация уместна этой форме (types/shapeDocs). У базы данных не бывает
  // ни схем логики, ни OpenAPI — до 2026-08-12 страница предлагала ей и то, и другое.
  const allow = shapeDocs(shape);
  // Легаси-содержимое не прячем: показываем с предупреждением (тот же приём, что у
  // контейнеров со своей документацией) — иначе доки исчезли бы из интерфейса, и
  // унести их было бы нечем.
  const legacyLogic = !allow.logic && node.docs.length > 0;
  const legacySpec = !allow.spec && !!node.openapi_spec;
  // Правила контейнеров: непосредственные дети и их объединённые данные
  // (доки/спеки/технологии). Не контейнер — хук не фетчит.
  const container = useContainerChildren(node.id, isContainer);
  const colors = getNodeColors(node.is_external, 0, node.status);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Оверлей документации. `child` задан, когда открываем доку/спеку РЕБЁНКА прямо
  // со страницы контейнера (из объединённого списка) — тогда оверлей работает в
  // контексте ребёнка (его id/имя/спека), а не контейнера. create — новая схема
  // («+ Добавить → Вручную» в «Логике»), stage — с чего открыть окно спеки
  // («+ Добавить → Вручную / Через ИИ-агента» в «OpenAPI»).
  const [doc, setDoc] = useState<{
    mode: "flowchart" | "openapi"; docId?: string; create?: boolean; stage?: DocStage; child?: Node;
  } | null>(null);
  // Модалка «Доки от агента» (BYOA, логика, пакетом): скоуп = текущий объект.
  // Одну схему через агента правят в её окне («Изменить → Через ИИ-агента»).
  const [docsAgent, setDocsAgent] = useState(false);
  // Модалка «Список операций от агента» (BYOA, перечень операций и воркеров одним файлом)
  const [reconAgent, setReconAgent] = useState(false);
  // Модалка-редактор связи (архитектор): id связи из строки таблицы «Связи»
  const [edgeEditId, setEdgeEditId] = useState<string | null>(null);
  // Токен мутации (правка связи со страницы): секция «Схема» перерисовывает
  // изменившиеся стрелки анимированно (окно мутаций, AN28а).
  const [mutationToken, setMutationToken] = useState(0);
  // Модалка «Распределить по детям» (правила контейнеров, grandfather-доки/спека)
  const [distributeOpen, setDistributeOpen] = useState(false);
  // Раскрытые группы схем/спек глубоких потомков (ключ «doc:<id ребёнка>» /
  // «spec:<id ребёнка>»). Сбрасывается перемонтированием при смене узла.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  // Сворачивание группы у низа страницы держит скролл (useShrinkAnchor).
  const holdScroll = useShrinkAnchor();
  const toggleGroup = useCallback((key: string, el: HTMLElement) => {
    if (openGroups.has(key)) holdScroll(el);
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [openGroups, holdScroll]);
  // CAS-база для правки openapi РЕБЁНКА со страницы контейнера: полный узел
  // (после успешного коммита заменяется на сохранённый — со свежей версией,
  // чтобы повторная правка не словила ложный 409).
  const childSpecBaseRef = useRef<Node | null>(null);
  const [childSpecConflict, setChildSpecConflict] = useState<string | null>(null);

  // Узел изменился в ДРУГОЙ сессии — зовётся ЛЮБЫМ из двух курсоров поллинга:
  // meta_rev (роль/технология/статус/описание/внешность/openapi/доки) и graph_rev
  // (имя/форма — структурные поля, V48). Слушать только meta_rev было ошибкой:
  // чужая смена имени или типа освежала встроенную схему и не трогала «Свойства».
  // Канал один: тянем свежий узел и сверяем — совпало (своя запись уже применена
  // локально) → молча; отличается → применяем + тост «Данные обновлены».
  const [metaToast, showMetaToast] = useToast();
  const handleNodeChanged = useCallback(() => {
    nodesApi.get(node.id)
      .then((fresh) => {
        // Свежесть решает version строки, а не порядок прихода ответов (тот же
        // критерий, что у withOwnEdits, context.md X20): запрос, выпущенный до
        // собственной правки, мог вернуться после неё — устаревшим снимком
        // страницу не откатываем.
        if (fresh.version < patch.node.version) return;
        if (nodeSig(fresh) === nodeSig(patch.node)) return;
        patch.refresh(fresh);
        showMetaToast();
      })
      .catch(() => { /* узел могли удалить — догонит навигация */ });
  }, [node.id, patch, showMetaToast]);

  // Свежий узел целиком (после записи мимо onDocEvent: пакет агента, перенос).
  const refreshNode = useCallback(() => {
    void nodesApi.get(node.id).then((fresh) => patch.refresh(fresh)).catch(() => {});
  }, [node.id, patch]);

  // Мутация доков: применить к мете узла + тихо обновить курсоры (своя запись).
  const handleDocEvent = useCallback((evt: NodeDocEvent) => {
    patch.applyDocEvent(evt);
    syncCursors();
  }, [patch, syncCursors]);

  // ── Открытие доков/спеки РЕБЁНКА прямо со страницы контейнера ─────────────
  // Схемы логики: FlowchartDocs сам делает CRUD/CAS по nodeId=child.id; здесь лишь
  // освежаем объединение детей и курсоры (echo-suppression своей записи).
  const handleChildDocEvent = useCallback((_evt: NodeDocEvent) => {
    container.reload();
    syncCursors();
  }, [container, syncCursors]);

  // OpenAPI ребёнка: CAS-коммит в ребёнка (полный NodeUpdate из его полей +
  // base_version из childSpecBaseRef). Успех → свежая версия в ref + reload.
  const openChildSpec = useCallback((child: Node) => {
    childSpecBaseRef.current = child;
    setChildSpecConflict(null);
    setDoc({ mode: "openapi", child });
  }, []);
  // Возвращает true, если спека записана (окно спеки показывает её в просмотре).
  // Снимок ребёнка в стейте окна освежается вместе с CAS-базой: окно читает спеку
  // из него.
  const commitChildOpenapi = useCallback(async (value: string): Promise<boolean> => {
    const base = childSpecBaseRef.current;
    if (!base) return false;
    if (value === (base.openapi_spec ?? "")) return true;
    const payload: NodeUpdate = {
      name: base.name,
      description: base.description,
      role: base.role,
      technology: base.technology,
      openapi_spec: value || null,
      is_external: base.is_external,
      shape: base.shape,
      status: base.status,
      base_version: base.version,
    };
    const applyChild = (fresh: Node) => {
      childSpecBaseRef.current = fresh;
      setDoc((d) => (d?.child?.id === fresh.id ? { ...d, child: fresh } : d));
      container.reload();
    };
    try {
      applyChild(await nodesApi.update(base.id, payload));
      setChildSpecConflict(null);
      syncCursors();
      return true;
    } catch (e: unknown) {
      // Предел демо-стенда — окну спеки: оно оставит правку и покажет отказ в подвале.
      if (isDemoLimit(e)) throw e;
      if (!isConflict(e)) return false;
      nodesApi.get(base.id)
        .then(applyChild)
        .catch(() => { /* ребёнка могли удалить */ });
      setChildSpecConflict("Спека изменена в другой сессии — данные обновлены, повторите правку");
      return false;
    }
  }, [container, syncCursors]);

  // Пакет агента в окне, открытом на ребёнке: освежаем объединение детей и CAS-базу
  // его спеки (иначе следующая ручная правка словила бы ложный 409).
  const refreshChild = useCallback((child: Node) => {
    nodesApi.get(child.id)
      .then((fresh) => {
        if (childSpecBaseRef.current?.id === fresh.id) childSpecBaseRef.current = fresh;
      })
      .catch(() => { /* ребёнка могли удалить */ });
    container.reload();
  }, [container]);

  // Меню «+ Добавить» секции «Логика»: вручную (окно схемы сразу в «Вручную»,
  // схема создаётся только по «Сохранить») / через ИИ-агента (модалка режимом
  // «Пакетом» по умолчанию; на «По одной» пользователь переключится в модалке сам) /
  // «Составить список операций» — нулевой шаг: агент приносит не документацию, а
  // ПЕРЕЧЕНЬ, и он ложится заглушками (docs/plan-recon.md). Оба агентских пути — в
  // одной группе. Правила контейнеров: контейнеру новую логику создавать нельзя.
  const addLogicMenu = !isContainer && allow.logic && isArchitect ? (
    <AddDocsMenu
      groups={[
        [{ label: "Вручную", onSelect: () => setDoc({ mode: "flowchart", create: true }) }],
        [
          { label: "Через ИИ-агента", onSelect: () => setDocsAgent(true) },
          { label: "Составить список операций", onSelect: () => setReconAgent(true) },
        ],
      ]}
    />
  ) : null;

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
  const openDoc = useCallback((docId: string) => setDoc({ mode: "flowchart", docId }), []);

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

  // Меню «+ Добавить» секции «OpenAPI» (когда спеки нет): окно спеки сразу в нужном
  // режиме — «Вручную» (редактор) или «Через ИИ-агента» (панель агента). Когда спека
  // есть, её обновляют в самом окне («Изменить»). Контейнеру спеку создавать нельзя
  // (правила контейнеров).
  const addSpecMenu = !isContainer && allow.spec && isArchitect ? (
    <AddDocsMenu
      groups={[
        [{ label: "Вручную", onSelect: () => setDoc({ mode: "openapi", stage: "manual" }) }],
        [{ label: "Через ИИ-агента", onSelect: () => setDoc({ mode: "openapi", stage: "agent" }) }],
      ]}
    />
  ) : null;

  return (
    <div className="np-page">
      {metaToast && <div style={metaToastStyle}>Данные обновлены в другой сессии</div>}
      <div className="np-inner">
        {/* ── Шапка ─────────────────────────────────────────────── */}
        <div className="np-header">
          {/* Breadcrumb предков */}
          <div className="np-breadcrumb">
            <button onClick={onNavigateProject}>Проект</button>
            {ancestors.map((a) => (
              <span key={a.id} style={{ display: "inline-flex", alignItems: "center" }}>
                <span className="np-bc-sep">›</span>
                <button onClick={() => onNavigateNode(a.id)}>{a.name}</button>
              </span>
            ))}
          </div>

          {/* Глиф + имя + бейджи */}
          <div className="np-title-row">
            <span className="np-glyph" style={{ background: colors.bg }}>
              <HeaderGlyph shape={shape} container={isContainer} />
            </span>

            {isArchitect ? (
              <input
                {...noAutofill("node-page-1")}
                className="np-name-input"
                value={patch.name}
                onChange={(e) => patch.setName(e.target.value)}
                onBlur={patch.commitName}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
            ) : (
              <span className="np-name">{node.name}</span>
            )}

            {/* ⋯-меню (архитектор) */}
            {isArchitect && (
              <div className="np-menu-wrap">
                <button
                  className="np-menu-btn"
                  onClick={() => setMenuOpen((o) => !o)}
                  title="Действия"
                >
                  ⋯
                </button>
                {menuOpen && (
                  <>
                    <div className="np-backdrop" onClick={() => setMenuOpen(false)} />
                    <div className="np-dropdown">
                      {onNavigateMap && (
                        <button onClick={() => {
                          setMenuOpen(false);
                          // Ф11: редактор на родительском слое, объект подсвечен, возврат на страницу
                          onNavigateMap(node.parent_id ?? null, { locate: node.id, ret: `node:${node.id}` });
                        }}>
                          Открыть в карте
                        </button>
                      )}
                      <button onClick={() => { setMenuOpen(false); setExportOpen(true); }}>
                        Экспорт поддерева
                      </button>
                      <button className="np-danger" onClick={() => { setMenuOpen(false); setConfirming(true); }}>
                        Удалить объект
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Конфликт CAS */}
        {patch.conflict && <p className="np-conflict">{patch.conflict}</p>}
        {/* Отказ сервера с причиной (400): правка не применилась — причина обязана
            быть видна, «молча не сработало» хуже любого текста. Гаснет при
            следующей успешной правке. */}
        {patch.error && <p className="np-conflict">{patch.error}</p>}

        {/* ── Свойства ──────────────────────────────────────────── */}
        <NodeProperties
          patch={patch}
          isArchitect={isArchitect}
          isContainer={isContainer}
          techLoading={container.loading}
          aggTech={container.aggTech}
        />

        {/* ── Схема (single-schema: контекст объекта виртуальным корневым уровнем) ── */}
        <div className="np-card">
          <h3 className="np-card-title">Схема</h3>
          <SchemaSection
            node={node}
            ancestors={ancestors}
            isArchitect={isArchitect}
            onNavigateNode={onNavigateNode}
            onNavigateMap={onNavigateMap}
            onNodeChanged={handleNodeChanged}
            viewMeta={viewMetaRef}
            mutationToken={mutationToken}
          />
        </div>

        {/* ── Документация под схемой — одним блоком: на него смотрит обучающий тур
            (шаг «Не только схема»), раскладка та же, что у колонки карточек ── */}
        <div className="np-docs" data-tour="node-docs">
          {/* ── Связи ─────────────────────────────────────────────── */}
          <div className="np-card">
            <h3 className="np-card-title">Связи</h3>
            {edges.length === 0 ? (
              <p className="np-empty">Связей нет</p>
            ) : (
              <table className="np-edges-table">
                <thead>
                  <tr>
                    <th>Вызывающий</th>
                    <th className="np-edge-arrowcol" aria-hidden="true" />
                    <th>Вызываемый</th>
                    <th>Описание</th>
                    <th style={{ width: 140 }}>Технология</th>
                  </tr>
                </thead>
                <tbody>
                  {edges.map((e) => (
                    <EdgeRow
                      key={e.id}
                      edge={e}
                      nodeName={node.name}
                      isArchitect={isArchitect}
                      onNavigateNode={onNavigateNode}
                      onEdit={setEdgeEditId}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Участвует в процессах ─────────────────────────────── */}
          <ProcessesSection nodeId={node.id} onNavigateProcess={onNavigateProcesses} />

          {/* ── Структура (таблицы БД) ────────────────────────────── */}
          {allow.structure && (
            <DbStructureSection nodeId={node.id} nodeName={node.name} isArchitect={isArchitect} />
          )}

          {/* ── Каналы (структура брокера) ────────────────────────── */}
          {allow.channels && (
            <BrokerChannelsSection nodeId={node.id} nodeName={node.name} isArchitect={isArchitect} />
          )}

          {/* ── Конфигурация (параметры сервиса) ──────────────────── */}
          {/* Монтируется ВСЕГДА, в отличие от двух секций выше: параметров нет в теле
              узла, и узнать про легаси-записи у неподходящей формы можно только
              запросом. Секция сама промолчит, если их нет (спрятать применённое было
              бы хуже, чем показать с предупреждением). */}
          <ConfigParamsSection
            nodeId={node.id}
            isArchitect={isArchitect}
            allowed={allow.config}
          />

          {/* ── Логика (node_docs) ────────────────────────────────── */}
          {(allow.logic || legacyLogic || container.docGroups.length > 0)
            && (isArchitect || node.docs.length > 0 || container.docGroups.length > 0) && (
            <div className="np-card">
              <h3 className="np-card-title">Логика</h3>
              {isContainer ? (
                <>
                  {/* Собственные (grandfather) схемы контейнера: по правилам у
                      контейнера нет своей логики — предупреждение и перенос на
                      детей модалкой «Распределить по детям». */}
                  {node.docs.length > 0 && (
                    <>
                      <p className="np-warn">
                        У контейнера остались собственные логические диаграммы, распределите их по дочерним сервисам
                      </p>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {node.docs.map((d) => (
                          <button
                            key={d.id}
                            className="np-doc-row"
                            onClick={() => setDoc({ mode: "flowchart", docId: d.id })}
                          >
                            <DocRowLabel name={d.name} kind={d.kind} stub={!d.described} operation={d.operation} />
                          </button>
                        ))}
                      </div>
                      {isArchitect && (
                        <button type="button" className="np-addbtn" onClick={() => setDistributeOpen(true)}>
                          Распределить по детям
                        </button>
                      )}
                    </>
                  )}
                  {/* Объединение схем ВСЕХ потомков (дети и глубже), сгруппированное
                      по непосредственным детям контейнера: собственные схемы ребёнка —
                      плоские split-кнопки, схемы глубоких потомков — в раскрываемой
                      группе под ребёнком. Левая часть split-кнопки открывает схему
                      владельца напрямую, правая ведёт на его страницу. */}
                  {container.docGroups.length > 0 && (
                    <>
                      {node.docs.length > 0 && <div className="np-sublabel">Схемы потомков</div>}
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {container.docGroups.map((group) => {
                          const groupKey = `doc:${group.child.id}`;
                          const open = openGroups.has(groupKey);
                          return (
                            <Fragment key={group.child.id}>
                              {/* Собственные схемы ребёнка — плоско */}
                              {group.own.map((doc) => (
                                <DocSplitRow key={doc.id} doc={doc} child={group.child} onOpen={setDoc} onNavigateNode={onNavigateNode} />
                              ))}
                              {/* Схемы глубоких потомков — кнопка-группа с шевроном */}
                              {group.deep.length > 0 && (
                                <div className="np-group">
                                  <button
                                    type="button"
                                    className="np-doc-group-toggle"
                                    onClick={(e) => toggleGroup(groupKey, e.currentTarget)}
                                    aria-expanded={open}
                                  >
                                    <GroupChevron open={open} />
                                    {group.child.name}
                                    <span className="np-doc-group-count">
                                      {group.deep.length} {plural(group.deep.length, ["схема", "схемы", "схем"])}
                                    </span>
                                  </button>
                                  {open && (
                                    <div className="np-doc-group-body">
                                      {group.deep.map(({ doc, child }) => (
                                        <DocSplitRow key={`${child.id}:${doc.id}`} doc={doc} child={child} onOpen={setDoc} onNavigateNode={onNavigateNode} />
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </Fragment>
                          );
                        })}
                      </div>
                    </>
                  )}
                  {container.loading && <p className="np-empty">Загрузка данных детей…</p>}
                  {!container.loading && node.docs.length === 0 && container.docGroups.length === 0 && (
                    <p className="np-empty">
                      Это контейнер, то есть абстракция. У него нет своей логики, она может быть у
                      дочерних сервисов. Задокументируйте логику дочерних сервисов, и она будет
                      отображаться здесь.
                    </p>
                  )}
                </>
              ) : (
                <>
                  {legacyLogic && (
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
                  {addLogicMenu}
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
          )}

          {/* ── OpenAPI ───────────────────────────────────────────── */}
          {(allow.spec || legacySpec || container.specGroups.length > 0)
            && (isArchitect || node.openapi_spec || container.specGroups.length > 0) && (
            <div className="np-card">
              <h3 className="np-card-title">OpenAPI</h3>
              {isContainer ? (
                <>
                  {/* Своя (grandfather) спека контейнера: по правилам спеки живут
                      на атомарных детях — предупреждение и перенос одному ребёнку. */}
                  {node.openapi_spec && (
                    <>
                      <p className="np-warn">
                        У контейнера осталась собственная OpenAPI-спецификация, распределите её по дочерним сервисам
                      </p>
                      <button className="np-doc-row" onClick={() => setDoc({ mode: "openapi" })}>
                        <DocRowLabel name="Спецификация" />
                      </button>
                      {isArchitect && (
                        <button type="button" className="np-addbtn" onClick={() => setDistributeOpen(true)}>
                          Распределить по детям
                        </button>
                      )}
                    </>
                  )}
                  {/* Спеки потомков (дети и глубже), сгруппированные по непосредственным
                      детям контейнера: спека самого ребёнка — плоская split-кнопка,
                      спеки глубоких потомков — в раскрываемой группе под ребёнком. */}
                  {container.specGroups.length > 0 && (
                    <>
                      {node.openapi_spec && <div className="np-sublabel">Спеки потомков</div>}
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {container.specGroups.map((group) => {
                          const groupKey = `spec:${group.child.id}`;
                          const open = openGroups.has(groupKey);
                          return (
                            <Fragment key={group.child.id}>
                              {/* Спека самого ребёнка — плоско */}
                              {group.own && (
                                <SpecSplitRow child={group.child} onOpen={openChildSpec} onNavigateNode={onNavigateNode} />
                              )}
                              {/* Спеки глубоких потомков — кнопка-группа с шевроном */}
                              {group.deep.length > 0 && (
                                <div className="np-group">
                                  <button
                                    type="button"
                                    className="np-doc-group-toggle"
                                    onClick={(e) => toggleGroup(groupKey, e.currentTarget)}
                                    aria-expanded={open}
                                  >
                                    <GroupChevron open={open} />
                                    {group.child.name}
                                    <span className="np-doc-group-count">
                                      {group.deep.length} {plural(group.deep.length, ["спека", "спеки", "спек"])}
                                    </span>
                                  </button>
                                  {open && (
                                    <div className="np-doc-group-body">
                                      {group.deep.map((child) => (
                                        <SpecSplitRow key={child.id} child={child} onOpen={openChildSpec} onNavigateNode={onNavigateNode} />
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </Fragment>
                          );
                        })}
                      </div>
                    </>
                  )}
                  {container.loading && <p className="np-empty">Загрузка данных детей…</p>}
                  {!container.loading && !node.openapi_spec && container.specGroups.length === 0 && (
                    <p className="np-empty">
                      Это контейнер, то есть абстракция. У него нет своих эндпоинтов, они могут быть
                      у дочерних сервисов. Задокументируйте контракты дочерних сервисов, и они будут
                      отображаться здесь.
                    </p>
                  )}
                </>
              ) : node.openapi_spec ? (
                <>
                  {legacySpec && (
                    <p className="np-warn">
                      OpenAPI описывает HTTP-API, который объект предоставляет сам, — у этого объекта его нет
                    </p>
                  )}
                  <button className="np-doc-row" onClick={() => setDoc({ mode: "openapi" })}>
                    <DocRowLabel name="Спецификация" />
                  </button>
                </>
              ) : (
                <>
                  <p className="np-empty">Спецификация не задана</p>
                  {addSpecMenu}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Подтверждение удаления */}
      {confirming && (
        <NodeDeleteConfirm
          node={node}
          onCancel={() => setConfirming(false)}
          onDeleted={() => {
            setConfirming(false);
            onNodeDeleted?.(node.parent_id);
          }}
        />
      )}

      {/* Оверлей документации (Логика / OpenAPI). Если открыт док/спека РЕБЁНКА
          (doc.child) — работаем в контексте ребёнка, иначе — контейнера. */}
      {doc && (
        <DocOverlay
          mode={doc.mode}
          nodeId={doc.child ? doc.child.id : node.id}
          nodeName={doc.child ? doc.child.name : node.name}
          openapi={doc.child ? (doc.child.openapi_spec ?? "") : (node.openapi_spec ?? "")}
          isArchitect={isArchitect}
          createNew={doc.create}
          initialStage={doc.stage}
          initialDocId={doc.docId}
          onCommitOpenapi={doc.child
            ? commitChildOpenapi
            : (value) => patch.commitOpenapi(value).then((err) => err === null)}
          onDocEvent={doc.child ? handleChildDocEvent : handleDocEvent}
          onClose={() => setDoc(null)}
          notice={doc.child ? childSpecConflict : patch.conflict}
          // Пакет агента записан мимо истории: освежаем мету узла (или детей
          // контейнера, если окно открыто на схеме ребёнка).
          onApplied={() => (doc.child ? refreshChild(doc.child) : refreshNode())}
          onOpenProcess={onNavigateProcesses}
        />
      )}

      {/* Экспорт поддерева (⋯-меню) */}
      {exportOpen && (
        <ExportModal
          title="Экспорт поддерева"
          loadKey={node.id}
          load={() => exportApi.subtree(node.id)}
          onClose={() => setExportOpen(false)}
        />
      )}

      {/* Доки от агента (BYOA, секция «Логика»): скоуп = текущий объект.
          Закрытие после успешного применения — за самой модалкой. */}
      {docsAgent && (
        <DocsAgentModal
          nodeId={node.id}
          nodeName={node.name}
          onClose={() => setDocsAgent(false)}
          // Дозаливка изменила мету доков узла — свежий узел целиком (секция «Логика»).
          onApplied={refreshNode}
        />
      )}

      {/* Список операций от агента (BYOA, секция «Логика»): агент приносит ПЕРЕЧЕНЬ
          операций и воркеров, он ложится заглушками. Закрытие после успешного
          применения — за самой модалкой. */}
      {reconAgent && (
        <ReconAgentModal
          nodeId={node.id}
          nodeName={node.name}
          onClose={() => setReconAgent(false)}
          // Заглушки — те же схемы логики: свежий узел целиком, и секция «Логика»
          // показывает их сразу.
          onApplied={refreshNode}
        />
      )}

      {/* Редактор связи (архитектор, клик по строке таблицы «Связи»): структура
          — концы, направление, описание, технология. Секция «Схема» догоняет
          изменения своим поллингом (graph_rev); таблица — через onEdgesReload. */}
      {edgeEditId && (
        <EdgeEditModal
          edgeId={edgeEditId}
          onClose={() => setEdgeEditId(null)}
          onChanged={() => { setMutationToken((t) => t + 1); onEdgesReload(); }}
        />
      )}

      {/* «Распределить по детям» (правила контейнеров): перенос собственных
          (grandfather) схем логики и спеки контейнера на детей. */}
      {distributeOpen && isContainer && (
        <DistributeDocsModal
          nodeId={node.id}
          onClose={() => setDistributeOpen(false)}
          onApplied={() => {
            // Перенос изменил мету узла (доки/спека ушли детям) и мету детей:
            // свежий узел (обновляет CAS-базу и значения полей — секции «Логика»/
            // «OpenAPI» пересчитаются) и перезагрузка детей для объединения.
            refreshNode();
            container.reload();
          }}
        />
      )}
    </div>
  );
}

// Split-кнопка схемы потомка в объединении контейнера: левая (широкая) часть
// открывает схему владельца напрямую (в его контексте), правая (узкая) ведёт на
// страницу владельца — доки принадлежат ему.
function DocSplitRow({ doc, child, onOpen, onNavigateNode }: {
  doc: NodeDocMeta;
  child: Node;
  onOpen: (target: { mode: "flowchart"; docId: string; child: Node }) => void;
  onNavigateNode: (id: string) => void;
}) {
  return (
    <OwnerSplitRow
      openTitle={`Открыть схему «${doc.name}»`}
      onOpen={() => onOpen({ mode: "flowchart", docId: doc.id, child })}
      owner={child}
      onNavigateNode={onNavigateNode}
    >
      <DocRowLabel name={doc.name} kind={doc.kind} operation={doc.operation} />
    </OwnerSplitRow>
  );
}

// Split-кнопка спеки потомка в объединении контейнера: левая (широкая) часть
// открывает спеку владельца напрямую (его CAS-контекст), правая (узкая) ведёт
// на страницу владельца.
function SpecSplitRow({ child, onOpen, onNavigateNode }: {
  child: Node;
  onOpen: (child: Node) => void;
  onNavigateNode: (id: string) => void;
}) {
  return (
    <OwnerSplitRow
      openTitle={`Открыть спецификацию «${child.name}»`}
      onOpen={() => onOpen(child)}
      owner={child}
      onNavigateNode={onNavigateNode}
    >
      <DocRowLabel name="Спецификация" />
    </OwnerSplitRow>
  );
}

// ── Вспомогательные ─────────────────────────────────────────────────


// Шеврон кнопки-группы (схемы/спеки глубоких потомков): смотрит вниз, когда
// группа раскрыта, и вправо — когда свёрнута (CSS-трансформация).
function GroupChevron({ open }: { open: boolean }) {
  return (
    <span className="np-doc-group-chev" style={{ transform: open ? "none" : "rotate(-90deg)" }}>
      <ChevronDownIcon />
    </span>
  );
}
