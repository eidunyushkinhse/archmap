// Окно «Версии» документации объекта или всего проекта (docs/tasks/doc-versions.md §7).
// Один экран за раз: список версий → что изменилось в версии → один элемент дельты с
// вкладками «Изменения», «Было», «Стало». Первая редакция «всё на одном экране» была
// отвергнута, поэтому здесь нет чипов, счётчиков и подсказок сверх прототипа.
//
// Вид (редизайн, фаза 9ж): каркас окна нового языка (ui/ds.css, ds-win) шириной 680,
// прижатый к верху экрана (ds-win--top): высота меняется от экрана к экрану, а верх и
// поля остаются на месте. Шапку каждого экрана рисует ScreenHead, прокручивается тело.
// Имя объекта (проп title) в шапку не идёт: окно открыто с его страницы; оно нужно
// пояснению отката.
//
// Окно поверх страницы (ui/Modal): закрывают Escape и крестик. Окно фиксации и
// подтверждения удаления и отката — СИБЛИНГИ окна, а не его потомки: вложенный
// <dialog> получает всплывший cancel и закрывал бы родителя вместе с собой.
//
// Откат (§5, §7): перед окном — запрос «что сделает откат» (сохранится ли
// незафиксированное, сколько объектов удалится, есть ли процессы); окно открывается по
// ответу. После отката — список, а замечания (что вернуть не удалось) строкой
// предупреждения над ним до следующего действия.
import { useRef, useState } from "react";
import Modal from "../../../ui/Modal";
import ConfirmDialog from "../../../ui/ConfirmDialog";
import LoadError from "../../../ui/LoadError";
import { loadErrorText } from "../../../ui/loadErrorText";
import { versionsApi } from "../../../api/versions";
import type { VersionBase } from "../../../api/versions";
import type { RestorePreview, VersionItem, VersionList, VersionOut } from "../../../types";
import { useVersionList } from "./useVersions";
import { changesPhrase, fixLead, remarksLine, restoreLead, versionDate } from "./versionText";
import FixVersionDialog from "./FixVersionDialog";
import VersionScreen from "./VersionScreen";
import type { SideLabels } from "./VersionScreen";
import ItemScreen from "./ItemScreen";
import ScreenHead from "./ScreenHead";
import "../../../ui/ds.css";
import "./versions.css";

interface Props {
  // null — весь проект: страница проекта — корень дерева.
  nodeId: string | null;
  // Имя объекта или проекта — в пояснении отката.
  title: string;
  // Фиксация и откат — редактору; читателю строки «Есть изменения…» и кнопки отката нет.
  canEdit: boolean;
  // Удаление версии — только владельцу проекта.
  canDelete: boolean;
  onClose: () => void;
  // Откат применён: страница под окном перечитывает документацию сама — поллинг
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
      <Modal onClose={onClose} boxStyle={{ width: 680, padding: 0, margin: "8vh auto auto" }}>
        <div className="ds ds-win ds-win--top">
          {data === null ? (
            <>
              <ScreenHead title="Версии" onClose={onClose} />
              <div className="ds-win-body">
                {list.error
                  ? <LoadError what="версии" error={list.error} onRetry={list.reload} />
                  : <p className="ds-empty vp-flat">Загрузка</p>}
              </div>
            </>
          ) : (
            <PanelScreen
              screen={screen}
              data={data}
              nodeId={nodeId}
              canEdit={canEdit}
              canDelete={canDelete}
              restorePrep={restorePrep}
              remarks={remarks}
              onScreen={go}
              onFix={() => { setRemarks([]); setFixOpen(true); }}
              onRestore={openRestore}
              onDelete={(num) => { setDeleteError(null); setDeleting(num); }}
              onClose={onClose}
            />
          )}
        </div>
      </Modal>

      {fixOpen && data && (
        <FixVersionDialog
          nodeId={nodeId}
          lead={fixLead(latest, data.pending.items)}
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
          busyLabel="Удаляем"
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
          busyLabel="Восстанавливаем"
          busy={restoreBusy}
          error={restoreError}
          onConfirm={confirmRestore}
          onCancel={() => setRestoring(null)}
        />
      )}
    </>
  );
}

// Выбор экрана по состоянию окна. Версию ищем в загруженном списке: её могли удалить
// в другой сессии — тогда честнее показать список, чем пустой экран.
function PanelScreen({
  screen, data, nodeId, canEdit, canDelete, restorePrep, remarks, onScreen, onFix, onRestore, onDelete, onClose,
}: {
  screen: Screen;
  data: VersionList;
  nodeId: string | null;
  canEdit: boolean;
  canDelete: boolean;
  restorePrep: RestorePrep | null;
  remarks: string[];
  onScreen: (s: Screen) => void;
  onFix: () => void;
  onRestore: (version: VersionOut) => void;
  onDelete: (num: number) => void;
  onClose: () => void;
}) {
  const version = screen.kind === "list" ? undefined : data.versions.find((v) => v.number === screen.num);
  if (screen.kind === "list" || !version) {
    return (
      <ListScreen
        data={data}
        canEdit={canEdit}
        remarks={remarks}
        onFix={onFix}
        onOpen={(num) => onScreen({ kind: "version", num, base: "prev" })}
        onClose={onClose}
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
        onClose={onClose}
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
      onClose={onClose}
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
// Строка состояния первым абзацем (только у редактора), замечания отката, строки версий
// и «Зафиксировать версию» в подвале (только у редактора). Строка версии — одна
// кнопка: номер, комментарий, автор и дата; автор и дата — своими колонками на одной
// вертикали во всех строках (общая сетка списка, versions.css).

function ListScreen({ data, canEdit, remarks, onFix, onOpen, onClose }: {
  data: VersionList;
  canEdit: boolean;
  // Замечания только что выполненного отката: что вернуть не удалось.
  remarks: string[];
  onFix: () => void;
  onOpen: (num: number) => void;
  onClose: () => void;
}) {
  const { versions, pending } = data;
  const latest = versions.length > 0 ? versions[0].number : null;
  // «Версий ещё нет» и «Изменений с vN нет» — тихо, «Есть изменения…» — основным цветом.
  const quiet = latest === null || !pending.changed;
  return (
    <>
      <ScreenHead title="Версии" onClose={onClose} />
      <div className="ds-win-body">
        {canEdit && (
          <p className={"vp-status" + (quiet ? " vp-status--quiet" : "")}>{pendingLine(latest, pending)}</p>
        )}
        {remarks.length > 0 && <p className="ds-warn vp-flat" role="status">{remarksLine(remarks)}</p>}
        {versions.length > 0 && (
          <div className="vp-rows">
            {versions.map((v) => (
              <button key={v.number} type="button" className="vp-row" onClick={() => onOpen(v.number)}>
                <span className="vp-row-n">v{v.number}</span>
                {/* Автоматические версии (перед откатом, откат) — тихим цветом, без чипов. */}
                <span className={v.kind === "manual" ? "vp-row-c" : "vp-row-c vp-row-c--auto"} title={v.comment}>
                  {v.comment}
                </span>
                {/* Автора удалили — прочерк: история остаётся без автора. */}
                <span className="vp-row-a">{v.author ?? "—"}</span>
                <span className="vp-row-d">{versionDate(v.created_at)}</span>
              </button>
            ))}
          </div>
        )}
        {/* У редактора «Версий ещё нет» уже сказано строкой состояния. */}
        {versions.length === 0 && !canEdit && <p className="ds-empty vp-flat">Версий ещё нет</p>}
      </div>
      {canEdit && (
        <div className="ds-win-foot">
          <button type="button" className="ds-btn ds-btn--primary" disabled={!pending.changed} onClick={onFix}>
            Зафиксировать версию
          </button>
        </div>
      )}
    </>
  );
}

function pendingLine(latest: number | null, pending: VersionList["pending"]): string {
  if (latest === null) return "Версий ещё нет";
  if (!pending.changed) return `Изменений с v${latest} нет`;
  return `Есть ${changesPhrase(latest, pending.items)}`;
}
