// Страница объекта (single-schema): шапка (breadcrumb, имя, статус), свойства
// (inline CAS), схема (контекст объекта виртуальным корневым уровнем — SchemaSection),
// связи (таблица), участие в процессах, логика (node_docs), OpenAPI.
import { Fragment, useCallback, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AncestorRef, Node, NodeEdgeInfo, NodeUpdate } from "../types";
import { nodeNesting, shapeDocs } from "../types";
import { nodesApi, exportApi, viewsApi } from "../api/nodes";
import { isConflict, isDemoLimit } from "../api/client";
import { getNodeColors } from "../components/graph/colors";
import { useNodePatch } from "./useNodePatch";
import { ancestorRef, chainTo } from "./ancestorPath";
import { useAsyncLoad } from "../lib/useAsyncLoad";
import LoadError from "../ui/LoadError";
import { useToast } from "./useToast";
import { useContainerChildren } from "./useContainerChildren";
import DbStructureSection from "../components/DbStructureSection";
import BrokerChannelsSection from "../components/BrokerChannelsSection";
import ConfigParamsSection from "../components/ConfigParamsSection";
import { useFactsTransfer } from "../components/element/useFactsTransfer";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import EdgeEditModal from "../components/EdgeEditModal";
import ExportModal from "../components/ExportModal";
import DocsAgentModal from "../components/docsImport/DocsAgentModal";
import ReconAgentModal from "../components/docsImport/ReconAgentModal";
import DocOverlay from "../components/inspector/DocOverlay";
import type { NodeDocEvent } from "../components/inspector/FlowchartDocs";
import type { NavigateMap, ViewMetaState } from "../components/graph/types";
import "./NodePage.css";
import { noAutofill } from "../ui/noAutofill";
import NodeProperties from "../components/nodePage/NodeProperties";
import LogicSection from "../components/nodePage/LogicSection";
import OpenApiSection from "../components/nodePage/OpenApiSection";
import type { DocTarget } from "../components/nodePage/docTarget";
import EdgeRow from "../components/nodePage/EdgeRow";
import HeaderGlyph from "../components/nodePage/HeaderGlyph";
import ApprovalPill from "../components/nodePage/ApprovalPill";
import ProcessesSection from "../components/nodePage/ProcessesSection";
import SchemaSection from "../components/nodePage/SchemaSection";
import VersionsPanel from "../components/nodePage/versions/VersionsPanel";
import { useProjectRole } from "./projectRole";

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
  // Статус страницы — пилюля у имени. У контейнера вычисленный статус меняет чужое
  // согласование РЕБЁНКА (meta_rev): без него в сигнатуре страница промолчала бы.
  n.approval, n.approval_effective,
  // Элемент архитектуры — хранимый и действующий: чужая смена элемента двигает graph_rev,
  // а действующий меняется и без правки самого узла (предок стал контейнером — узел
  // стал компонентом), поэтому version строки здесь не помощник.
  n.element, n.element_effective,
  // Размещение — строка «Свойств» (Ф3 развёртывания): чужая смена площадок двигает
  // курсоры, но не CAS узла, — без неё в сигнатуре строка осталась бы прежней.
  n.sites.map((s) => [s.id, s.name, s.kind, s.parent_name, s.partial]),
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
  onNavigateMap?: NavigateMap;
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
  onNavigateMap?: NavigateMap;
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
  const isContainer = nodeNesting(node) === "group";
  // Какая документация уместна этой форме (types/shapeDocs). У базы данных не бывает
  // ни схем логики, ни OpenAPI — до 2026-08-12 страница предлагала ей и то, и другое.
  const allow = shapeDocs(shape);
  // Легаси-содержимое не прячем: показываем с предупреждением (тот же приём, что у
  // контейнеров со своей документацией) — иначе доки исчезли бы из интерфейса, и
  // унести их было бы нечем.
  const legacyLogic = !allow.logic && node.docs.length > 0;
  const legacySpec = !allow.spec && !!node.openapi_spec;
  // Система (элемент с сервера): сама не запускается — сводная технология потомков (Р15),
  // статус из вложенных объектов (Р14), перенос своей документации вниз (Р19).
  const isSystem = isContainer && node.element_effective === "system";
  // Потомки узла с детьми и их объединённые данные (доки/спеки/технология). Лист — хук
  // не фетчит.
  const container = useContainerChildren(node.id, isContainer, { docs: true, tech: isSystem });
  const colors = getNodeColors(node.is_external, 0, node.status);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Панель «Версии документации» (⋯-меню, обе роли). Удаляет версии только владелец
  // проекта; фиксирует — редактор (isArchitect).
  const [versionsOpen, setVersionsOpen] = useState(false);
  const isOwner = useProjectRole() === "owner";
  // Окно документации (Логика / OpenAPI); что именно открыть — DocTarget.
  const [doc, setDoc] = useState<DocTarget | null>(null);
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
  const openDocsAgent = useCallback(() => setDocsAgent(true), []);
  const openReconAgent = useCallback(() => setReconAgent(true), []);
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
  const reloadChildren = container.reload;
  const handleNodeChanged = useCallback(() => {
    // Дети контейнера — точки и счётчик пилюли статуса (и объединение их доков):
    // чужая правка ребёнка двигает meta_rev, а сигнатура самого контейнера меняется
    // не всегда («2 из 5» → «3 из 5»). Перечитываем их на каждый чужой сдвиг курсора.
    if (isContainer) reloadChildren();
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
  }, [node.id, patch, showMetaToast, isContainer, reloadChildren]);

  // Свежий узел целиком (после записи мимо onDocEvent: пакет агента, перенос).
  const refreshNode = useCallback(() => {
    void nodesApi.get(node.id).then((fresh) => patch.refresh(fresh)).catch(() => {});
  }, [node.id, patch]);

  // Размещение записано из строки «Размещение» (окно на одном объекте) или там заведена
  // площадка: свежий узел целиком (строка читает node.sites) и курсоры — своя запись
  // двигает graph_rev и meta_rev, без сверки курсоров тик поллинга принял бы её за чужую
  // («Схема обновлена в другой сессии»).
  const handlePlacementChanged = useCallback(() => {
    refreshNode();
    syncCursors();
  }, [refreshNode, syncCursors]);

  // Откат версии из панели: страница показывает восстановленную документацию сразу,
  // не дожидаясь поллинга. Узел — свежим целиком (без тоста «в другой сессии»), дети
  // контейнера, связи; секции схемы, фактов и логики перемонтируются ключом эпохи —
  // своего канала обновления у них нет, грузят себя при маунте.
  const [pageEpoch, setPageEpoch] = useState(0);
  const handleRestored = useCallback(() => {
    refreshNode();
    if (isContainer) reloadChildren();
    onEdgesReload();
    setPageEpoch((e) => e + 1);
  }, [refreshNode, isContainer, reloadChildren, onEdgesReload]);

  // «Перенести документацию» и «Собрать с компонентов» (Р19 эпика «Элемент архитектуры»):
  // запись меняет мету узла, его потомков и параметры — свежий узел, потомки, курсоры
  // (своя запись) и новая эпоха секций (секция конфигурации грузит себя при маунте).
  const handleFactsMoved = useCallback(() => {
    refreshNode();
    if (isContainer) reloadChildren();
    syncCursors();
    setPageEpoch((e) => e + 1);
  }, [refreshNode, isContainer, reloadChildren, syncCursors]);
  const facts = useFactsTransfer(node, isArchitect, pageEpoch, handleFactsMoved);

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
      setChildSpecConflict("Спецификация изменена в другой сессии — данные обновлены, повторите правку");
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
              // Поле имени — по ширине самого имени, но не уже слова «api» (обёртка
              // np-name-fit: невидимые копии текста в той же ячейке задают ширину):
              // длинное имя не обрезается, пилюля статуса стоит рядом с коротким.
              <span className="np-name-fit" data-value={patch.name}>
                <input
                  {...noAutofill("node-page-1")}
                  className="np-name-input"
                  value={patch.name}
                  onChange={(e) => patch.setName(e.target.value)}
                  onBlur={patch.commitName}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                />
              </span>
            ) : (
              <span className="np-name">{node.name}</span>
            )}

            {/* Статус страницы: у системы — из вложенных объектов, у остальных — выбор редактора */}
            <ApprovalPill
              node={node}
              isArchitect={isArchitect}
              units={container.units}
              onNavigateNode={onNavigateNode}
              onPick={patch.pickApproval}
            />

            {/* ⋯-меню: пункты просмотра — обеим ролям (история версий нужна и
                читателю, docs/tasks/doc-versions.md §7), пункты правки — редактору */}
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
                    <button onClick={() => { setMenuOpen(false); setVersionsOpen(true); }}>
                      Версии документации
                    </button>
                    {isArchitect && (
                      <>
                        <button onClick={() => { setMenuOpen(false); setExportOpen(true); }}>
                          Экспорт поддерева
                        </button>
                        <button className="np-danger" onClick={() => { setMenuOpen(false); setConfirming(true); }}>
                          Удалить объект
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Конфликт CAS */}
        {patch.conflict && <p className="np-conflict">{patch.conflict}</p>}
        {/* Отказ сервера с причиной (400): правка не применилась — причина обязана
            быть видна, «молча не сработало» хуже любого текста. Гаснет при
            следующей успешной правке. */}
        {patch.error && <p className="np-conflict">{patch.error}</p>}

        {/* ── Свойства ──────────────────────────────────────────── */}
        <Fragment key={pageEpoch}>
        <NodeProperties
          patch={patch}
          ancestors={ancestors}
          isArchitect={isArchitect}
          isSystem={isSystem}
          techLoading={container.loading}
          aggTech={container.aggTech}
          onNavigateNode={onNavigateNode}
          onPlacementChanged={handlePlacementChanged}
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
            onTransfer={isSystem ? facts.openTransfer : undefined}
            onCollect={facts.collectParams}
          />

          {/* ── Логика (node_docs) ────────────────────────────────── */}
          <LogicSection
            node={node}
            isContainer={isContainer}
            isArchitect={isArchitect}
            allowed={allow.logic}
            legacy={legacyLogic}
            groups={container.docGroups}
            loading={container.loading}
            onOpen={setDoc}
            onTransfer={facts.openTransfer}
            onDocsAgent={openDocsAgent}
            onReconAgent={openReconAgent}
            onNavigateNode={onNavigateNode}
            onNavigateProcesses={onNavigateProcesses}
          />

          {/* ── OpenAPI ───────────────────────────────────────────── */}
          <OpenApiSection
            spec={node.openapi_spec}
            isContainer={isContainer}
            isArchitect={isArchitect}
            allowed={allow.spec}
            legacy={legacySpec}
            groups={container.specGroups}
            loading={container.loading}
            onOpen={setDoc}
            onOpenChildSpec={openChildSpec}
            onTransfer={isSystem ? facts.openTransfer : undefined}
            onCollect={facts.collectSpec}
            onNavigateNode={onNavigateNode}
          />
        </div>
        </Fragment>
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

      {/* Версии документации объекта (⋯-меню): срез объекта с поддеревом. */}
      {versionsOpen && (
        <VersionsPanel
          nodeId={node.id}
          title={node.name}
          canEdit={isArchitect}
          canDelete={isOwner}
          onClose={() => setVersionsOpen(false)}
          onRestored={handleRestored}
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

      {/* «Перенести документацию» и «Собрать с компонентов» (Р19). */}
      {facts.dialogs}
    </div>
  );
}
