// Страница объекта (single-schema): шапка (breadcrumb, имя, статус), свойства
// (inline CAS), схема (контекст объекта виртуальным корневым уровнем — SchemaSection),
// связи (таблица), участие в процессах, логика (node_docs), OpenAPI.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AncestorRef, GraphResponse, Node, NodeDocMeta, NodeEdgeInfo, NodeShape, NodeStatus, NodeUpdate, ProcessListItem, ViewLayoutPayload } from "../types";
import { canHaveChildren, shapeDocs } from "../types";
import { nodesApi, exportApi, viewsApi } from "../api/nodes";
import { isConflict } from "../api/client";
import { getNodeColors, STATUS_META } from "../components/graph/colors";
import { ChevronDownIcon } from "../ui/icons";
import { useNodePatch } from "./useNodePatch";
import { useRemoteSync } from "./useRemoteSync";
import { useToast } from "./useToast";
import { useContainerChildren } from "./useContainerChildren";
import DbStructureSection from "../components/DbStructureSection";
import BrokerChannelsSection from "../components/BrokerChannelsSection";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import DistributeDocsModal from "../components/DistributeDocsModal";
import EdgeEditModal from "../components/EdgeEditModal";
import ExportModal from "../components/ExportModal";
import AddDocsMenu from "../components/AddDocsMenu";
import NodeDocsList, { StubMark } from "../components/NodeDocsList";
import { KIND_LABEL } from "../components/docsList";
import DocsAgentModal from "../components/docsImport/DocsAgentModal";
import ReconAgentModal from "../components/docsImport/ReconAgentModal";
import SpecAgentModal from "../components/docsImport/SpecAgentModal";
import EmbeddedSchemaBlock from "../components/EmbeddedSchemaBlock";
import DocOverlay from "../components/inspector/DocOverlay";
import type { NodeDocEvent } from "../components/inspector/FlowchartDocs";
import { readSchemaView, showStatusControls, writeSchemaView, type SchemaView } from "../components/schemaView";
import type { LevelPersistenceProps, ViewMetaState } from "../components/graph/types";
import { hasNoNeighbors, schemaSectionHeight, toLevelEdges, visibleEntityGuess, withOwnEdits } from "../components/pageSchema";
import { plural } from "../ui/plural";
import "./NodePage.css";

// Сигнатура узла в том виде, в каком его показывает страница, — для сверки при
// удалённом изменении: совпала → изменение своё (уже применено локально), тост не
// нужен; отличается → чужая сессия, освежить и показать тост. Несёт и СТРУКТУРНЫЕ
// поля (имя, форма): они двигают graph_rev, а не meta_rev (view.md V48/V53), но
// «Свойства» страницы показывают именно их — сигнатура обязана их различать.
const nodeSig = (n: Node): string => JSON.stringify([
  n.name, n.shape, n.role, n.technology, n.status, n.description, n.is_external, n.openapi_spec,
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

export default function NodePage({ nodeId, isArchitect, onNavigateNode, onNavigateProject, onNavigateMap, onNavigateProcesses, onNodeDeleted }: Props) {
  const [node, setNode] = useState<Node | null>(null);
  const [ancestors, setAncestors] = useState<AncestorRef[]>([]);
  const [edges, setEdges] = useState<NodeEdgeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);

  // Загрузка узла, предков (breadcrumb) и связей
  const load = useCallback(async (id: string) => {
    setLoading(true);
    setNode(null);
    try {
      const [n, all, eds] = await Promise.all([
        nodesApi.get(id),
        nodesApi.getAll(),
        nodesApi.getEdges(id),
      ]);
      setNode(n);
      setEdges(eds);
      const byId = new Map(all.map((x) => [x.id, x]));
      const path: AncestorRef[] = [];
      let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
      while (cur) {
        path.unshift({ id: cur.id, name: cur.name, is_external: cur.is_external });
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
      setAncestors(path);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка данных при смене nodeId; setState в load() — стандартный паттерн (как TreePage.load)
  useEffect(() => { void load(nodeId); }, [nodeId, load]);

  if (loading || !node) {
    return <div className="np-loading">Загрузка…</div>;
  }

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
      confirming={confirming}
      setConfirming={setConfirming}
      onEdgesReload={() => {
        // Сбой загрузки связей: список останется прежним, догонит поллинг/перезаход
        nodesApi.getEdges(nodeId).then(setEdges).catch(() => {});
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
  confirming,
  setConfirming,
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
  confirming: boolean;
  setConfirming: (v: boolean) => void;
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
  const [exportOpen, setExportOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [shapeOpen, setShapeOpen] = useState(false);
  // Оверлей документации. `child` задан, когда открываем доку/спеку РЕБЁНКА прямо
  // со страницы контейнера (из объединённого списка) — тогда оверлей работает в
  // контексте ребёнка (его id/имя/спека), а не контейнера.
  const [doc, setDoc] = useState<{ mode: "flowchart" | "openapi"; docId?: string; create?: boolean; child?: Node } | null>(null);
  // Модалка «Доки от агента» (BYOA, логика): скоуп = текущий объект, режим открытия
  const [docsAgent, setDocsAgent] = useState<"batch" | "single" | null>(null);
  // Модалка «Спека от агента» (BYOA, OpenAPI): скоуп = текущий объект
  const [specAgent, setSpecAgent] = useState(false);
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
  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
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
  const commitChildOpenapi = useCallback((value: string) => {
    const base = childSpecBaseRef.current;
    if (!base) return;
    if (value === (base.openapi_spec ?? "")) return;
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
    nodesApi.update(base.id, payload)
      .then((saved) => {
        childSpecBaseRef.current = saved;
        setChildSpecConflict(null);
        container.reload();
        syncCursors();
      })
      .catch((e: unknown) => {
        if (!isConflict(e)) return;
        nodesApi.get(base.id)
          .then((fresh) => { childSpecBaseRef.current = fresh; container.reload(); })
          .catch(() => { /* ребёнка могли удалить */ });
        setChildSpecConflict("Спека изменена в другой сессии — данные обновлены, повторите правку");
      });
  }, [container, syncCursors]);

  // Меню «+ Добавить» секции «Логика»: вручную / через ИИ-агента («Через
  // ИИ-агента» открывает модалку режимом «Пакетом» по умолчанию; на «По одной»
  // пользователь переключится в модалке сам, если нужно) / «Составить список
  // операций» — нулевой шаг: агент приносит не документацию, а ПЕРЕЧЕНЬ, и он
  // ложится заглушками (docs/plan-recon.md). Оба агентских пути — в одной группе.
  // Правила контейнеров: контейнеру новую логику создавать нельзя (!isContainer).
  const addLogicMenu = !isContainer && allow.logic && isArchitect ? (
    <AddDocsMenu
      groups={[
        [{ label: "Вручную", onSelect: () => setDoc({ mode: "flowchart", create: true }) }],
        [
          { label: "Через ИИ-агента", onSelect: () => setDocsAgent("batch") },
          { label: "Составить список операций", onSelect: () => setReconAgent(true) },
        ],
      ]}
    />
  ) : null;

  // Счётчик «описано N из M» — ПРОИЗВОДНОЕ в рендере (эффект с setState тут запрещён
  // линтом и рассинхронился бы с метой). Знаменатель — только точки входа: схема-обзор
  // от разведки не зависит и завышала бы его на постоянную величину.
  const entryDocs = useMemo(
    () => node.docs.filter((d) => d.kind === "operation" || d.kind === "worker"),
    [node.docs],
  );
  const describedCount = useMemo(() => entryDocs.filter((d) => d.described).length, [entryDocs]);

  // Открытие своей схемы из списка «Логики» (стабильная ссылка — список схем
  // монолита длинный, лишних ре-рендеров ему не нужно).
  const openDoc = useCallback((docId: string) => setDoc({ mode: "flowchart", docId }), []);

  // Меню «+ Добавить» секции «OpenAPI» (когда спеки нет): вручную / через ИИ-агента.
  // Контейнеру спеку создавать нельзя (правила контейнеров).
  const addSpecMenu = !isContainer && allow.spec && isArchitect ? (
    <AddDocsMenu
      groups={[
        [{ label: "Вручную", onSelect: () => setDoc({ mode: "openapi" }) }],
        [{ label: "Через ИИ-агента", onSelect: () => setSpecAgent(true) }],
      ]}
    />
  ) : null;

  // Когда спека уже есть — вместо «+ Добавить» кнопка обновления через ИИ-агента
  // (контейнеру недоступна — спека контейнера подлежит распределению, не обновлению).
  const updateSpecBtn = !isContainer && allow.spec && isArchitect ? (
    <button type="button" className="np-addbtn" onClick={() => setSpecAgent(true)}>
      Обновить с помощью ИИ-агента
    </button>
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
        <div className="np-card">
          <h3 className="np-card-title">Свойства</h3>
          <div className="np-props">
            {/* Тип. Архитектор меняет форму прямо здесь (импорт мог ошибиться в
                типе — кейс «Monitored Hosts» с типом «Пользователь»). Запреты на
                стороне сервера: контейнером бывает только сервис, базу с описанной
                структурой не увести (спека N4а); причина отказа — плашкой выше. */}
            <span className="np-term">Тип</span>
            <span className="np-value">
              {isArchitect ? (
                <span className="np-selwrap">
                  <button
                    type="button"
                    className="np-select"
                    onClick={() => setShapeOpen((o) => !o)}
                    aria-haspopup="listbox"
                    aria-expanded={shapeOpen}
                  >
                    {SHAPE_LABEL[patch.shape]}
                    <ChevronDownIcon />
                  </button>
                  {shapeOpen && (
                    <>
                      <div className="np-backdrop" onClick={() => setShapeOpen(false)} />
                      <ul className="np-menu">
                        {SHAPE_ORDER.map((sh) => (
                          <li key={sh} onClick={() => { setShapeOpen(false); patch.pickShape(sh); }}>
                            {SHAPE_LABEL[sh]}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </span>
              ) : (
                SHAPE_LABEL[shape]
              )}
            </span>

            {/* Размещение. Внешность — относительно контура ОРГАНИЗАЦИИ (спека
                N2а): чужой продукт/сторона, а не «вне системы» — границу системы
                выражает дерево. Подсказка снимает двусмысленность (QA Zabbix v4). */}
            <span className="np-term" title={EXTERNAL_HINT}>Размещение</span>
            <span className="np-value" title={EXTERNAL_HINT}>
              {isArchitect ? (
                <button type="button" className="np-toggle" onClick={patch.toggleExternal}>
                  <span className={"np-switch" + (patch.isExternal ? " is-on" : "")} />
                  {patch.isExternal ? "Внешний" : "Внутренний"}
                </button>
              ) : (
                <>
                  <span className="np-dot" style={{ background: node.is_external ? "#9ca3af" : "#2563eb", display: "inline-block", marginRight: 6 }} />
                  {node.is_external ? "Внешний" : "Внутренний"}
                </>
              )}
            </span>

            {/* Статус */}
            <span className="np-term">Статус</span>
            <span className="np-value">
              {isArchitect ? (
                <span className="np-selwrap">
                  <button
                    type="button"
                    className="np-select"
                    onClick={() => setStatusOpen((o) => !o)}
                  >
                    <span className="np-dot" style={{ background: statusDotColor(patch.status, patch.isExternal) }} />
                    {STATUS_META[patch.status].label}
                    <ChevronDownIcon />
                  </button>
                  {statusOpen && (
                    <>
                      <div className="np-backdrop" onClick={() => setStatusOpen(false)} />
                      <ul className="np-menu">
                        {STATUS_ORDER.map((st) => (
                          <li key={st} onClick={() => { setStatusOpen(false); patch.pickStatus(st); }}>
                            <span className="np-dot" style={{ background: statusDotColor(st, patch.isExternal) }} />
                            {STATUS_META[st].label}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </span>
              ) : (
                <>
                  <span className="np-dot" style={{ background: statusDotColor(node.status, node.is_external), display: "inline-block", marginRight: 6 }} />
                  {STATUS_META[node.status].label}
                </>
              )}
            </span>

            {/* Роль */}
            <span className="np-term">Роль</span>
            <span className="np-value">
              {isArchitect ? (
                <input
                  className="np-field"
                  value={patch.role}
                  onChange={(e) => patch.setRole(e.target.value)}
                  onBlur={patch.commitRole}
                  placeholder="сервис, БД, брокер…"
                />
              ) : (
                node.role || <span className="np-value--empty">не указана</span>
              )}
            </span>

            {/* Технология (не для персон) */}
            {shape !== "person" && (
              <>
                <span className="np-term">Технология</span>
                <span className="np-value">
                  {isContainer ? (
                    // Правила контейнеров: своей технологии нет — агрегированный
                    // список уникальных технологий детей, только чтение.
                    container.loading ? (
                      <span className="np-value--empty">загрузка…</span>
                    ) : container.aggTech !== "" ? (
                      container.aggTech
                    ) : (
                      <span className="np-value--empty">не указана</span>
                    )
                  ) : isArchitect ? (
                    <input
                      className="np-field"
                      value={patch.technology}
                      onChange={(e) => patch.setTechnology(e.target.value)}
                      onBlur={patch.commitTech}
                      placeholder="Python, Kafka, Redis…"
                    />
                  ) : (
                    node.technology || <span className="np-value--empty">не указана</span>
                  )}
                </span>
              </>
            )}

            {/* Описание — последняя строка таблицы свойств */}
            <span className="np-term np-term--top">Описание</span>
            <span className="np-value">
              {isArchitect ? (
                <textarea
                  className="np-field np-fieldarea"
                  value={patch.description}
                  onChange={(e) => patch.setDescription(e.target.value)}
                  onBlur={patch.commitDesc}
                  placeholder="Описание объекта"
                />
              ) : (
                <span style={{ lineHeight: 1.55 }}>
                  {node.description || <span className="np-value--empty">нет описания</span>}
                </span>
              )}
            </span>
          </div>
        </div>

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

        {/* ── Логика (node_docs) ────────────────────────────────── */}
        {(allow.logic || legacyLogic || container.docGroups.length > 0)
          && (isArchitect || node.docs.length > 0 || container.docGroups.length > 0) && (
          <div className="np-card">
            <h3 className="np-card-title">
              Логика
              {/* Точек входа нет вовсе — счётчика нет: «описано 0 из 0» это шум на
                  каждом узле проекта, а не полезное знание. */}
              {entryDocs.length > 0 && (
                <span style={docsCounter}>описано {describedCount} из {entryDocs.length}</span>
              )}
            </h3>
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
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{d.name}</span>
                          <span className={`np-doc-chip np-doc-chip--${d.kind}`}>{KIND_LABEL[d.kind]}</span>
                          {!d.described && <StubMark />}
                          {d.operation && <span style={{ fontSize: 12, color: "#64748b", fontFamily: "ui-monospace, monospace" }}>{d.operation}</span>}
                          <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
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
                              <>
                                <button
                                  type="button"
                                  className="np-doc-group-toggle"
                                  onClick={() => toggleGroup(groupKey)}
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
                              </>
                            )}
                          </Fragment>
                        );
                      })}
                    </div>
                  </>
                )}
                {container.loading && <p className="np-empty">Загрузка данных детей…</p>}
                {!container.loading && node.docs.length === 0 && container.docGroups.length === 0 && (
                  <p className="np-empty">Схемы логики не заданы</p>
                )}
              </>
            ) : node.docs.length === 0 ? (
              <>
                <p className="np-empty">Схемы логики не заданы</p>
                {addLogicMenu}
              </>
            ) : (
              <>
                {legacyLogic && (
                  <p className="np-warn">
                    Схемы логики описывают код сервиса, а у этого объекта его нет — перенесите их на сервис, который с ним работает
                  </p>
                )}
                {/* Свои схемы — группами по видам: разведка приносит сюда двести с
                    лишним строк, и плоский столбец в них нечитаем. На маленьком
                    объекте группы стартуют развёрнутыми. */}
                <NodeDocsList docs={node.docs} onOpen={openDoc} />
                {addLogicMenu}
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
                      <span style={{ fontWeight: 600, fontSize: 13 }}>Спецификация</span>
                      <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
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
                              <>
                                <button
                                  type="button"
                                  className="np-doc-group-toggle"
                                  onClick={() => toggleGroup(groupKey)}
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
                              </>
                            )}
                          </Fragment>
                        );
                      })}
                    </div>
                  </>
                )}
                {container.loading && <p className="np-empty">Загрузка данных детей…</p>}
                {!container.loading && !node.openapi_spec && container.specGroups.length === 0 && (
                  <p className="np-empty">Спецификация не задана</p>
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
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Спецификация</span>
                  <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
                </button>
                {updateSpecBtn}
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
          autoCreate={doc.create}
          initialDocId={doc.docId}
          onCommitOpenapi={doc.child
            ? commitChildOpenapi
            : (value) => { void patch.commitOpenapi(value); }}
          onDocEvent={doc.child ? handleChildDocEvent : handleDocEvent}
          onClose={() => setDoc(null)}
          notice={doc.child ? childSpecConflict : patch.conflict}
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
          initialMode={docsAgent}
          onClose={() => setDocsAgent(null)}
          onApplied={() => {
            // Дозаливка изменила мету доков узла — тянем свежий узел и
            // применяем целиком (обновит секцию «Логика»).
            void nodesApi.get(node.id).then((fresh) => patch.refresh(fresh)).catch(() => {});
          }}
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
          onApplied={() => {
            // Заглушки — те же схемы логики: тянем свежий узел целиком, и секция
            // «Логика» показывает их сразу, вместе со счётчиком «описано N из M».
            void nodesApi.get(node.id).then((fresh) => patch.refresh(fresh)).catch(() => {});
          }}
        />
      )}

      {/* Спека от агента (BYOA, секция «OpenAPI»): скоуп = текущий объект.
          Закрытие после успешного применения — за самой модалкой. */}
      {specAgent && (
        <SpecAgentModal
          nodeId={node.id}
          nodeName={node.name}
          onClose={() => setSpecAgent(false)}
          onApplied={() => {
            // Дозаливка изменила спеку узла — тянем свежий узел и применяем
            // целиком (обновит секцию «OpenAPI»).
            void nodesApi.get(node.id).then((fresh) => patch.refresh(fresh)).catch(() => {});
          }}
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
            // тянем свежий узел (patch.refresh обновляет CAS-базу и значения
            // полей — секции «Логика»/«OpenAPI» пересчитаются) и перезагружаем
            // детей для объединения.
            void nodesApi.get(node.id).then((fresh) => patch.refresh(fresh)).catch(() => {});
            container.reload();
          }}
        />
      )}
    </div>
  );
}

// Счётчик «описано N из M» в заголовке секции «Логика» — знаменателем идут только
// точки входа (операции и воркеры). Метка заглушки «не описана» и подписи видов
// живут в NodeDocsList: список схем и его строки — одна ответственность.
const docsCounter: CSSProperties = {
  marginLeft: 8, fontSize: 12, fontWeight: 500, color: "#64748b",
};

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
    <div className="np-doc-split">
      <button
        type="button"
        className="np-doc-split-main"
        onClick={() => onOpen({ mode: "flowchart", docId: doc.id, child })}
        title={`Открыть схему «${doc.name}»`}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>{doc.name}</span>
        <span className={`np-doc-chip np-doc-chip--${doc.kind}`}>{KIND_LABEL[doc.kind]}</span>
        {!doc.described && <StubMark />}
        {doc.operation && <span style={{ fontSize: 12, color: "#64748b", fontFamily: "ui-monospace, monospace" }}>{doc.operation}</span>}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
      </button>
      <button
        type="button"
        className="np-doc-split-child"
        onClick={() => onNavigateNode(child.id)}
        title={`Перейти к объекту «${child.name}»`}
      >
        от {child.name} →
      </button>
    </div>
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
    <div className="np-doc-split">
      <button
        type="button"
        className="np-doc-split-main"
        onClick={() => onOpen(child)}
        title={`Открыть спецификацию «${child.name}»`}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>Спецификация</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
      </button>
      <button
        type="button"
        className="np-doc-split-child"
        onClick={() => onNavigateNode(child.id)}
        title={`Перейти к объекту «${child.name}»`}
      >
        от {child.name} →
      </button>
    </div>
  );
}

// Строка таблицы связей: компактный read-only-вид. Архитектору клик по строке
// открывает модалку-редактор связи (концы, направление, описание, технология);
// наблюдателю строки не кликабельны. Колонки «Вызывающий»/«Вызываемый» (вместо
// «Направление»/«Объект»): источник и цель связи из direction + other_node
// (outgoing → текущий узел источник, incoming → цель). Чужой узел — ссылка
// (переход), текущий — текст.
function EdgeRow({
  edge,
  nodeName,
  isArchitect,
  onNavigateNode,
  onEdit,
}: {
  edge: NodeEdgeInfo;
  nodeName: string;
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onEdit: (edgeId: string) => void;
}) {
  const isOut = edge.direction === "outgoing";

  // stopPropagation: переход на чужой узел не должен открывать модалку строки
  const otherLink = (
    <button
      className="np-edge-link"
      onClick={(e) => { e.stopPropagation(); onNavigateNode(edge.other_node_id); }}
    >
      {edge.other_node_name}
    </button>
  );
  const selfName = <span className="np-edge-self">{nodeName}</span>;
  const caller = isOut ? selfName : otherLink;
  const callee = isOut ? otherLink : selfName;

  return (
    <tr
      className={isArchitect ? "np-edge-rowclick" : undefined}
      onClick={isArchitect ? () => onEdit(edge.id) : undefined}
      title={isArchitect ? "Редактировать связь" : undefined}
    >
      <td>{caller}</td>
      <td className="np-edge-arrowcol">→</td>
      <td>{callee}</td>
      <td>{edge.label || <span className="np-value--empty">–</span>}</td>
      <td>{edge.technology || <span className="np-value--empty">–</span>}</td>
    </tr>
  );
}

// ── Вспомогательные ─────────────────────────────────────────────────

const SHAPE_LABEL: Record<NodeShape, string> = {
  service: "Сервис",
  database: "База данных",
  broker: "Брокер сообщений",
  person: "Пользователь",
};

// Внешность — относительно контура организации, не системы (спека N2а).
const EXTERNAL_HINT =
  "Внешний — чужой продукт или чужая сторона относительно ОРГАНИЗАЦИИ (SaaS, " +
  "third-party, клиент). Свои сотрудники и свои серверы — внутренние, даже вне " +
  "границы системы: границу системы выражает дерево, а не этот флаг";

const STATUS_ORDER: NodeStatus[] = ["existing", "planned", "deprecated"];

// Порядок типов в выпадашке — от самого частого (сервис) к самому редкому.
const SHAPE_ORDER: NodeShape[] = ["service", "database", "broker", "person"];

function statusDotColor(status: NodeStatus, isExternal: boolean): string {
  if (status === "existing") return isExternal ? "#9ca3af" : "#9ca3af";
  return getNodeColors(isExternal, 0, status).bg;
}

// Глиф формы для шапки страницы (20×20, белый на цветном фоне).
function HeaderGlyph({ shape, container }: { shape: NodeShape; container: boolean }) {
  const c = {
    fill: "none",
    stroke: "#fff",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  let body: React.ReactNode;
  if (container) {
    body = (
      <>
        <rect x={2} y={5} width={16} height={10} rx={2.5} {...c} />
        <path d="M5 5 V3.5 a1.5 1.5 0 0 1 1.5-1.5 h7 A1.5 1.5 0 0 1 15 3.5 V5" {...c} />
      </>
    );
  } else if (shape === "database") {
    body = (
      <>
        <path d="M3 4 v9 a7 2.5 0 0 0 14 0 V4" {...c} />
        <ellipse cx={10} cy={4.2} rx={7} ry={2.4} {...c} />
      </>
    );
  } else if (shape === "broker") {
    body = (
      <>
        <path d="M6 3 h8 a4 7 0 0 1 0 14 h-8 a4 7 0 0 1 0-14 Z" {...c} />
        <path d="M6 3 a4 7 0 0 1 0 14" {...c} />
      </>
    );
  } else if (shape === "person") {
    body = (
      <>
        <circle cx={10} cy={6.5} r={3.2} {...c} />
        <path d="M3.5 17 a 6.5 5.5 0 0 1 13 0" {...c} />
      </>
    );
  } else {
    body = <rect x={2.5} y={3} width={15} height={14} rx={3} {...c} />;
  }
  return <svg width={20} height={20} viewBox="0 0 20 20">{body}</svg>;
}

// Шеврон кнопки-группы (схемы/спеки глубоких потомков): смотрит вниз, когда
// группа раскрыта, и вправо — когда свёрнута (CSS-трансформация).
function GroupChevron({ open }: { open: boolean }) {
  return (
    <span className="np-doc-group-chev" style={{ transform: open ? "none" : "rotate(-90deg)" }}>
      <ChevronDownIcon />
    </span>
  );
}

// ── Секция «Участвует в процессах» ─────────────────────────────────
// Процессы, в которых участвует узел или его поддерево (GET /nodes/{id}/processes).
// Пустая секция скрывается вовсе: участие в процессах — не обязательная мета.
function ProcessesSection({ nodeId, onNavigateProcess }: {
  nodeId: string;
  onNavigateProcess?: (processId: string) => void;
}) {
  const [items, setItems] = useState<ProcessListItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    nodesApi.getNodeProcesses(nodeId)
      .then((ps) => { if (alive) setItems(ps); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [nodeId]);
  if (!items || items.length === 0) return null;
  return (
    <div className="np-card">
      <h3 className="np-card-title">Участвует в процессах</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((p) => (
          <button
            key={p.id}
            className="np-doc-row"
            onClick={() => onNavigateProcess?.(p.id)}
            title={`Открыть процесс «${p.name}»`}
          >
            <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>{p.message_count} {plural(p.message_count, ["сообщение", "сообщения", "сообщений"])}</span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Секция «Схема» (single-schema) ──────────────────────────────────
// Контекст объекта как ВИРТУАЛЬНЫЙ КОРНЕВОЙ УРОВЕНЬ. Бэкенд (context-graph)
// отдаёт его в формате СЫРОГО графа уровня: локалы = фокус + представители
// соседей (связанные сиблинги), рёбра сырые, реестр концов с цепочками предков.
// Раскладка — СОХРАНЁННЫЙ вид фокуса (context-graph отдаёт layout вида node.id +
// его версию; первый вход без записей → свежий ELK). Рендерит штатный level-
// конвейер без единой контекстной ветки; отличия от «отдельного проекта» — только
// рамки реальных предков (ancestorIds) и цвета по реальной глубине (depth).
// Архитектору доступна расстановка (драг + персист в вид фокуса, arrangeOnly);
// структурная правка (создание/удаление) и наблюдатель — read-only, создание
// связей — в редакторе-карте; мета существующих связей (концы, направление,
// описание, технология) правится со страницы модалкой-редактором (EdgeEditModal).
function SchemaSection({
  node,
  ancestors,
  isArchitect,
  onNavigateNode,
  onNavigateMap,
  onNodeChanged,
  viewMeta,
  mutationToken,
}: {
  node: Node;
  ancestors: AncestorRef[];
  isArchitect: boolean;
  onNavigateNode: (id: string) => void;
  onNavigateMap?: (level: string | null, opts?: { locate?: string; ret?: string }) => void;
  // Узел изменён в другой сессии — страница освежает свои данные и показывает
  // тост «Данные обновлены в другой сессии». Зовётся ОБОИМИ курсорами: meta_rev
  // (атрибуты/доки/спеки) и graph_rev (структурные имя/форма, V48).
  onNodeChanged?: () => void;
  // Общий с страницей курсор конкурентности (страница тихо обновляет его после
  // СВОИХ записей — echo-suppression, V53).
  viewMeta: { current: ViewMetaState };
  // Токен мутации страницы (правка связи в EdgeEditModal): изменившиеся стрелки
  // перерисовываются анимированно (окно мутаций, AN28а).
  mutationToken: number;
}) {
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { writeSchemaView(schemaView); }, [schemaView]);

  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Курсоры изменений для remote-sync И fence персиста: context-graph несёт
  // version (вид фокуса) / graph_rev / meta_rev; рефетч обновляет курсоры. Свои
  // записи раскладки (архитектор) обновляют курсор из ответа PUT — поллинг не даёт
  // ложного тоста; чужие правки узла давятся сверкой содержимого в onNodeChanged.
  const metaCursorRef = viewMeta; // алиас: eslint разрешает писать только в *Ref
  // Флаг «идёт жест драга» для поллинга (рефетч не врывается в жест): его же
  // ставит/снимает канвас через бандл персиста (архитектор).
  const gestureActiveRef = useRef(false);
  const [remoteToast, showRemoteToast] = useToast();

  const refetch = useCallback((): Promise<void> => {
    return nodesApi.getContextGraph(node.id)
      .then((g) => {
        metaCursorRef.current = { version: g.version, graphRev: g.graph_rev, metaRev: g.meta_rev };
        setGraph(g);
        setLoading(false);
      })
      .catch(() => { setLoading(false); });
  }, [node.id, metaCursorRef]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка данных схемы
    setLoading(true);
    refetch();
  }, [refetch]);

  // Поллинг удалённых изменений (как в редакторе-карте): graph_rev вырос →
  // тихий рефетч контекста + тост «Схема обновлена в другой сессии»; meta_rev
  // вырос → освежение узла (тост «Данные обновлены» — хозяин страница).
  useRemoteSync({
    currentParentId: null,
    viewMeta: metaCursorRef,
    gestureActiveRef,
    onRemoteChange: () => {
      refetch();
      showRemoteToast();
      // Структурные поля узла (имя/форма) двигают graph_rev, а НЕ meta_rev (V48):
      // без этого зова чужая смена имени/типа перерисовывала схему, а «Свойства»
      // страницы оставались старыми до перезахода. Канал тот же (сверка свежего
      // узла по version+сигнатуре), поэтому лишнего тоста своя правка не даёт.
      onNodeChanged?.();
    },
    onMetaChange: onNodeChanged
      ? (rev) => {
          metaCursorRef.current = { ...metaCursorRef.current, metaRev: rev };
          onNodeChanged();
        }
      : undefined,
  });

  // ── Персист раскладки вида фокуса (архитектор) ────────────────────
  // Зеркало записанных значений: канвас шлёт сохранённые батчи, кладём их в
  // graph.layout — база дедупа/merge остаётся истиной (иначе «драг назад в исходную»
  // гасился бы дедупом о протухшее зеркало). Спред меняет только layout — ссылки
  // nodes/endpoints/edges те же, конвейер раскладки не перезапускается.
  const handleLayoutChanged = useCallback(
    (items: Record<string, ViewLayoutPayload | null>) => {
      setGraph((g) => {
        if (!g) return g;
        // merge поверх зеркала; null-патч — удалить строку (сброс объекта в
        // авто-геометрию). Пересборка через fromEntries — без динамического delete.
        const layout = Object.fromEntries(
          Object.entries({ ...g.layout, ...items })
            .filter((e): e is [string, ViewLayoutPayload] => e[1] !== null),
        );
        return { ...g, layout };
      });
    },
    [],
  );

  // Ресинк при ошибке персиста / перед переигровкой 409: перечитать контекст
  // (курсоры + раскладка к истине). Замок resyncingRef — один inflight на серию.
  const resyncingRef = useRef<Promise<void> | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- оркестрационный колбэк: осознанно plain-function (пересоздаётся каждый рендер), бандл пересобирается с ним — по образу MapEditorPage.
  function resyncOnPersistError(): Promise<void> {
    if (resyncingRef.current) return resyncingRef.current;
    const p = refetch().finally(() => { resyncingRef.current = null; });
    resyncingRef.current = p;
    return p;
  }
  // 409 (вид фокуса изменён другой сессией): ресинк + одноразовая переигровка
  // исходного патча от свежего зеркала (канал retryPatch, по образу MapEditorPage).
  const layoutRetrySeq = useRef(0);
  const [layoutRetry, setLayoutRetry] = useState<{
    patch: Record<string, Partial<ViewLayoutPayload> | null>; token: number;
  } | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- см. resyncOnPersistError.
  function handlePersistConflict(patch: Record<string, Partial<ViewLayoutPayload> | null>) {
    void resyncOnPersistError().then(() => {
      setLayoutRetry({ patch, token: ++layoutRetrySeq.current });
    });
  }

  // Бандл персиста — только архитектору; наблюдателю undefined → блок read-only
  // (без драга), раскрытия стартуют свёрнутыми (ignorePersistedExpanded).
  const persistence = useMemo<LevelPersistenceProps | undefined>(() => {
    if (!isArchitect) return undefined;
    return {
      onLayoutChanged: handleLayoutChanged,
      onPersistError: resyncOnPersistError,
      onPersistConflict: handlePersistConflict,
      retryPatch: layoutRetry,
      viewMeta: metaCursorRef,
      gestureActiveRef,
    };
  }, [isArchitect, handleLayoutChanged, resyncOnPersistError, handlePersistConflict, layoutRetry, metaCursorRef]);

  // «Переразложить»: сброс раскладки вида фокуса → рефетч (свежий ELK). Реф-замок
  // от повторных кликов (relayout идемпотентен, но незачем спамить ресинками).
  const relayoutInflight = useRef(false);
  // Токен свершившегося сброса: блок схемы анимирует переезд на авто-позиции.
  const [relayoutToken, setRelayoutToken] = useState(0);
  const handleRelayout = useCallback(() => {
    if (relayoutInflight.current) return;
    relayoutInflight.current = true;
    nodesApi.relayoutContext(node.id)
      .then(() => { setRelayoutToken((t) => t + 1); refetch(); })
      .finally(() => { relayoutInflight.current = false; });
  }, [node.id, refetch]);

  // ДАННЫЕ СХЕМЫ = ответ сервера + СВОИ правки меты, влитые точечно (withOwnEdits,
  // context.md X20): страница уже держит свежий узел (patch.node — ответ PATCH), и
  // схема показывает новые форму/имя/статус/размещение СРАЗУ, без перезагрузки и без
  // ремаунта холста. Производное — в рендере (useMemo), не эффектом: зеркалирование
  // пропа в стейт разъезжается. Идентичность меняется ровно тогда, когда меняется
  // граф или сам узел (тот же профиль, что у edges ниже).
  const view = useMemo<GraphResponse | null>(
    () => (graph ? withOwnEdits(graph, node) : null),
    [graph, node],
  );

  // Рёбра уровня из GraphResponse (тот же маппинг, что у остальных потребителей
  // графа уровня — pageSchema.toLevelEdges). Мемоизация: toLevelEdges создаёт новый
  // массив при каждом вызове; без мемоизации проп edges менялся бы на каждый рендер
  // (зеркало раскладки меняет только graph.layout, не nodes/endpoints/edges) и
  // пересоздавал computeNow в LevelGraph — конвейер стартовал бы в промежуточном
  // рендере со старым viewLayout, вызывая визуальный откат узла при отпускании драга.
  const edges = useMemo(() => (view ? toLevelEdges(view) : []), [view]);

  if (loading) return <p className="np-empty">Загрузка схемы…</p>;
  if (!view) return null;

  // «Внешних связей нет»: кроме фокуса нет ни локалов-представителей, ни гостей
  // вне его поддерева (глубокие концы внутренних рёбер несут фокус в предках).
  if (hasNoNeighbors(view, node.id) && !node.has_children) {
    // Пустое состояние: секцию не прячем; архитектору — CTA в редактор-карту
    // (наполнить состав / создать связи — правка живёт только там).
    return (
      <div className="np-empty" style={{ textAlign: "center" }}>
        Внешних связей нет — объект пока не взаимодействует с соседями.
        <br />
        <span style={{ fontSize: 12, color: "#b0bec5" }}>Связи создаются в редакторе-карте</span>
        {isArchitect && onNavigateMap && (
          <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "center" }}>
            {canHaveChildren(node.shape) && (
              <button className="esb-edit" onClick={() => onNavigateMap(node.id)}>
                Добавить компонент
              </button>
            )}
            <button
              className="esb-edit"
              onClick={() => onNavigateMap(node.parent_id ?? null, { locate: node.id, ret: `node:${node.id}` })}
            >
              Открыть в карте
            </button>
          </div>
        )}
      </div>
    );
  }

  // Высота до замера ширины: по числу видимых сущностей (локалы + внешние гости).
  const height = schemaSectionHeight(visibleEntityGuess(view));
  // Признак проектный, с сервера: на схеме одного объекта статусов может не быть,
  // а в проекте переход идёт — переключатель вида нужен и здесь. Статусы читаем из
  // view: свежепоставленный «планируется» обязан включить фильтр сразу.
  const hasStatusInfo = showStatusControls(view.has_status_info, view.nodes, view.endpoints);

  // «Редактировать» / «Открыть в карте» → родительский слой + подсветка + возврат (Ф11/Ф12).
  const onEdit = onNavigateMap
    ? () => onNavigateMap(node.parent_id ?? null, { locate: node.id, ret: `node:${node.id}` })
    : undefined;

  return (
    <div style={{ position: "relative" }}>
      {remoteToast && <div style={remoteToastStyle}>Схема обновлена в другой сессии</div>}
      <EmbeddedSchemaBlock
        nodes={view.nodes}
        endpoints={view.endpoints}
        edges={edges}
        viewLayout={view.layout}
        containerId={node.parent_id ?? null}
        layoutViewId={node.id}
        persistence={persistence}
        ancestorNames={ancestors.map((a) => a.name)}
        ancestorIds={ancestors.map((a) => a.id)}
        depth={ancestors.length}
        isArchitect={isArchitect}
        schemaView={schemaView}
        onSchemaViewChange={setSchemaView}
        onNavigateNode={onNavigateNode}
        onEdit={onEdit}
        onRelayout={handleRelayout}
        relayoutToken={relayoutToken}
        mutationToken={mutationToken}
        height={height}
        showViewFilter={hasStatusInfo}
      />
    </div>
  );
}

// Тост «схема обновлена в другой сессии» (remote-sync) — поверх окна схемы.
const remoteToastStyle: CSSProperties = { position: "absolute", top: 12, right: 12, zIndex: 6, background: "#eef2ff", border: "1px solid #c7d2fe", color: "#3730a3", borderRadius: 10, padding: "7px 12px", fontSize: 13, boxShadow: "0 4px 12px rgba(30,41,59,.10)" };
