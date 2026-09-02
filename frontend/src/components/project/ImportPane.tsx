import { useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { FamilyConflictOut, ImportPreviewOut, UnifiedFamilyCountsOut } from "../../types";
import { plural } from "../../ui/plural";
import { useFileDrop } from "../docsImport/useFileDrop";
import { inputFingerprint, useRepeatedInput } from "../docsImport/agentModalShared";
import { StaleFilesConfirm, UnchangedInputNote } from "../docsImport/agentModalReport";
import ConflictSection from "./ConflictSection";

/**
 * Единая панель ввоза в модалке создания проекта: N входов ЛЮБОГО типа — YAML
 * (чипы «Файл N» — мульти-репо сценарий «Из репозитория») и полные архивы знания
 * .zip (чипы «zip»), вперемешку. Внизу — сводка dry-run с отчётом слияния, споры
 * содержимого (ConflictSection) и кнопка «Скопировать замечания» (уносится
 * ИИ-агенту на починку). Данные (docs, archives) и сводка живут у родителя —
 * здесь представление и локальный выбор активного входа.
 *
 * Мульти-режим (входов больше одного) адресует замечания: пакет собирают N агентов,
 * каждый видит ТОЛЬКО свой репозиторий и переписывает только свой документ. Поэтому
 * под панелью показываются замечания АКТИВНОГО файла со своей кнопкой копирования, а
 * замечания слитой схемы (конфликты файлов, оторванные группы) вынесены отдельной
 * секцией без кнопки — их чинит человек, видящий весь ландшафт (Ф6 плана
 * docs/plan-skeptic-audit.md). Одно-файловый режим не меняется ничем: там агент
 * видит всю систему и чинит всё.
 *
 * У АРХИВНОГО входа кнопки «для агента» нет вовсе: архив собирал экспорт, а не
 * агент, и переписывать его некому — замечания архива только читают.
 */

// Зеркало MAX_IMPORT_FILES бэка (schemas/project.py) — клиентский предохранитель.
// 256 — с запасом под крупные мульти-репо системы (80+ сервисов, файл на репозиторий).
export const MAX_IMPORT_FILES = 256;

// Вступления к замечаниям. Разные по случаям, и это НЕ косметика: полевой QA
// (docs/qa-zabbix-7.md, раунд 2) показал, что на «исправь» слабая модель отвечает
// ампутацией — вырезает объекты вместо поиска связей (31→27, затем 30→14 узлов).
// Ошибки разбора чинятся правкой; предупреждения зелёной сводки — ДОПОЛНЕНИЕМ.
// Мульти-варианты добавляют к тому же уроку контекст «твой файл — один из многих»:
// иначе агент правит чужие куски вслепую или переписывает всю систему.
const INTRO_ONE_OK =
  "Валидатор импорта ArchMap принял YAML, но оставил предупреждения. Устрани их, " +
  "ДОПОЛНЯЯ схему — находи и дописывай недостающие связи, а НЕ удаляй объекты: " +
  "удаление хуже недостающей связи. Выведи весь YAML-документ целиком заново:";
const INTRO_ONE_BAD =
  "Валидатор импорта ArchMap нашёл замечания к YAML. Исправь их и выведи весь " +
  "YAML-документ целиком заново:";
const INTRO_MANY_OK =
  "Валидатор импорта ArchMap принял ваш YAML — один из нескольких файлов системы, — " +
  "но оставил предупреждения. Устрани их, ДОПОЛНЯЯ схему — находи и дописывай " +
  "недостающие связи, а НЕ удаляй объекты: удаление хуже недостающей связи. " +
  "Выведи весь СВОЙ YAML-документ целиком заново:";
const INTRO_MANY_BAD =
  "Валидатор импорта ArchMap нашёл замечания к вашему YAML-файлу — одному из " +
  "нескольких файлов системы. Исправь их и выведи весь СВОЙ YAML-документ целиком " +
  "заново:";

// Память попыток агента: состав узлов последней зелёной сводки и предыдущей.
// from — сводка, которой соответствует cur (сравнение по ссылке: родитель на
// каждый ответ dry-run кладёт новый объект). prev = null — попытка первая.
interface Attempts {
  from: ImportPreviewOut | null;
  prev: string[] | null;
  cur: string[];
}
const NO_ATTEMPTS: Attempts = { from: null, prev: null, cur: [] };

/**
 * Архивная половина панели: сами zip-входы, счётчики того, что они привезут, и
 * споры содержимого с выбором пользователя. Бандл, а не россыпь пропсов: всё это
 * одна ответственность («архивы»), и точка вызова собирает её одним useMemo.
 * Не передан — панель принимает только YAML (так её зовут тесты BYOA-механики).
 */
export interface ArchiveInputs {
  files: File[];
  onFiles: (next: File[]) => void;
  /** Что приедет из архивов при текущих (дефолтных) резолюциях. */
  counts: UnifiedFamilyCountsOut;
  conflicts: FamilyConflictOut[];
  /** Выбор пользователя по спорам: id → «cand:<i>» либо «all». */
  resolutions: Record<string, string>;
  onResolve: (id: string, choice: string) => void;
}

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
}

const isZip = (f: File): boolean => f.name.toLowerCase().endsWith(".zip");

export default function ImportPane({
  docs, onDocs, names = [], onNames, summary, archives,
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
  const [copied, setCopied] = useState(false);
  // Дифф попыток. Переставляем ПРИ РЕНДЕРЕ по смене ссылки сводки (React-паттерн
  // «adjusting state when props change»), а не зеркалящим эффектом: setState в
  // useEffect линтом запрещён и даёт лишний кадр со старым составом.
  const [seen, setSeen] = useState<Attempts>(NO_ATTEMPTS);
  if (summary?.ok && seen.from !== summary) {
    setSeen({ from: summary, prev: seen.cur, cur: summary.node_names });
  }
  // Гвард «вход не изменился»: тот же байт-в-байт документ, что в прошлый заход, —
  // повод посмотреть на файл, а не на замечание (находка полевой приёмки). Считаем
  // по YAML-текстам: архивы правит не агент, и «переспросить» их незачем.
  const fingerprint = useMemo(() => inputFingerprint(docs), [docs]);
  const repeatedInput = useRepeatedInput(docs, fingerprint);
  // Набор документов, к которому задан вопрос об устаревании (после копирования
  // замечаний). Сравнение по ссылке: тронули файлы — вопрос снят сам, без эффекта.
  const [askedFor, setAskedFor] = useState<string[] | null>(null);

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
  // Замечания активного файла: их и только их уносит его агент.
  const activeFile = activeZip === null && docs[active]?.trim()
    ? summary?.file_remarks[fileNo[active] - 1]
    : undefined;
  const activeRemarks = activeFile ? [...activeFile.errors, ...activeFile.warnings] : [];
  // Замечания активного архива. Корзина может быть короче номера (сводка отказа
  // пофайловых корзин не несёт) — индексируемся защищённо.
  const zipFile = activeZip !== null ? summary?.file_remarks[zipNo(activeZip) - 1] : undefined;
  const zipRemarks = zipFile ? [...zipFile.errors, ...zipFile.warnings] : [];

  // Замечания для агента: при ошибках — они; при зелёной сводке — конфликты и
  // предупреждения слияния (промпт учит агента чинить по такому списку).
  const remarks = summary === null
    ? []
    : multi
      ? activeRemarks
      : summary.ok
        ? [...summary.conflicts, ...summary.warnings]
        : summary.errors;

  const remarksIntro = multi
    ? (summary?.ok ? INTRO_MANY_OK : INTRO_MANY_BAD)
    : (summary?.ok ? INTRO_ONE_OK : INTRO_ONE_BAD);

  // Кнопка «для агента» уместна только у yaml-чипа с содержимым: архив собирал
  // экспорт, и переписывать его некому.
  const canCopy = activeZip === null && Boolean(docs[active]?.trim());

  // Что исчезло между попытками (prev − cur, по именам). Рост не показываем — норма.
  const vanished = useMemo(() => {
    if (seen.prev === null) return [];
    const now = new Set(seen.cur);
    return [...new Set(seen.prev.filter((n) => !now.has(n)))];
  }, [seen]);

  function copyRemarks() {
    const text =
      remarksIntro + "\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // Замечания ушли агенту — значит вернётся исправленная версия, и лежащий в
      // панели документ устареет. Спрашиваем сразу, пока пользователь здесь.
      setAskedFor(docs);
    });
  }

  // «Убрать из панели»: в одно-файловом режиме — весь вход (то же, что снятие
  // последнего файла крестиком: пустой документ и история попыток с чистого листа).
  // В мульти-режиме устарел ТОЛЬКО активный файл: остальные пришли от других агентов,
  // их никто не переделывает.
  function dropStale() {
    setAskedFor(null);
    if (multi) {
      removeDoc(active);
      return;
    }
    setSeen(NO_ATTEMPTS);
    onDocs([""]);
    onNames?.([]);
    selectDoc(0);
  }

  const copyBtn = (
    <button type="button" className="btn-soft" style={{ marginTop: 8 }} onClick={copyRemarks}>
      {copied ? "Скопировано ✓" : "Скопировать замечания для агента"}
    </button>
  );

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
          <ArchiveCard file={zips[activeZip]} no={zipNo(activeZip)} remarks={zipRemarks} />
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
        {/* Вход тот же, что в прошлый заход, — заметка над сводкой: замечание
            повторится, и чинить надо не его, а разговор с агентом. */}
        {repeatedInput && <UnchangedInputNote />}
        {/* Ампутация не должна быть молчаливой: пропавшие между попытками объекты —
            над сводкой, до зелёного «Готово к импорту». */}
        {summary?.ok && vanished.length > 0 && (
          <div style={vanishedLine}>
            Стало {seen.cur.length} {plural(seen.cur.length, ["объект", "объекта", "объектов"])}
            {" "}(было {seen.prev?.length ?? 0}). Исчезли: {vanished.slice(0, 8).join(", ")}
            {vanished.length > 8 ? ` и ещё ${vanished.length - 8}` : ""}
          </div>
        )}
        {summary?.ok && (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
              Готово к импорту: {summary.node_count} {plural(summary.node_count, ["объект", "объекта", "объектов"])} · {summary.edge_count} {plural(summary.edge_count, ["связь", "связи", "связей"])}
              {summary.files > 1 && ` · из ${summary.files} ${plural(summary.files, ["файла", "файлов", "файлов"])}`}
            </div>
            {/* Знание архивов не видно в C4-счётчиках — называем его отдельной строкой,
                иначе неясно, что вместе со схемой едут доки, спеки и структуры. */}
            {archives && <FamilyCounts counts={archives.counts} />}
            {summary.roots.length > 0 && (
              <div style={grayLine}>Корневые: {summary.roots.join(", ")}</div>
            )}
            {summary.merged_count > 0 && (
              <div style={grayLine}>
                Склеено узлов: {summary.merged_count} ({summary.merged.join(", ")}
                {summary.merged_count > summary.merged.length ? ", …" : ""})
                {summary.dropped_edges > 0 && ` · дублей связей выброшено: ${summary.dropped_edges}`}
              </div>
            )}
            {/* Один файл — плоский отчёт слияния, как было до Ф6. */}
            {!multi && summary.conflicts.length > 0 && (
              <ReportList title="Конфликты слияния (оставлено первое значение):" items={summary.conflicts} />
            )}
            {!multi && summary.warnings.length > 0 && (
              <ReportList title="Проверьте:" items={summary.warnings} />
            )}
          </>
        )}
        {summary && !summary.ok && (
          <div style={{ fontSize: 13, color: "#dc2626" }}>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>Не получается разобрать YAML:</div>
            {multi ? (
              <MultiErrorHint summary={summary} />
            ) : (
              <>
                {summary.errors.slice(0, 5).map((e, i) => (
                  <div key={i} style={{ marginTop: 2 }}>{e}</div>
                ))}
                {summary.errors.length > 5 && (
                  <div style={{ marginTop: 2 }}>…ещё {summary.errors.length - 5}</div>
                )}
              </>
            )}
          </div>
        )}
        {!multi && canCopy && remarks.length > 0 && copyBtn}
        {multi && summary !== null && (
          <>
            {activeZip === null && (activeRemarks.length > 0 ? (
              <>
                <ReportList
                  title={`Замечания к файлу ${fileNo[active]}${nameOf(active) ? ` · ${nameOf(active)}` : ""}:`}
                  items={activeRemarks}
                />
                {copyBtn}
              </>
            ) : docs[active].trim() !== "" ? (
              <div style={grayLine}>К файлу {fileNo[active]} замечаний нет.</div>
            ) : null)}
            {summary.schema_warnings.length > 0 && (
              <>
                <ReportList title="Замечания к слитой схеме:" items={summary.schema_warnings} />
                <div style={grayLine}>
                  Эти замечания — о взаимном устройстве файлов, поэтому агенту одного
                  репозитория их не починить. Их чинят там, где виден весь ландшафт:
                  добавьте файлы остальных репозиториев, попросите нужного агента
                  дорисовать связь или поправьте схему после импорта вручную.
                </div>
              </>
            )}
          </>
        )}
        {/* Споры содержимого — под сводкой: сначала «что приедет», потом «чьё». */}
        {archives && (
          <ConflictSection
            conflicts={archives.conflicts}
            resolutions={archives.resolutions}
            onResolve={archives.onResolve}
          />
        )}
        {askedFor === docs && (
          <StaleFilesConfirm
            onKeep={() => setAskedFor(null)}
            onClear={dropStale}
            text={multi
              ? "Агент вернёт исправленную версию — этот файл в панели устареет. Оставить его?"
              : undefined}
            clearLabel={multi ? "Убрать этот файл из панели" : undefined}
          />
        )}
      </div>
    </>
  );
}

// Карточка активного архива вместо textarea: тело архива не правят — его читают.
// Кнопки «для агента» здесь нет принципиально (архив собирал экспорт).
function ArchiveCard({ file, no, remarks }: { file: File; no: number; remarks: string[] }) {
  return (
    <div style={archiveCard}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0f172a" }}>{file.name}</div>
      <div style={grayLine}>
        Вход {no} · {(file.size / 1024).toFixed(0)} КБ · полный архив знания
      </div>
      {remarks.length > 0 ? (
        <ReportList title="Замечания к архиву:" items={remarks} />
      ) : (
        <div style={grayLine}>К архиву замечаний нет.</div>
      )}
      <div style={{ ...grayLine, marginTop: 10 }}>
        Из архива приедут схемы логики, спеки, структуры БД и брокеров,
        конфигурация и процессы. Раскладка пересчитается заново.
      </div>
    </div>
  );
}

// Что привезут архивы при текущих резолюциях: C4-счётчики про это молчат.
function FamilyCounts({ counts }: { counts: UnifiedFamilyCountsOut }) {
  const parts = [
    counts.docs && `${counts.docs} ${plural(counts.docs, ["схема логики", "схемы логики", "схем логики"])}`,
    counts.specs && `${counts.specs} ${plural(counts.specs, ["спека", "спеки", "спек"])}`,
    counts.tables && `${counts.tables} ${plural(counts.tables, ["таблица", "таблицы", "таблиц"])}`,
    counts.channels && `${counts.channels} ${plural(counts.channels, ["канал", "канала", "каналов"])}`,
    counts.params && `${counts.params} ${plural(counts.params, ["параметр", "параметра", "параметров"])}`,
    counts.processes && `${counts.processes} ${plural(counts.processes, ["процесс", "процесса", "процессов"])}`,
  ].filter((s): s is string => typeof s === "string");
  if (!parts.length) return null;
  return <div style={grayLine}>Из архивов: {parts.join(" · ")}</div>;
}

// Красная шапка мульти-режима: сами ошибки лежат в списке своего файла (их уносит
// его агент), здесь — куда смотреть. Ошибки слитой схемы (лимиты слияния, отказ
// проверки) файла-виновника не имеют и показываются прямо тут.
function MultiErrorHint({ summary }: { summary: ImportPreviewOut }) {
  const bad = summary.file_remarks.filter((f) => f.errors.length > 0).map((f) => f.file);
  return (
    <>
      {bad.length > 0 && (
        <div style={{ marginTop: 2 }}>
          {bad.length === 1 ? "Замечания к файлу" : "Замечания к файлам"} {bad.join(", ")} —
          {" "}выберите файл, чтобы прочитать и скопировать их
        </div>
      )}
      {summary.schema_errors.map((e, i) => (
        <div key={i} style={{ marginTop: 2 }}>{e}</div>
      ))}
      {bad.length === 0 && summary.schema_errors.length === 0 &&
        summary.errors.slice(0, 5).map((e, i) => (
          <div key={i} style={{ marginTop: 2 }}>{e}</div>
        ))}
    </>
  );
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 6, fontSize: 12.5, color: "#b45309" }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {items.slice(0, 6).map((s, i) => (
        <div key={i} style={{ marginTop: 2, color: "#475569" }}>{s}</div>
      ))}
      {items.length > 6 && <div style={{ marginTop: 2, color: "#475569" }}>…ещё {items.length - 6}</div>}
    </div>
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
// Карточка архива занимает место textarea — панель не должна прыгать при смене чипа.
const archiveCard: CSSProperties = {
  height: 246, boxSizing: "border-box", overflowY: "auto",
  padding: "12px 14px", border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff",
};
