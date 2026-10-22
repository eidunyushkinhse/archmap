// Панель «Версии документации» объекта или всего проекта (docs/tasks/doc-versions.md §7;
// прототип — вкладка «2 · Версии документации», принят пользователем). Один экран за
// раз: список версий → что изменилось в версии → одна дельта с переключателем
// «Изменения · Было · Стало». Первая редакция «всё на одном экране» была отвергнута,
// поэтому здесь нет чипов, счётчиков и подсказок сверх прототипа.
//
// Окно поверх страницы (ui/Modal): закрывают Escape и крестик. Окно фиксации и
// подтверждения удаления и отката — СИБЛИНГИ панели, а не её потомки: вложенный
// <dialog> получает всплывший cancel и закрывал бы родителя вместе с собой.
//
// Откат (§5, §7): перед окном — запрос «что сделает откат» (сохранится ли
// незафиксированное, сколько объектов удалится, есть ли процессы); окно открывается по
// ответу. После отката — список, а замечания (что вернуть не удалось) тихой строкой над
// ним до следующего действия.
import { useRef, useState } from "react";
import Modal from "../../../ui/Modal";
import ConfirmDialog from "../../../ui/ConfirmDialog";
import LoadError from "../../../ui/LoadError";
import { loadErrorText } from "../../../ui/loadErrorText";
import { plural } from "../../../ui/plural";
import { versionsApi } from "../../../api/versions";
import type { VersionBase } from "../../../api/versions";
import type { RestorePreview, VersionItem, VersionList, VersionOut } from "../../../types";
import { useVersionList } from "./useVersions";
import { changesPhrase, remarksLine, restoreLead, versionMeta } from "./versionText";
import FixVersionDialog from "./FixVersionDialog";
import VersionScreen from "./VersionScreen";
import type { SideLabels } from "./VersionScreen";
import ItemScreen from "./ItemScreen";
import "./versions.css";
import "../../../ui/smallButton.css";

interface Props {
  // null — весь проект: страница проекта — корень дерева.
  nodeId: string | null;
  // Имя объекта или проекта — в шапке и в окне фиксации.
  title: string;
  // Фиксация и откат — редактору; читателю строки «Есть изменения…» и кнопки отката нет.
  canEdit: boolean;
  // Удаление версии — только владельцу проекта.
  canDelete: boolean;
  onClose: () => void;
  // Откат применён: страница под панелью перечитывает документацию сама — поллинг
  // догнал бы её лишь через секунды и с тостом «в другой сессии».
  onRestored?: () => void;
}

type Screen =
  | { kind: "list" }
  | { kind: "version"; num: number; base: VersionBase }
  | { kind: "item"; num: number; base: VersionBase; item: VersionItem; labels: SideLabels };

// Подготовка отката версии num: идёт запрос «что сделает откат» или он не удался.
interface RestorePrep {
  num: number;
  failed: boolean;
  error: unknown;
}

export default function VersionsPanel({ nodeId, title, canEdit, canDelete, onClose, onRestored }: Props) {
  const list = useVersionList(nodeId);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [fixOpen, setFixOpen] = useState(false);
  // Номер версии под подтверждением удаления и его состояние.
  const [deleting, setDeleting] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Откат: подготовка, окно (версия и ответ превью), его состояние, замечания итога.
  const [restorePrep, setRestorePrep] = useState<RestorePrep | null>(null);
  const [restoring, setRestoring] = useState<{ version: VersionOut; preview: RestorePreview } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [remarks, setRemarks] = useState<string[]>([]);
  // Номер текущей подготовки: ответ, пришедший после ухода с экрана версии (или после
  // новой подготовки), окна не открывает.
  const prepSeq = useRef(0);

  const data = list.data;
  const latest = data && data.versions.length > 0 ? data.versions[0].number : null;

  // Переход между экранами — «следующее действие»: замечания отката и подготовка гаснут.
  function go(next: Screen) {
    prepSeq.current += 1;
    setRestorePrep(null);
    setRemarks([]);
    setScreen(next);
  }

  function openRestore(version: VersionOut) {
    const seq = ++prepSeq.current;
    setRestorePrep({ num: version.number, failed: false, error: null });
    versionsApi.restorePreview(nodeId, version.number).then(
      (preview) => {
        if (seq !== prepSeq.current) return;
        setRestorePrep(null);
        setRestoreError(null);
        setRestoring({ version, preview });
      },
      (e: unknown) => {
        if (seq !== prepSeq.current) return;
        setRestorePrep({ num: version.number, failed: true, error: e });
      },
    );
  }

  function confirmRestore() {
    if (restoring === null) return;
    setRestoreBusy(true);
    setRestoreError(null);
    versionsApi.restore(nodeId, restoring.version.number).then(
      (out) => {
        setRestoring(null);
        setRestoreBusy(false);
        go({ kind: "list" });
        setRemarks(out.remarks);
        list.reload();
        onRestored?.();
      },
      (e: unknown) => {
        // 409 (предел демо) и 422 («нечего восстанавливать») — текстом сервера в окне.
        setRestoreError(loadErrorText(e));
        setRestoreBusy(false);
      },
    );
  }

  function confirmDelete() {
    if (deleting === null) return;
    setDeleteBusy(true);
    setDeleteError(null);
    versionsApi.remove(nodeId, deleting).then(
      () => {
        setDeleting(null);
        setDeleteBusy(false);
        go({ kind: "list" });
        list.reload();
      },
      (e: unknown) => {
        setDeleteError(loadErrorText(e));
        setDeleteBusy(false);
      },
    );
  }

  return (
    <>
      <Modal onClose={onClose} boxStyle={{ width: 680, padding: 0 }}>
        <div className="vp-panel">
          {data === null ? (
            <>
              <div className="vp-head">
                <span className="vp-title">Версии · {title}</span>
              </div>
              <div className="vp-body">
                {list.error
                  ? <LoadError what="версии" error={list.error} onRetry={list.reload} />
                  : <p className="vp-empty vp-note">Загрузка…</p>}
              </div>
            </>
          ) : (
            <PanelScreen
              screen={screen}
              data={data}
              nodeId={nodeId}
              title={title}
              canEdit={canEdit}
              canDelete={canDelete}
              restorePrep={restorePrep}
              remarks={remarks}
              onScreen={go}
              onFix={() => { setRemarks([]); setFixOpen(true); }}
              onRestore={openRestore}
              onDelete={(num) => { setDeleteError(null); setDeleting(num); }}
            />
          )}
        </div>
      </Modal>

      {fixOpen && data && (
        <FixVersionDialog
          nodeId={nodeId}
          lead={`${title} · ${latest === null ? "первая версия" : changesPhrase(latest, data.pending.items)}`}
          onClose={() => setFixOpen(false)}
          onDone={() => {
            setFixOpen(false);
            go({ kind: "list" });
            list.reload();
          }}
        />
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={`Удалить версию ${deleting}?`}
          lead="Остальные номера не меняются"
          confirmLabel="Удалить"
          busyLabel="Удаление…"
          busy={deleteBusy}
          error={deleteError}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}

      {restoring !== null && (
        <ConfirmDialog
          title={`Восстановить версию ${restoring.version.number}?`}
          lead={restoreLead(title, restoring.version, restoring.preview)}
          confirmLabel="Восстановить"
          busyLabel="Восстановление…"
          busy={restoreBusy}
          error={restoreError}
          onConfirm={confirmRestore}
          onCancel={() => setRestoring(null)}
        />
      )}
    </>
  );
}

// Выбор экрана по состоянию панели. Версию ищем в загруженном списке: её могли удалить
// в другой сессии — тогда честнее показать список, чем пустой экран.
function PanelScreen({
  screen, data, nodeId, title, canEdit, canDelete, restorePrep, remarks, onScreen, onFix, onRestore, onDelete,
}: {
  screen: Screen;
  data: VersionList;
  nodeId: string | null;
  title: string;
  canEdit: boolean;
  canDelete: boolean;
  restorePrep: RestorePrep | null;
  remarks: string[];
  onScreen: (s: Screen) => void;
  onFix: () => void;
  onRestore: (version: VersionOut) => void;
  onDelete: (num: number) => void;
}) {
  const version = screen.kind === "list" ? undefined : data.versions.find((v) => v.number === screen.num);
  if (screen.kind === "list" || !version) {
    return (
      <ListScreen
        title={title}
        data={data}
        canEdit={canEdit}
        remarks={remarks}
        onFix={onFix}
        onOpen={(num) => onScreen({ kind: "version", num, base: "prev" })}
      />
    );
  }
  if (screen.kind === "version") {
    // Нечего восстанавливать: версия последняя, и с неё ничего не менялось.
    const nothing = data.versions[0].number === version.number && !data.pending.changed;
    const prep = restorePrep !== null && restorePrep.num === version.number ? restorePrep : null;
    return (
      <VersionScreen
        nodeId={nodeId}
        version={version}
        prevNum={previousNumber(data.versions, version.number)}
        base={screen.base}
        restore={canEdit ? {
          disabled: nothing,
          busy: prep !== null && !prep.failed,
          error: prep?.failed ? prep.error : null,
          onRestore: () => onRestore(version),
        } : null}
        canDelete={canDelete}
        onBack={() => onScreen({ kind: "list" })}
        onBase={(base) => onScreen({ kind: "version", num: version.number, base })}
        onItem={(item, labels) => onScreen({ kind: "item", num: version.number, base: screen.base, item, labels })}
        onDelete={() => onDelete(version.number)}
      />
    );
  }
  return (
    <ItemScreen
      nodeId={nodeId}
      num={screen.num}
      base={screen.base}
      item={screen.item}
      labels={screen.labels}
      onBack={() => onScreen({ kind: "version", num: screen.num, base: screen.base })}
    />
  );
}

// Предыдущая версия — наибольший меньший номер (номера после удаления идут с пропуском);
// нет её — первая версия, сравнение «с предыдущей» идёт с пустым срезом.
function previousNumber(versions: VersionOut[], num: number): number | null {
  let prev: number | null = null;
  for (const v of versions) {
    if (v.number < num && (prev === null || v.number > prev)) prev = v.number;
  }
  return prev;
}

// ── Экран «список» ───────────────────────────────────────────────────────────

function ListScreen({ title, data, canEdit, remarks, onFix, onOpen }: {
  title: string;
  data: VersionList;
  canEdit: boolean;
  // Замечания только что выполненного отката: что вернуть не удалось.
  remarks: string[];
  onFix: () => void;
  onOpen: (num: number) => void;
}) {
  const { versions, pending } = data;
  const latest = versions.length > 0 ? versions[0].number : null;
  return (
    <>
      <div className="vp-head">
        <span className="vp-title">Версии · {title}</span>
        <span className="vp-spacer" />
        {versions.length > 0 && (
          <span className="vp-meta">{versions.length} {plural(versions.length, ["версия", "версии", "версий"])}</span>
        )}
      </div>
      <div className="vp-body">
        {remarks.length > 0 && <p className="vp-remarks vp-note" role="status">{remarksLine(remarks)}</p>}
        {canEdit && (
          <div className="vp-pending">
            <span className="vp-pending-text">{pendingLine(latest, pending)}</span>
            <button type="button" className="btn-sm-primary" disabled={!pending.changed} onClick={onFix}>
              Зафиксировать версию
            </button>
          </div>
        )}
        {versions.map((v) => (
          <button key={v.number} type="button" className="vp-row" onClick={() => onOpen(v.number)}>
            <span className="vp-row-n">v{v.number}</span>
            {/* Автоматические версии (перед откатом, откат) — обычным весом, без чипов. */}
            <span className={v.kind === "manual" ? "vp-row-c" : "vp-row-c vp-row-c--auto"}>{v.comment}</span>
            <span className="vp-meta">{versionMeta(v)}</span>
          </button>
        ))}
        {/* У редактора «Версий ещё нет» уже сказано строкой над списком. */}
        {versions.length === 0 && !canEdit && <p className="vp-empty vp-note">Версий ещё нет</p>}
      </div>
    </>
  );
}

function pendingLine(latest: number | null, pending: VersionList["pending"]): string {
  if (latest === null) return "Версий ещё нет";
  if (!pending.changed) return `Изменений с v${latest} нет`;
  return `Есть ${changesPhrase(latest, pending.items)}`;
}
