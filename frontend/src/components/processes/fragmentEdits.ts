import { processesApi } from "../../api/processes";
import type { BranchIn, FragmentKind } from "../../types";
import type { ProcessEditCtx } from "./editCtx";
import { orderedBranches } from "./sequence/fromDetail";
import { newBranchRow } from "./sequence/layout";
import type { OverlayOf } from "./useOverlayStack";

// Правки фрагментов процесса (аудит F-2): создание, охват, ветви «иначе», удаление —
// каждая с командой истории. Зовётся на каждом рендере холста: замыкания видят свежий
// процесс, как и раньше, когда функции жили в теле ProcessCanvas.
export function fragmentEdits({ id, proc, hist, overlays }: ProcessEditCtx) {
  const { detail, sortedMessages, fragById, setOptimistic, runMutation } = proc;
  const closeOverlay = overlays.close;

  async function createFragment(kind: FragmentKind, fromRow: number, toRow: number, guard: string) {
    if (!detail) return;
    const sorted = sortedMessages;
    if (fromRow < 0 || toRow >= sorted.length || fromRow > toRow) return;
    const payload = {
      kind, from_order: sorted[fromRow].order, to_order: sorted[toRow].order, guard: guard.trim() || null, branches: [],
    };
    await runMutation(async () => {
      const created = await processesApi.addFragment(id, payload);
      let fid = created.id;
      hist.push({
        label: "Добавление фрагмента",
        undo: () => processesApi.removeFragment(id, fid),
        redo: async () => {
          const r = await processesApi.addFragment(id, payload);
          fid = r.id;
        },
      });
      closeOverlay("frag");
    }, "Не удалось добавить фрагмент");
  }
  // Правка охвата фрагмента протягиванием грани. Диаграмма отдаёт индексы СТРОК —
  // переводим их в order сообщений (фрагмент хранит диапазон позиций, как и при
  // создании). Границы держит бэк: from_order ≤ to_order.
  async function resizeFragment(fid: string, fromRow: number, toRow: number) {
    if (!detail) return;
    const frag = fragById.get(fid);
    if (!frag) return;
    const sorted = sortedMessages;
    if (fromRow < 0 || toRow >= sorted.length || fromRow > toRow) return;
    const next = { from_order: sorted[fromRow].order, to_order: sorted[toRow].order };
    const prev = { from_order: frag.from_order, to_order: frag.to_order };
    // Оптимистично: рамка остаётся на новом месте, не мигая обратно до ответа.
    setOptimistic({
      ...detail,
      fragments: detail.fragments.map((x) => (x.id === fid ? { ...x, ...next } : x)),
    });
    await runMutation(async () => {
      await processesApi.updateFragment(id, fid, next);
      hist.push({
        label: "Охват фрагмента",
        undo: async () => { await processesApi.updateFragment(id, fid, prev); },
        redo: async () => { await processesApi.updateFragment(id, fid, next); },
      });
    }, "Не удалось изменить охват фрагмента");
  }

  // Общая запись правки ветвей: и границы, и условия, и снятие. Ветви правятся
  // ЦЕЛИКОМ одним списком — тогда откат возвращает набор разом (иначе undo половинчатый).
  async function patchBranches(fid: string, branches: BranchIn[]) {
    if (!detail) return;
    const frag = fragById.get(fid);
    if (!frag) return;
    // Единственная точка записи — здесь же держим порядок: бэк требует строго
    // возрастающих границ, а новая ветвь не обязана быть последней.
    const next = orderedBranches(branches);
    const prev = frag.branches.map((b) => ({ start_order: b.start_order, guard: b.guard }));
    setOptimistic({
      ...detail,
      fragments: detail.fragments.map((x) =>
        x.id === fid ? { ...x, branches: next.map((b) => ({ start_order: b.start_order, guard: b.guard ?? null })) } : x,
      ),
    });
    await runMutation(async () => {
      await processesApi.updateFragment(id, fid, { branches: next });
      hist.push({
        label: "Ветки «иначе»",
        undo: async () => { await processesApi.updateFragment(id, fid, { branches: prev }); },
        redo: async () => { await processesApi.updateFragment(id, fid, { branches: next }); },
      });
    }, "Не удалось изменить ветки «иначе»");
  }

  // Перенос границы ветви: строка → order (как и у охвата). Остальные ветви на месте.
  async function moveBranch(fid: string, index: number, row: number) {
    if (!detail) return;
    const frag = fragById.get(fid);
    if (!frag || index < 0 || index >= frag.branches.length) return;
    const sorted = sortedMessages;
    if (row < 0 || row >= sorted.length) return;
    await patchBranches(
      fid,
      frag.branches.map((b, k) => (k === index ? { ...b, start_order: sorted[row].order } : b)),
    );
  }

  // Сохранение карточки: заводим НОВУЮ ветвь (index=null — границу ставим сами) либо
  // правим условие существующей.
  async function saveBranch(edit: OverlayOf<"branch">) {
    if (!detail) return;
    const frag = fragById.get(edit.fid);
    if (!frag) return;
    const sorted = sortedMessages;
    // Строка = число сообщений с меньшим order — ровно как в проекции диаграммы
    // (fromDetail). findIndex здесь врал бы: order удалённого сообщения дал бы −1.
    const rowOf = (order: number) => sorted.filter((m) => m.order < order).length;
    const guard = edit.guard.trim() || null;
    if (edit.index != null) {
      closeOverlay("branch");
      await patchBranches(
        edit.fid,
        frag.branches.map((b, k) => (k === edit.index ? { ...b, guard } : b)),
      );
      return;
    }
    const row = newBranchRow(
      rowOf(frag.from_order),
      rowOf(frag.to_order),
      frag.branches.map((b) => rowOf(b.start_order)),
    );
    if (row == null || row >= sorted.length) return;
    closeOverlay("branch");
    await patchBranches(edit.fid, [
      ...frag.branches,
      { start_order: sorted[row].order, guard },
    ]);
  }

  async function removeFragment(fid: string) {
    const f = fragById.get(fid);
    await runMutation(async () => {
      await processesApi.removeFragment(id, fid);
      closeOverlay("delFrag");
      if (f) {
        const payload = {
          kind: f.kind, from_order: f.from_order, to_order: f.to_order, guard: f.guard,
          // Ветви восстанавливаем вместе с фрагментом: без них undo вернул бы alt
          // без ветвлений, и это выглядело бы как потеря работы.
          branches: f.branches.map((b) => ({ start_order: b.start_order, guard: b.guard })),
        };
        let restoredId: string | null = null;
        hist.push({
          label: "Удаление фрагмента",
          undo: async () => {
            const r = await processesApi.addFragment(id, payload);
            restoredId = r.id;
          },
          redo: async () => {
            if (restoredId) await processesApi.removeFragment(id, restoredId);
          },
        });
      }
    }, "Не удалось удалить фрагмент");
  }

  return { createFragment, resizeFragment, patchBranches, moveBranch, saveBranch, removeFragment };
}
