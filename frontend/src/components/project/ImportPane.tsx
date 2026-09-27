import { useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ImportPreviewOut, UnfixableOut } from "../../types";
import { plural } from "../../ui/plural";
import { useFileDrop } from "../docsImport/useFileDrop";
import { allErrors, statusState } from "./importRemarks";
import { ArchiveCard, ReportList } from "./ImportPaneParts";
import { RemainderBlock, StatusLine, UnfixableFold } from "./remainder";
import type { Answer, Answers, Question, Resolutions } from "./remainder";

/**
 * Единая панель ввоза в модалке создания проекта: N входов ЛЮБОГО типа — YAML
 * (чипы «Файл N» — мульти-репо сценарий «Из репозитория») и полные архивы знания
 * .zip (чипы «zip»), вперемешку. Внизу — строка статуса, разбор остатка слияния
 * вопросами (RemainderBlock) и свёртка «Придется подправить вручную». Данные
 * (docs, archives) и сводка живут у родителя — здесь представление и локальный
 * выбор активного входа.
 *
 * Счётчиков «Готово к импорту: 158 объектов · 271 связь» здесь больше нет (Ф-E):
 * решению они не помогают, а место занимают. Вместо них — статус («Готово к
 * импорту» / «Есть вопросы» / «Что-то пошло не так») и сами вопросы.
 *
 * Панель НЕ ЗНАЕТ, откуда пользователь взял файлы (правка Ф2г): это может быть
 * перенос доков между проектами или давно закрытая сессия с агентом. Поэтому в ней
 * нет ни карточки «Замечания к файлу N», ни кнопки «Скопировать замечания для
 * агента», ни заметки «агент мог отчитаться об исправлении»: что человек может
 * закрыть решением — вопрос разбора, что не может — пункт свёртки «Придется
 * подправить вручную» (туда же уехали и пофайловые замечания), ошибки разбора —
 * только в красном статусе.
 */

// Зеркало MAX_IMPORT_FILES бэка (schemas/project.py) — клиентский предохранитель.
// 256 — с запасом под крупные мульти-репо системы (80+ сервисов, файл на репозиторий).
export const MAX_IMPORT_FILES = 256;

// Память попыток: состав узлов последней зелёной сводки и предыдущей.
// from — сводка, которой соответствует cur (сравнение по ссылке: родитель на
// каждый ответ dry-run кладёт новый объект). prev = null — попытка первая.
interface Attempts {
  from: ImportPreviewOut | null;
  prev: string[] | null;
  cur: string[];
}
const NO_ATTEMPTS: Attempts = { from: null, prev: null, cur: [] };

/**
 * Архивная половина панели: сами zip-входы. Бандл, а не россыпь пропсов: это
 * одна ответственность («архивы»), и точка вызова собирает её одним useMemo.
 * Не передан — панель принимает только YAML (так её зовут тесты BYOA-механики).
 * Споры содержимого архивов сюда больше не приходят: они стали вопросами
 * разбора остатка и живут в бандле remainder.
 */
export interface ArchiveInputs {
  files: File[];
  onFiles: (next: File[]) => void;
}

/**
 * Остаток слияния (Ф-E): вопросы разбора, состояние ответов и незакрываемые
 * замечания. Считает и хранит их РОДИТЕЛЬ (ответы переживают перезапрос превью),
 * панель показывает. Не передан — разбора нет вовсе (панель без остатка).
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

const NO_REMAINDER: RemainderInputs = {
  questions: [], answers: {}, onAnswer: () => {}, resolutions: {}, onResolve: () => {},
  unfixable: [],
};

interface Props {
  docs: string[];
  onDocs: (next: string[]) => void;
  // Настоящие имена файлов, положенных с диска (вставленные текстом имени не имеют).
  // Массив идёт строка в строку с docs. Владеет им РОДИТЕЛЬ: теми же именами он
  // подписывает входы мультипарта, и имя чипа обязано совпасть с именем в превью.
  names?: (string | null)[];
  onNames?: (next: (string | null)[]) => void;
  // Актуальная C4-сводка по ТЕКУЩИМ входам (устаревшие родитель уже отбросил); null — нет/грузится.
  summary: ImportPreviewOut | null;
  archives?: ArchiveInputs;
  remainder?: RemainderInputs;
}

const isZip = (f: File): boolean => f.name.toLowerCase().endsWith(".zip");

export default function ImportPane({
  docs, onDocs, names = [], onNames, summary, archives, remainder = NO_REMAINDER,
}: Props) {
  // Индекс активного документа — чисто вьюшное состояние; при удалении чипов
  // может выйти за границы, поэтому в рендере всегда клампится.
  const [activeRaw, setActiveRaw] = useState(0);
  const active = Math.min(activeRaw, docs.length - 1);
  // Активный АРХИВНЫЙ чип (null — активен yaml-чип). Клампится тем же приёмом:
  // архив могли убрать крестиком, и производное состояние в эффект не зеркалим.
  const [activeZipRaw, setActiveZipRaw] = useState<number | null>(null);
  const zips = archives?.files ?? [];
  const activeZip = activeZipRaw !== null && activeZipRaw < zips.length ? activeZipRaw : null;
  const fileRef = useRef<HTMLInputElement>(null);
  // Дифф попыток. Переставляем ПРИ РЕНДЕРЕ по смене ссылки сводки (React-паттерн
  // «adjusting state when props change»), а не зеркалящим эффектом: setState в
  // useEffect линтом запрещён и даёт лишний кадр со старым составом.
  const [seen, setSeen] = useState<Attempts>(NO_ATTEMPTS);
  if (summary?.ok && seen.from !== summary) {
    setSeen({ from: summary, prev: seen.cur, cur: summary.node_names });
  }

  // Номер файла в сводке для каждого чипа: dry-run уезжает только с НЕПУСТЫМИ
  // документами (родитель их фильтрует), поэтому нумерация сводки — по непустым.
  // Пустой чип показывает номер, который займёт, когда его наполнят. Совпадение с
  // нумерацией бэка обязательно: на неё ссылаются тексты «(файл 2)».
  const fileNo = useMemo(() => {
    let n = 0;
    return docs.map((d) => (d.trim() ? ++n : n + 1));
  }, [docs]);
  // Архивы едут ПОСЛЕ всех непустых YAML в порядке добавления — этой же нумерацией
  // бэк подписывает входы и их замечания (file_remarks[номер − 1]).
  const yamlCount = useMemo(() => docs.filter((d) => d.trim()).length, [docs]);
  const zipNo = (j: number): number => yamlCount + j + 1;
  const nameOf = (i: number): string | null => names[i] ?? null;

  function setDoc(i: number, text: string) {
    onDocs(docs.map((d, k) => (k === i ? text : d)));
  }

  function selectDoc(i: number) {
    setActiveRaw(i);
    setActiveZipRaw(null);
  }

  function addDocs(texts: string[], added: (string | null)[]) {
    if (!texts.length) return;
    // Единственный пустой стартовый документ замещается загруженными файлами.
    const drop = docs.length === 1 && !docs[0].trim();
    const next = [...(drop ? [] : docs), ...texts].slice(0, MAX_IMPORT_FILES);
    onNames?.([...(drop ? [] : names), ...added].slice(0, MAX_IMPORT_FILES));
    onDocs(next);
    selectDoc(next.length - 1);
  }

  function removeDoc(i: number) {
    const next = docs.filter((_, k) => k !== i);
    const nextNames = names.filter((_, k) => k !== i);
    // Убрали последний файл — история попыток начинается заново (сравнивать не с чем).
    if (!next.length) setSeen(NO_ATTEMPTS);
    onDocs(next.length ? next : [""]);
    onNames?.(next.length ? nextNames : []);
    setActiveRaw(Math.max(0, active - (i <= active ? 1 : 0)));
  }

  function addArchives(files: File[]) {
    if (!archives || !files.length) return;
    archives.onFiles([...archives.files, ...files]);
    setActiveZipRaw(archives.files.length + files.length - 1);
  }

  function removeArchive(j: number) {
    if (!archives) return;
    archives.onFiles(archives.files.filter((_, k) => k !== j));
    // Убрали активный — активность возвращается к YAML; убрали левее — съезжает.
    setActiveZipRaw((cur) => (cur === null || cur === j ? null : cur > j ? cur - 1 : cur));
  }

  // ArrayLike, а не FileList: тем же путём заходят перетащенные файлы (useFileDrop
  // отдаёт отфильтрованный массив). Архивы отделяем по расширению — читать их
  // текстом нельзя, они уезжают родителю как файлы. Нечитаемый YAML пропускаем:
  // перетащить можно и то, чего не бывает в диалоге выбора.
  function pickFiles(list: ArrayLike<File> | null) {
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    const zip = archives ? all.filter(isZip) : [];
    const yaml = archives ? all.filter((f) => !isZip(f)) : all;
    addArchives(zip);
    if (!yaml.length) return;
    void Promise.all(
      yaml.map((f) =>
        f.text().then((text) => ({ text, name: f.name })).catch(() => null),
      ),
    ).then((read) => {
      const got = read.filter((r): r is { text: string; name: string } => r !== null);
      addDocs(got.map((r) => r.text), got.map((r) => r.name));
    });
  }

  // Перетаскивание в ту же зону, что и кнопка: расширения — как в input accept.
  const accept = archives ? [".yaml", ".yml", ".zip"] : [".yaml", ".yml"];
  const drop = useFileDrop({
    accept,
    onFiles: pickFiles,
    disabled: docs.length >= MAX_IMPORT_FILES,
  });

  // Мульти-режим — по числу РАЗОБРАННЫХ входов, а не чипов: пустой чип в dry-run
  // не уезжает, и бэк в таком случае кладёт всё в единственный файл.
  const multi = (summary?.files ?? 1) > 1;

  // Вход по его НОМЕРУ в сводке (нумерация сплошная: непустые YAML в порядке
  // чипов, затем архивы) — им подписан виновник ошибки в статусе, и по нему же
  // ссылка «Открыть файл …» делает этот вход активным.
  const docOfInput = (no: number): number =>
    docs.findIndex((d, k) => d.trim() !== "" && fileNo[k] === no);
  function chipLabel(no: number): string | null {
    const i = docOfInput(no);
    // Подпись встаёт в шаблоны «Проблема в файле …» и «Открыть файл …», поэтому
    // у вставленного текстом входа она — просто номер: «Открыть файл Файл 2»
    // читалось бы заиканием, а чип с номером узнаётся и так.
    if (i >= 0) return nameOf(i) !== null ? `${no} · ${nameOf(i)}` : `${no}`;
    const f = zips[no - yamlCount - 1];
    return f ? `${no} · ${f.name}` : null;
  }
  function openInput(index: number) {
    const no = index + 1;
    const i = docOfInput(no);
    if (i >= 0) { selectDoc(i); return; }
    const j = no - yamlCount - 1;
    if (j >= 0 && j < zips.length) setActiveZipRaw(j);
  }

  // Что исчезло между попытками (prev − cur, по именам). Рост не показываем — норма.
  const vanished = useMemo(() => {
    if (seen.prev === null) return [];
    const now = new Set(seen.cur);
    return [...new Set(seen.prev.filter((n) => !now.has(n)))];
  }, [seen]);

  return (
    <>
      <div style={chipsRow}>
        {docs.map((_, i) => (
          <span key={i} className={`cp-chip${i === active && activeZip === null ? " cp-chip--on" : ""}`}>
            {/* Без крестика padding должен быть симметричным: асимметрия ниже
                рассчитана на соседство с ним, иначе текст жмётся вправо. */}
            <button
              type="button"
              style={docs.length > 1 ? chipBtn : { ...chipBtn, padding: "3px 10px" }}
              title={nameOf(i) ?? undefined}
              onClick={() => selectDoc(i)}
            >
              {nameOf(i) ? `${fileNo[i]} · ${nameOf(i)}` : `Файл ${fileNo[i]}`}
            </button>
            {docs.length > 1 && (
              <button
                type="button"
                style={chipX}
                title="Убрать файл"
                onClick={() => removeDoc(i)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {/* Архивные чипы — та же полоса, свой номер входа и метка «zip»: их тела
            не редактируются, поэтому вместо textarea у них карточка. */}
        {zips.map((f, j) => (
          <span key={`zip-${j}`} className={`cp-chip${activeZip === j ? " cp-chip--on" : ""}`}>
            <button
              type="button"
              style={chipBtn}
              title={f.name}
              onClick={() => setActiveZipRaw(j)}
            >
              <span style={zipTag}>zip</span>
              {` ${zipNo(j)} · ${f.name}`}
            </button>
            <button
              type="button"
              style={chipX}
              title="Убрать архив"
              onClick={() => removeArchive(j)}
            >
              ×
            </button>
          </span>
        ))}
        {/* «+» — пустой документ под вставку текста (второй YAML не обязан быть файлом) */}
        {docs.length < MAX_IMPORT_FILES && docs[docs.length - 1].trim() !== "" && (
          <button
            type="button"
            className="cp-chip"
            style={{ ...chipBtn, padding: "3px 10px" }}
            title="Добавить ещё один YAML вставкой"
            onClick={() => {
              onDocs([...docs, ""]);
              onNames?.([...names, null]);
              selectDoc(docs.length);
            }}
          >
            +
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={accept.join(",")}
          multiple
          style={{ display: "none" }}
          onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }}
        />
        <button
          type="button"
          className="btn-soft"
          disabled={docs.length >= MAX_IMPORT_FILES}
          onClick={() => fileRef.current?.click()}
        >
          Загрузить файлы…
        </button>
      </div>

      <div className={drop.over ? "drop-zone--over" : undefined} {...drop.bind}>
        {activeZip !== null ? (
          <ArchiveCard file={zips[activeZip]} no={zipNo(activeZip)} />
        ) : (
          <textarea
            style={importArea}
            value={docs[active]}
            onChange={(e) => setDoc(active, e.target.value)}
            placeholder={
              (archives
                ? "Перетащите сюда .yaml-файлы и архивы .zip или вставьте текст. Входов может быть\n"
                : "Перетащите сюда .yaml-файлы или вставьте текст. Файлов может быть\n") +
              "несколько (по одному на репозиторий каждого сервиса, из которых состоит\n" +
              "система), они сольются автоматически."
            }
            spellCheck={false}
          />
        )}
      </div>
      {drop.error && (
        <p style={{ ...grayLine, color: "#b45309" }}>{drop.error}</p>
      )}

      <div style={{ marginTop: 10 }}>
        {/* Ампутация не должна быть молчаливой: пропавшие между попытками объекты —
            над сводкой, до зелёного «Готово к импорту». */}
        {summary?.ok && vanished.length > 0 && (
          <div style={vanishedLine}>
            Стало {seen.cur.length} {plural(seen.cur.length, ["объект", "объекта", "объектов"])}
            {" "}(было {seen.prev?.length ?? 0}). Исчезли: {vanished.slice(0, 8).join(", ")}
            {vanished.length > 8 ? ` и ещё ${vanished.length - 8}` : ""}
          </div>
        )}
        {/* Одна строка вместо прежней сводки: «есть ли вопросы» помогает решению,
            «сколько объектов приедет» — нет (§2 ТЗ). Красное живёт только здесь. */}
        {summary !== null && (
          <StatusLine
            state={statusState(summary.ok, remainder.questions.length + remainder.unfixable.length)}
            errors={summary.ok ? undefined : allErrors(summary, chipLabel)}
            onOpenFile={openInput}
          />
        )}
        {/* Разбор остатка: то, что мердж решить не может, — вопросами. Отказ
            разбора вопросов не рождает: спрашивать не о чем, пока входы не приняты. */}
        {summary?.ok && remainder.questions.length > 0 && (
          <RemainderBlock
            questions={remainder.questions}
            answers={remainder.answers}
            resolutions={remainder.resolutions}
            onAnswer={remainder.onAnswer}
            onResolve={remainder.onResolve}
            mode="create"
          />
        )}
        {summary?.ok && (
          <UnfixableFold items={remainder.unfixable} />
        )}
        {/* Один файл — конфликты слияния, как было до Ф6: это чтение (правило
            мерджа уже решило), а не действие. */}
        {summary?.ok && !multi && summary.conflicts.length > 0 && (
          <ReportList title="Конфликты слияния (оставлено первое значение):" items={summary.conflicts} />
        )}
      </div>
    </>
  );
}

const chipsRow: CSSProperties = {
  display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8,
  // В крупных мульти-репо системах десятки файлов — ряд чипов ограничен по высоте и
  // прокручивается, чтобы не выдавливать textarea и сводку из модалки создания.
  maxHeight: 92, overflowY: "auto",
};
const chipBtn: CSSProperties = {
  border: "none", background: "none", cursor: "pointer", font: "inherit",
  fontSize: 12.5, fontWeight: 600, color: "inherit", padding: "3px 2px 3px 10px",
  // Имя файла с диска бывает длинным — чип не должен растягивать ряд на всю ширину.
  maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
const chipX: CSSProperties = {
  border: "none", background: "none", cursor: "pointer", color: "#94a3b8",
  fontSize: 14, lineHeight: 1, padding: "3px 8px 3px 4px",
};
// Метка типа входа в чипе: архив от YAML отличается не только содержимым, но и тем,
// что его нельзя править в панели.
const zipTag: CSSProperties = {
  padding: "1px 5px", borderRadius: 5, background: "#e2e8f0", color: "#475569",
  fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3,
};
const grayLine: CSSProperties = { fontSize: 12.5, color: "#94a3b8", marginTop: 3 };
// Тот же amber, что у заголовков отчёта слияния (ReportList) и ошибки перетаскивания.
const vanishedLine: CSSProperties = {
  fontSize: 12.5, fontWeight: 600, color: "#b45309", marginBottom: 6,
};
const importArea: CSSProperties = {
  width: "100%", height: 246, boxSizing: "border-box", resize: "none",
  padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12.5, lineHeight: 1.5, color: "#0f172a", background: "#fff",
};
