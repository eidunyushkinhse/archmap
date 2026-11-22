// Окно «Догрузить архив» — ДОГРУЗКА полных архивов знания к ЖИВОМУ проекту (Ф4,
// docs/plan-unified-import.md). Меню «⋮» шапки проекта открывает его на любой странице
// проекта.
//
// Отличие от создания проекта: там из архивов собирают проект с нуля, здесь схема уже
// живёт, с раскладкой, схемами логики, спецификациями и ручными правками. Поэтому центр
// окна не «что в архивах», а ДИФФ: сколько объектов и связей появится, какое знание доедет
// и о чём придётся выбрать.
//
// Вид — новый язык (редизайн, фаза 6г): одна колонка на общем каркасе окна (ui/ds.css,
// ds-win), как «Новый проект». Вступления нет: зона файлов «Перетащите сюда архивы проекта
// .zip» с одной кнопкой «Выбрать файлы» (архив не текст), под ней имена архивов и итог
// превью: строка статуса, строка «Нового: …», вопросы слияния с массовыми ответами, перечни
// найденного и нового, свёртка того же вида, что в «Новом проекте» (importResult.css,
// область imp-res). Вопросы выше перечней (фаза 8а): они требуют действия и видны без
// прокрутки, перечни справочные. Не-архив — отказом над футером. Футер
// слева: «Применить», «Отмена»; после применения отчёт в окне и «Готово». Файлы принимает
// всё окно. Состояние — useImportInto, дифф и отчёт — IntoReport. Ни слова про агента:
// окно не знает, откуда архив.
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import FileZone from "../docsImport/FileZone";
import { statusState } from "./importRemarks";
import { BulkBox, RemainderBlock, StatusLine, UnfixableFold, splitErrorLine } from "./remainder";
import { DemoExcessNotice, FileTooBigNotice } from "../demo/DemoLimitNotice";
import { useImportInto } from "./useImportInto";
import type { ImportInto } from "./useImportInto";
import { IntoApplyReport, IntoPaths, IntoSummary } from "./IntoReport";
import "../../ui/ds.css";
import "./importResult.css";
import "./importInto.css";

interface Props {
  projectId: string;
  onClose: () => void;
  /** Знание догружено — родитель показывает тост и перечитывает граф. */
  onApplied: (message: string) => void;
}

export default function ImportIntoModal({ projectId, onClose, onApplied }: Props) {
  const into = useImportInto(projectId, onApplied, onClose);
  const { result } = into;

  return (
    // Окно прижато к верху, как «Новый проект»: высота меняется с приходом превью, и по
    // центру зона файлов прыгала бы по экрану.
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 640, padding: 0, margin: "8vh auto auto" }}>
      <div className="ds ds-win imp-res ii-win" {...(result ? {} : into.drop.bind)}>
        <div className="ds-win-head">
          <h2 className="ds-win-title">Догрузить архив</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          {result ? <IntoApplyReport result={result} /> : <IntoInputs into={into} />}
        </div>

        {/* Главная кнопка первой, «Отмена» за ней (правило окон владельца). */}
        <div className="ds-win-foot">
          {result ? (
            <button type="button" className="ds-btn ds-btn--primary" onClick={into.finish}>Готово</button>
          ) : (
            <>
              {into.notZip && <p className="ds-danger ds-win-err" role="alert">{into.notZip}</p>}
              {into.applyError && <p className="ds-danger ds-win-err" role="alert">{into.applyError}</p>}
              <button
                type="button"
                className="ds-btn ds-btn--primary"
                disabled={!into.canApply}
                onClick={into.apply}
              >
                {into.applying ? "Догружаем" : "Применить"}
              </button>
              <button type="button" className="ds-btn" onClick={onClose}>Отмена</button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Зона архивов и итог превью под ней. Плашки пределов демо-стенда прежнего вида живут в
// legacy-root: область .ds окна держит их на прежних метриках (ui/tokens.css).
function IntoInputs({ into }: { into: ImportInto }) {
  const { fresh, excess, questions } = into;
  const ok = fresh?.ok === true && !excess;
  return (
    <section className="ds-win-block">
      <FileZone
        text="Перетащите сюда архивы проекта .zip"
        accept={[".zip"]}
        over={into.drop.over}
        full={false}
        onFiles={into.pickFiles}
        files={into.files.map((f, i) => ({ key: `${f.name}${i}`, name: f.name, openable: false, active: false }))}
        onOpen={() => {}}
        onRemove={into.removeFile}
        editor={null}
        notes={into.drop.error && <p className="ds-warn fz-line">{into.drop.error}</p>}
      />
      {into.checking && <p className="ii-line ii-quiet">Считаем, что добавится</p>}
      {into.tooBig && <div className="legacy-root"><FileTooBigNotice {...into.tooBig} /></div>}
      {/* Не помещается в демо: вместо диффа и вопросов — отказ с полоской. */}
      {excess && <div className="legacy-root"><DemoExcessNotice excess={excess} scope="project" /></div>}
      {fresh && !excess && (
        <div className="ii-result">
          {/* Та же строка статуса, что в окне создания (§1.2): отказ разбора архива — её
              красное состояние со ВСЕМИ ошибками. Виновника-ссылки здесь нет: архивы не
              открываются, их читают; имя архива — в начале текста ошибки. */}
          {/* Архив без нового (типовой случай: архив этого же проекта): вместо статуса
              «Готово к импорту» при погашенной «Применить» и строки «Нового: 0 объектов,
              0 связей» одна тихая строка. */}
          {into.nothingNew ? (
            <p className="ii-line ii-quiet">
              {into.files.length > 1 ? "В архивах нет ничего нового" : "В архиве нет ничего нового"}
            </p>
          ) : (
            <StatusLine
              state={statusState(fresh.ok, questions.length + fresh.remainder.unfixable.length)}
              errors={fresh.ok ? undefined : (
                fresh.errors.length > 0 ? fresh.errors : ["Не удалось прочитать архив"]
              ).map((e) => ({ chipLabel: null, chipIndex: null, ...splitErrorLine(e) }))}
            />
          )}
          {ok && <IntoSummary preview={fresh} nothingNew={into.nothingNew} />}
          {ok && questions.length > 0 && (
            <RemainderBlock
              questions={questions}
              answers={into.answers}
              resolutions={into.resolutions}
              onAnswer={into.onAnswer}
              onResolve={into.onResolve}
              mode="into"
            />
          )}
          {/* Массовые действия — под вопросами: сначала видно, о чём спор, потом «а можно
              всё разом». Жестов и споров без живого они не касаются. */}
          {ok && into.withMine && (
            <BulkBox onKeepMine={() => into.resolveAll(true)} onTakeArchives={() => into.resolveAll(false)} />
          )}
          {ok && <IntoPaths preview={fresh} />}
          {ok && <UnfixableFold items={fresh.remainder.unfixable} />}
        </div>
      )}
    </section>
  );
}
