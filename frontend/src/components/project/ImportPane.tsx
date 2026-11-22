// Панель ввоза окна «Новый проект» (режимы «Импорт» и «ИИ-агент»): зона файлов (общая с
// «Обновить из кода», FileZone) и итог превью под ней — строка статуса, разбор остатка
// слияния вопросами (RemainderBlock) и свёртка «Придется подправить вручную». Входы и
// сводка живут у родителя (useImportInputs, useUnifiedImport) — здесь вид и память
// попыток.
//
// Счётчиков «Готово к импорту: 158 объектов · 271 связь» здесь нет (Ф-E): решению они не
// помогают. Вместо них — статус («Готово к импорту» / «Не всё сошлось идеально» /
// «Что-то пошло не так») и сами вопросы.
//
// Панель НЕ ЗНАЕТ, откуда пользователь взял файлы (правка Ф2г): ни карточки «Замечания к
// файлу N», ни копии замечаний «для агента». Что человек может закрыть решением —
// вопрос разбора, что не может — пункт свёртки, ошибки разбора — только в красном
// статусе. Слова замечаний и вопросов владелец правил сам: здесь меняется только вид
// (новый язык итога задают стили importResult.css в области окна .imp-res).
import { useMemo, useState } from "react";
import type { ImportPreviewOut, UnfixableOut } from "../../types";
import { plural } from "../../ui/plural";
import FileZone from "../docsImport/FileZone";
import { allErrors, statusState } from "./importRemarks";
import { ReportList } from "./ImportPaneParts";
import { RemainderBlock, StatusLine, UnfixableFold } from "./remainder";
import type { Answer, Answers, Question, Resolutions } from "./remainder";
import { IMPORT_ACCEPT } from "./useImportInputs";
import type { ImportInputsApi } from "./useImportInputs";
import "./createProject.css";
import "./importResult.css";

/**
 * Остаток слияния (Ф-E): вопросы разбора, состояние ответов и незакрываемые замечания.
 * Считает и хранит их РОДИТЕЛЬ (ответы переживают перезапрос превью), панель показывает.
 */
export interface RemainderInputs {
  questions: Question[];
  answers: Answers;
  onAnswer: (id: string, answer: Answer) => void;
  /** Выбор по спорам содержимого: id → «cand:<i>» либо «all». */
  resolutions: Resolutions;
  onResolve: (id: string, choice: string) => void;
  /** Замечания, которые выбором не закрыть (§6 ТЗ): все пофайловые и схемные. */
  unfixable: UnfixableOut[];
}

// Память попыток: состав узлов последней зелёной сводки и предыдущей. from — сводка, которой
// соответствует cur (по ссылке: на каждый ответ dry-run родитель кладёт новый объект).
interface Attempts {
  from: ImportPreviewOut | null;
  prev: string[] | null;
  cur: string[];
}
const NO_ATTEMPTS: Attempts = { from: null, prev: null, cur: [] };

export default function ImportPane({ inputs, text, pastePlaceholder, summary, remainder }: {
  inputs: ImportInputsApi;
  /** Строка в зоне файлов: своя у «Импорта» и у «ИИ-агента». */
  text: string;
  pastePlaceholder: string;
  /** Актуальная C4-сводка по ТЕКУЩИМ входам; null — нет, грузится или не нужна. */
  summary: ImportPreviewOut | null;
  remainder: RemainderInputs;
}) {
  const { docs, archives, shown } = inputs;
  // Дифф попыток переставляется ПРИ РЕНДЕРЕ по смене ссылки сводки (React-паттерн
  // «adjusting state when props change»), а не зеркалящим эффектом. Убрали все входы —
  // история попыток начинается заново (сравнивать не с чем).
  const [seen, setSeen] = useState<Attempts>(NO_ATTEMPTS);
  if (docs.length === 0 && archives.length === 0) {
    if (seen !== NO_ATTEMPTS) setSeen(NO_ATTEMPTS);
  } else if (summary?.ok && seen.from !== summary) {
    setSeen({ from: summary, prev: seen.cur, cur: summary.node_names });
  }

  // Что исчезло между попытками (prev − cur, по именам). Рост не показываем — норма.
  const vanished = useMemo(() => {
    if (seen.prev === null) return [];
    const now = new Set(seen.cur);
    return [...new Set(seen.prev.filter((n) => !now.has(n)))];
  }, [seen]);

  // Ошибки отказа: подпись входа — его имя в списке. Ссылка «Открыть файл» есть только у
  // YAML: его текст открывается в поле; у архива открывать нечего.
  const errors = summary && !summary.ok
    ? allErrors(summary, inputs.inputLabel).map((e) =>
      e.chipIndex !== null && inputs.docOfInput(e.chipIndex + 1) < 0 ? { ...e, chipIndex: null } : e)
    : undefined;

  return (
    <>
      <FileZone
        text={text}
        accept={IMPORT_ACCEPT}
        over={inputs.drop.over}
        full={inputs.full}
        onFiles={inputs.pickFiles}
        onPaste={inputs.addPaste}
        files={[
          ...docs.map((_, i) => ({ key: `y${i}`, name: inputs.docLabel(i), openable: true, active: i === shown })),
          ...archives.map((_, j) => ({ key: `z${j}`, name: inputs.zipLabel(j), openable: false, active: false })),
        ]}
        onOpen={inputs.openDoc}
        onRemove={(i) => (i < docs.length ? inputs.removeDoc(i) : inputs.removeArchive(i - docs.length))}
        editor={shown !== null ? {
          value: docs[shown].text,
          onChange: (t) => inputs.setText(shown, t),
          label: `Текст ${inputs.docLabel(shown)}`,
          placeholder: pastePlaceholder,
          autofill: "import-pane-1",
        } : null}
        notes={inputs.drop.error && <p className="ds-warn fz-line">{inputs.drop.error}</p>}
      />

      {summary !== null && (
        <div className="cp-result">
          {/* Ампутация не должна быть молчаливой: пропавшие между попытками объекты —
              над статусом, до зелёного «Готово к импорту». */}
          {summary.ok && vanished.length > 0 && (
            <p className="ds-warn cp-line">
              Стало {seen.cur.length} {plural(seen.cur.length, ["объект", "объекта", "объектов"])}
              {" "}(было {seen.prev?.length ?? 0}). Исчезли: {vanished.slice(0, 8).join(", ")}
              {vanished.length > 8 ? ` и ещё ${vanished.length - 8}` : ""}
            </p>
          )}
          {/* Одна строка вместо прежней сводки: «есть ли вопросы» помогает решению,
              «сколько объектов приедет» — нет (§2 ТЗ). Красное живёт только здесь. */}
          <StatusLine
            state={statusState(summary.ok, remainder.questions.length + remainder.unfixable.length)}
            errors={errors}
            onOpenFile={(index) => {
              const i = inputs.docOfInput(index + 1);
              if (i >= 0) inputs.openDoc(i);
            }}
          />
          {/* Разбор остатка: то, что мердж решить не может, задаётся вопросами. Отказ разбора
              вопросов не рождает: спрашивать не о чем, пока входы не приняты. */}
          {summary.ok && remainder.questions.length > 0 && (
            <RemainderBlock
              questions={remainder.questions}
              answers={remainder.answers}
              resolutions={remainder.resolutions}
              onAnswer={remainder.onAnswer}
              onResolve={remainder.onResolve}
              mode="create"
            />
          )}
          {summary.ok && <UnfixableFold items={remainder.unfixable} />}
          {/* Один файл — конфликты слияния, как было до Ф6: это чтение (правило мерджа
              уже решило), а не действие. */}
          {summary.ok && (summary.files ?? 1) <= 1 && summary.conflicts.length > 0 && (
            <ReportList title="Конфликты слияния (оставлено первое значение):" items={summary.conflicts} />
          )}
        </div>
      )}
    </>
  );
}
