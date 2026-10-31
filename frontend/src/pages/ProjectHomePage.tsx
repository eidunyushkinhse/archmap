// Страница проекта (корень) — вход в проект открывает её (pages_pivot).
// Шапка: имя, описание, счётчики. Секция «Схема системы» = корневой уровень.
// Секция «Бизнес-процессы» — список со счётчиком участников.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectsApi } from "../api/projects";
import { processesApi } from "../api/processes";
import { nodesApi } from "../api/nodes";
import EmbeddedSchemaBlock from "../components/EmbeddedSchemaBlock";
import type { LevelPersistenceProps, NavigateMap } from "../components/graph/types";
import { readSchemaView, showStatusControls, writeSchemaView, type SchemaView } from "../components/schemaView";
import { useLevelSchema } from "./useLevelSchema";
import { usePersistenceHost } from "./usePersistenceHost";
import { useAsyncLoad } from "../lib/useAsyncLoad";
import LoadError from "../ui/LoadError";
import { useToast } from "./useToast";
import { remoteToastStyle } from "../ui/remoteToast";
import { useRemoteSync } from "./useRemoteSync";
import { projectSchemaHeight } from "../components/pageSchema";
import { plural } from "../ui/plural";
import VersionsPanel from "../components/nodePage/versions/VersionsPanel";
import { useProjectRole } from "./projectRole";
import "./NodePage.css";
import "../ui/smallButton.css";

interface Props {
  projectId: string;
  isArchitect: boolean;
  onNavigateNode: (nodeId: string) => void;
  // «Редактировать» над схемой → редактор-карта на корневом уровне
  onNavigateMap?: NavigateMap;
  // Клик по процессу в списке → режим «Процессы» с выбором процесса
  onNavigateProcesses?: (processId: string) => void;
}

export default function ProjectHomePage({ projectId, isArchitect, onNavigateNode, onNavigateMap, onNavigateProcesses }: Props) {
  // Мета проекта + процессы (граф уровня грузит useLevelSchema). Отказ — экран с
  // причиной и повтором, а не вечная «Загрузка…» (аудит R-2).
  const meta = useAsyncLoad(projectId, () => Promise.all([projectsApi.get(projectId), processesApi.list()]));
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);
  const lvl = useLevelSchema({ containerId: null });
  // ⋯-меню проекта и панель «Версии документации» всего проекта: страница проекта —
  // корень дерева, его версии ловят и то, что появляется на верхнем уровне
  // (docs/tasks/doc-versions.md §2). Права — как на странице объекта.
  const [menuOpen, setMenuOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const isOwner = useProjectRole() === "owner";

  useEffect(() => { writeSchemaView(schemaView); }, [schemaView]);

  // Поллинг удалённых изменений (как в редакторе-карте): graph_rev вырос →
  // перезагрузка уровня + тост. Собственные записи (драг архитектора) курсор
  // обновляют из ответов PUT — echo-suppression, ложных тостов нет.
  const [remoteToast, showRemoteToast] = useToast();
  useRemoteSync({
    currentParentId: null,
    viewMeta: lvl.viewMetaRef,
    gestureActiveRef: lvl.gestureActiveRef,
    onRemoteChange: () => {
      void lvl.reload();
      showRemoteToast();
    },
  });

  // ── Персист раскладки корневого уровня (архитектор) ────────────────
  // Корень — тот же level-конвейер, что и страница объекта: архитектору доступна
  // расстановка (драг + запись вида view_id=null), наблюдателю — read-only.
  // Зеркало записанных батчей держит useLevelSchema (mergeLayout). Ресинк при
  // ошибке персиста и переигровка 409 (корневой вид изменён другой сессией) —
  // перезагрузка уровня из БД.
  const host = usePersistenceHost(lvl.reload);

  // Бандл персиста — только архитектору; наблюдателю undefined → блок read-only
  // (без драга), раскрытия стартуют свёрнутыми (ignorePersistedExpanded).
  // layoutViewId НЕ задаём: корень персистится в вид view_id=null (containerId=null).
  const persistence = useMemo<LevelPersistenceProps | undefined>(() => {
    if (!isArchitect) return undefined;
    return {
      onLayoutChanged: lvl.mergeLayout,
      onPersistError: host.resync,
      onPersistConflict: host.onConflict,
      retryPatch: host.retryPatch,
      viewMeta: lvl.viewMetaRef,
      gestureActiveRef: lvl.gestureActiveRef,
    };
  }, [isArchitect, lvl.mergeLayout, lvl.viewMetaRef, lvl.gestureActiveRef, host.resync, host.onConflict, host.retryPatch]);

  // «Переразложить»: сброс раскладки корневого уровня → перезагрузка (свежий ELK).
  // Реф-замок от повторных кликов (relayout идемпотентен, но незачем спамить).
  const relayoutInflight = useRef(false);
  // Токен свершившегося сброса: блок схемы анимирует переезд на авто-позиции.
  const [relayoutToken, setRelayoutToken] = useState(0);
  const handleRelayout = useCallback(() => {
    if (relayoutInflight.current) return;
    relayoutInflight.current = true;
    nodesApi.relayoutLevel(null)
      .then(() => { setRelayoutToken((t) => t + 1); return lvl.reload(); })
      .finally(() => { relayoutInflight.current = false; });
  }, [lvl]);

  const loadFailure = meta.error ?? lvl.error;
  if (loadFailure) {
    return (
      <LoadError what="проект" error={loadFailure} onRetry={() => {
        if (meta.error) meta.reload();
        if (lvl.error) lvl.retry();
      }} />
    );
  }
  if (!meta.data || lvl.loading) {
    return <div className="np-loading">Загрузка…</div>;
  }
  const [project, processes] = meta.data;

  const graphNodes = lvl.nodes;
  const endpoints = lvl.endpoints;
  const hasNodes = graphNodes.length + endpoints.length > 0;
  // Признак проектный, с сервера: статусы обычно лежат не на корневом уровне.
  const hasStatusInfo = showStatusControls(lvl.hasStatusInfo, graphNodes, endpoints);
  const height = projectSchemaHeight(graphNodes.length);

  return (
    <div className="np-page">
      <div className="np-inner">
        {/* ── Шапка проекта ─────────────────────────────────────── */}
        <div className="np-header">
          <div className="np-breadcrumb">
            <span style={{ color: "#0f172a", fontWeight: 600 }}>Проект</span>
          </div>
          <div className="np-title-row">
            <span className="np-glyph" style={{ background: "#2563eb" }}>
              <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <rect x={2.5} y={3} width={15} height={14} rx={3} />
                <path d="M2.5 7h15" />
              </svg>
            </span>
            <span className="np-name">{project.name}</span>
            <div className="np-menu-wrap">
              <button className="np-menu-btn" onClick={() => setMenuOpen((o) => !o)} title="Действия">
                ⋯
              </button>
              {menuOpen && (
                <>
                  <div className="np-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="np-dropdown">
                    <button onClick={() => { setMenuOpen(false); setVersionsOpen(true); }}>
                      Версии документации
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          {project.description && (
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "#475569", lineHeight: 1.55, maxWidth: 640 }}>
              {project.description}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <span className="np-count-chip">{project.object_count} {plural(project.object_count, ["объект", "объекта", "объектов"])}</span>
            <span className="np-count-chip">{project.edge_count} {plural(project.edge_count, ["связь", "связи", "связей"])}</span>
            <span className="np-count-chip">{processes.length} {plural(processes.length, ["процесс", "процесса", "процессов"])}</span>
          </div>
        </div>

        {/* ── Схема системы ─────────────────────────────────────── */}
        <div className="np-card">
          <h3 className="np-card-title">Схема системы</h3>
          <div style={{ position: "relative" }}>
            {remoteToast && <div style={remoteToastStyle}>Схема обновлена в другой сессии</div>}
            {/* Пустой проект: над окном схемы кнопки «Редактировать» нет (onEdit не
                передаём) — её место занимает «Начать наполнение» внутри пустого окна,
                и ведёт она туда же, в редактор-карту (решение пользователя 2026-09-05;
                прежняя «+ Объект» звала страницу объекта с пустым id и не делала ничего). */}
            <EmbeddedSchemaBlock
            nodes={graphNodes}
            endpoints={endpoints}
            edges={lvl.edges}
            viewLayout={lvl.viewLayout}
            containerId={null}
            persistence={persistence}
            ancestorNames={[]}
            ancestorIds={[]}
            ancestorElements={[]}
            depth={0}
            isArchitect={isArchitect}
            schemaView={schemaView}
            onSchemaViewChange={setSchemaView}
            onNavigateNode={onNavigateNode}
            onRelayout={handleRelayout}
            relayoutToken={relayoutToken}
            height={height}
            toolbarHint={hasNodes ? `корневой уровень · ${graphNodes.length} ${plural(graphNodes.length, ["объект", "объекта", "объектов"])}` : undefined}
            showViewFilter={hasStatusInfo}
            onEdit={hasNodes ? () => onNavigateMap?.(null) : undefined}
            empty={
              hasNodes ? undefined : (
                <span>
                  Схема пуста
                  {isArchitect && (
                    <>
                      <br />
                      <button className="btn-sm-primary" style={{ marginTop: 10 }} onClick={() => onNavigateMap?.(null)}>
                        Начать наполнение
                      </button>
                    </>
                  )}
                </span>
              )
            }
            />
          </div>
        </div>

        {/* ── Бизнес-процессы ───────────────────────────────────── */}
        {processes.length > 0 && (
          <div className="np-card">
            <h3 className="np-card-title">Бизнес-процессы</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {processes.map((p) => (
                <button
                  key={p.id}
                  className="np-doc-row"
                  onClick={() => onNavigateProcesses?.(p.id)}
                  title={`Открыть процесс «${p.name}»`}
                >
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="12" r="2.4" /><circle cx="6" cy="18" r="2.4" />
                    <path d="M8.4 6 H13 a2.6 2.6 0 0 1 2.6 2.6 V9.6 M8.4 18 H13 a2.6 2.6 0 0 0 2.6-2.6 V14.4" />
                  </svg>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                  <span style={{ color: "#94a3b8", fontSize: 12 }}>
                    {p.message_count} {plural(p.message_count, ["сообщение", "сообщения", "сообщений"])}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>открыть →</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {versionsOpen && (
        <VersionsPanel
          nodeId={null}
          title={project.name}
          canEdit={isArchitect}
          canDelete={isOwner}
          onClose={() => setVersionsOpen(false)}
          // Откат среза всего проекта: мета со счётчиками и процессами и уровень
          // перечитываются сразу, поллинг догнал бы их только через секунды.
          onRestored={() => { meta.reload(); void lvl.reload(); }}
        />
      )}
    </div>
  );
}

// Тост «схема обновлена в другой сессии» (remote-sync) — поверх окна схемы.
