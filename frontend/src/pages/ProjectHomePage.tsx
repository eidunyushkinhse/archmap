// Страница проекта (корень) — вход в проект открывает её (pages_pivot).
// Редизайн (направление А «Документ»), та же колонка, что у страницы объекта: шапка —
// название, меню ⋯ справа, описание; раздел «Схема» — корневой уровень; раздел
// «Процессы» — строками, без процессов его нет.
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
import { useRemoteSync } from "./useRemoteSync";
import VersionsPanel from "../components/nodePage/versions/VersionsPanel";
import { DocRow, DocRowLabel } from "../components/docRow";
import Section from "../ui/Section";
import { useProjectRole } from "./projectRole";
import "./NodePage.css";
import "../components/EmbeddedSchemaBlock.css";
import "../ui/ds.css";

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
  // причиной и повтором, а не вечная «Загрузка» (аудит R-2).
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
    return <div className="np-loading">Загрузка</div>;
  }
  const [project, processes] = meta.data;

  const graphNodes = lvl.nodes;
  const endpoints = lvl.endpoints;
  const hasNodes = graphNodes.length + endpoints.length > 0;
  // Признак проектный, с сервера: статусы обычно лежат не на корневом уровне.
  const hasStatusInfo = showStatusControls(lvl.hasStatusInfo, graphNodes, endpoints);

  return (
    <div className="np-page ds">
      <div className="np-inner">
        {/* ── Шапка проекта: название, меню ⋯, описание ───────────── */}
        <header className="np-header">
          <div className="np-title-row">
            <h1 className="np-name">{project.name}</h1>
            <div className="np-title-aside">
              <div className="np-menu-wrap">
                <button
                  type="button"
                  className="np-menu-btn"
                  onClick={() => setMenuOpen((o) => !o)}
                  title="Действия"
                  aria-label="Действия"
                  aria-expanded={menuOpen}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <>
                    <div className="np-backdrop" onClick={() => setMenuOpen(false)} />
                    <div className="np-dropdown ds-menu">
                      <button type="button" className="ds-menu-item" onClick={() => { setMenuOpen(false); setVersionsOpen(true); }}>
                        Версии документации
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          {project.description && <p className="np-desc">{project.description}</p>}
        </header>

        {/* ── Схема (корневой уровень) ──────────────────────────── */}
        {/* Пустой проект: в строке заголовка «Редактировать» нет (onEdit не передаём) —
            её место занимает «Начать наполнение» внутри пустого окна, и ведёт она туда
            же, в редактор-карту (решение пользователя 2026-09-05; прежняя «+ Объект» звала
            страницу объекта с пустым id и не делала ничего). Чужая правка схемы: тост
            внутри рамки схемы, его рисует сам блок (notice). */}
        <EmbeddedSchemaBlock
          title="Схема"
          notice={remoteToast ? "Схему только что изменили в другом окне" : null}
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
          showViewFilter={hasStatusInfo}
          onEdit={hasNodes ? () => onNavigateMap?.(null) : undefined}
          empty={
            hasNodes ? undefined : (
              <span>
                Схема пуста
                {isArchitect && (
                  <>
                    <br />
                    <button type="button" className="ds-btn ds-btn--primary esb-empty-act" onClick={() => onNavigateMap?.(null)}>
                      Начать наполнение
                    </button>
                  </>
                )}
              </span>
            )
          }
        />

        {/* ── Процессы ──────────────────────────────────────────── */}
        {processes.length > 0 && (
          <Section title="Процессы">
            <div className="ds-rows">
              {processes.map((p) => (
                <DocRow key={p.id} onOpen={() => onNavigateProcesses?.(p.id)} title={`Открыть процесс «${p.name}»`}>
                  <DocRowLabel name={p.name} />
                </DocRow>
              ))}
            </div>
          </Section>
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

// Тост «Схему только что изменили в другом окне» (remote-sync) рисует блок схемы внутри своей
// рамки (EmbeddedSchemaBlock, notice).
