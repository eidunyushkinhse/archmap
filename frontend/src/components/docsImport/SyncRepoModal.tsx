// Модалка «Обновить из репозитория» — синхронизация ЖИВОГО проекта со свежим
// прогоном ИИ-агента (docs/plan-arch-sync.md, Фаза 3).
//
// Отличие от импорта: импорт создаёт проект с нуля, здесь схема уже живёт — с
// раскладкой, схемами логики, спеками и ручными правками. Поэтому центр окна не
// «сводка документа», а ПЛАН: что появится, что изменится, что пропало. Ничего не
// записывается, пока пользователь не нажмёт «Применить», и применение отправляет
// курсор схемы из превью — если схема успела измениться, бэк ответит 409, а не
// применит вслепую не то, что человек видел.
//
// Слева — тот же промпт «Из репозитория» (его запускают в каждом репозитории
// системы), справа — файлы прогона, политики и план.
import { useEffect, useRef, useState } from "react";
import type { PromptVariant, SyncApplyOut, SyncPreviewOut } from "../../types";
import { projectsApi, type SyncPolicies } from "../../api/projects";
import { ApiError } from "../../api/client";
import { useDocsFiles, MAX_FILES } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import { planSections, planSummary, applySummary } from "./syncPlanView";
import { NoteList } from "./agentModalReport";
import PromptTriple from "./PromptTriple";
import {
  head, sub, cols, leftCol, rightCol, hintsArea, leftNote,
  chipsRow, chipOn, chip, chipBtn, chipX, fileArea, dropHint, grayLine, footRow,
} from "./agentModalShared";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";

interface Props {
  projectId: string;
  onClose: () => void;
  /** Схема записана — родитель перезагружает граф и показывает тост. */
  onApplied: (message: string) => void;
}

// Подсказки описывают ЭФФЕКТ для пользователя, а не механику: в интерфейс не
// должны попадать наши рабочие слова («прогон», «политика», «якорь», «слой»).
const POLICY_LABELS: { key: keyof SyncPolicies; title: string; hint: string }[] = [
  {
    key: "update_descriptions",
    title: "Заменить описания",
    hint: "Описания объектов будут заменены на те, что в YAML. Если вы правили описания вручную, эти правки пропадут. По умолчанию выключено: описания у агента каждый раз получаются немного разными.",
  },
  {
    key: "update_names",
    title: "Переименовать объекты",
    hint: "Объекты получат имена из YAML. Без этой галочки имена в схеме останутся прежними, а расхождение будет просто показано в списке ниже.",
  },
  {
    key: "sync_components",
    title: "Обновлять внутреннее устройство сервисов",
    hint: "Затрагивать не только сами сервисы и базы, но и то, из чего они состоят внутри. По умолчанию выключено: внутреннее устройство агент описывает менее надёжно, и такие изменения обычно только мешают увидеть главное.",
  },
  {
    key: "mark_missing_deprecated",
    title: "Помечать устаревшими то, чего нет в YAML",
    hint: "Объекты, которых в YAML больше нет, получат статус «устаревший» и будут видны на схеме серым. Удалять их ArchMap не будет ни при каких настройках.",
  },
  {
    key: "restore_returned",
    title: "Возвращать в строй то, что снова появилось",
    hint: "С объектов, помеченных устаревшими, статус будет снят, если в YAML они снова есть. По умолчанию выключено: пометку могли поставить вы вручную, и снимать её без спроса неправильно. Сам факт возвращения показан в плане в любом случае.",
  },
];

export default function SyncRepoModal({ projectId, onClose, onApplied }: Props) {
  // Имя системы в промпте = имя проекта: грузим здесь, а не тащим пропом через
  // оболочку — она его тоже не знает (в шапке имя рисует ProjectSwitcher).
  const [projectName, setProjectName] = useState("");
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [hints, setHints] = useState("");
  const pkg = useDocsFiles();
  const [policies, setPolicies] = useState<SyncPolicies>({
    update_descriptions: false,
    update_names: false,
    sync_components: false,
    mark_missing_deprecated: false,
    restore_returned: false,
  });
  const [rawPreview, setRawPreview] = useState<SyncPreviewOut | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  // Перетаскивание в ту же зону, что и кнопка «Загрузить файлы…»: список
  // расширений держим одинаковым с input accept ниже.
  const drop = useFileDrop({
    accept: [".yaml", ".yml", ".txt"],
    onFiles: pkg.pickFiles,
    disabled: pkg.files.length >= MAX_FILES,
  });

  // Файлы убрали — план прячем ПРОИЗВОДНО, без зеркалящего эффекта.
  const preview = pkg.hasContent ? rawPreview : null;

  useEffect(() => {
    let alive = true;
    projectsApi
      .get(projectId)
      .then((p) => {
        if (alive) setProjectName(p.name);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId]);

  // Дебаунс-превью по файлам и политикам: план пересчитывается на бэке, здесь
  // только показ. seq отбрасывает устаревшие ответы при быстрой правке.
  useEffect(() => {
    const nonEmpty = pkg.files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0) return;
    const seq = ++seqRef.current;
    // Все setState — асинхронно, внутри таймера/ответа (react-hooks/set-state-in-effect).
    // Побочно полезно: индикатор не мигает на каждом нажатии клавиши в редакторе.
    const t = window.setTimeout(() => {
      setChecking(true);
      projectsApi
        .syncPreview(projectId, nonEmpty.map((f) => f.content), policies)
        .then((res) => {
          if (seq === seqRef.current) setRawPreview(res);
        })
        .catch(() => {
          if (seq === seqRef.current) setRawPreview(null);
        })
        .finally(() => {
          if (seq === seqRef.current) setChecking(false);
        });
    }, 400);
    return () => window.clearTimeout(t);
  }, [pkg.files, policies, projectId]);

  // Запрос задания + запись в буфер В ПРЕДЕЛАХ ЖЕСТА; «скопировано» по каждому из
  // трёх вариантов показывает PromptTriple по разрешению этого обещания.
  // Глубина у агента всегда просится одна — два слоя, как и при создании проекта
  // (решение пользователя 2026-08-16): синк и создание обязаны просить одно и то же,
  // иначе прогон синка предложит план по более дробной схеме, чем построенная.
  const copyPrompt = (variant: PromptVariant): Promise<void> =>
    projectsApi
      .importPrompt({
        systemName: projectName, depth: 2, lang,
        hints: hints.trim() || undefined, variant,
      })
      .then((r) => navigator.clipboard.writeText(r.prompt));

  const apply = () => {
    if (!preview?.ok || preview.is_noop) return;
    setApplying(true);
    setApplyError(null);
    projectsApi
      .syncApply(projectId, pkg.nonEmpty.map((f) => f.content), policies, preview.graph_rev)
      .then((r: SyncApplyOut) => {
        onApplied(applySummary(r));
        onClose();
      })
      .catch((e: unknown) => {
        setApplyError(
          e instanceof ApiError && e.status === 409
            ? "Схему изменили в другом окне или другим пользователем — список ниже устарел. Закройте это окно и откройте снова."
            : "Не удалось сохранить изменения. Проверьте соединение и повторите.",
        );
      })
      .finally(() => setApplying(false));
  };

  const sections = preview?.ok ? planSections(preview) : [];
  const canApply = !!preview?.ok && !preview.is_noop && !applying && !checking;

  return (
    <Modal
      onClose={onClose}
      closeButton={false}
      boxStyle={{ width: 1060, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}
    >
      <div style={head}>
        <h3 style={{ margin: 0, fontSize: 16.5 }}>Обновить из репозитория</h3>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть">
          <CloseIcon />
        </button>
      </div>
      <p style={sub}>
        Скопируйте задание, выполните его своим ИИ-агентом в каждом репозитории системы и
        вставьте полученные YAML сюда. ArchMap сверит их со схемой и покажет, что изменится,
        прежде чем что-либо записать. Расположение объектов, схемы логики, спецификации и
        бизнес-процессы останутся на месте, удалять ArchMap ничего не будет.
      </p>

      <div style={cols}>
        {/* ── Слева: промпт ─────────────────────────────────── */}
        <div style={leftCol}>
          <label style={labelStyle}>Язык описаний</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {(["ru", "en"] as const).map((l) => (
              <button
                key={l}
                type="button"
                style={lang === l ? chipOn : chip}
                onClick={() => setLang(l)}
              >
                {l === "ru" ? "Русский" : "English"}
              </button>
            ))}
          </div>
          <label style={labelStyle}>Подсказки агенту (необязательно)</label>
          <textarea
            style={hintsArea}
            value={hints}
            onChange={(e) => setHints(e.target.value)}
            placeholder="Например: игнорируй каталог legacy/"
          />
          <PromptTriple
            label="Скопировать задание для агента"
            copiedLabel="Скопировано"
            kind="secondary"
            buttonStyle={{ marginTop: 10 }}
            disabled={!projectName}
            copy={copyPrompt}
          />
          <p style={leftNote}>
            В задании система названа «{projectName}». Одно и то же задание выполняется в каждом
            репозитории: объекты узнаются по якорю — коду (репозиторий и путь в нём) или
            имени зависимости, — поэтому переименованный сервис не превратится в новый объект.
          </p>
        </div>

        {/* ── Справа: файлы, политики, план ─────────────────── */}
        <div style={rightCol}>
          <div style={chipsRow}>
            {pkg.files.map((f, i) => (
              <span key={f.name + i} style={i === pkg.active ? chipOn : chip}>
                <button type="button" style={chipBtn} onClick={() => pkg.setActive(i)}>
                  {f.name}
                </button>
                <button
                  type="button"
                  style={chipX}
                  onClick={() => pkg.removeFile(i)}
                  aria-label={`Убрать ${f.name}`}
                >
                  ×
                </button>
              </span>
            ))}
            {pkg.files.length < MAX_FILES && (
              <>
                <button type="button" className="btn-soft" onClick={() => fileRef.current?.click()}>
                  Загрузить файлы…
                </button>
                <button type="button" className="btn-soft" onClick={pkg.addPaste}>
                  Вставить текст
                </button>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".yaml,.yml,.txt"
              style={{ display: "none" }}
              onChange={(e) => {
                pkg.pickFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {/* Редактор показывается, как только файл ЗАВЕДЁН (в том числе пустой,
              созданный кнопкой «Вставить текст»), а не когда в нём уже есть текст:
              иначе вставлять было некуда — чип есть, поля нет. */}
          <div className={drop.over ? "drop-zone--over" : undefined} {...drop.bind}>
            {pkg.files.length === 0 ? (
              <button type="button" style={dropHint} onClick={() => fileRef.current?.click()}>
                Перетащите сюда YAML-ответы агента — по файлу на репозиторий — или нажмите,
                чтобы выбрать их на диске. Можно и вставить текстом: план обновления
                посчитается сам.
              </button>
            ) : (
              <textarea
                style={fileArea}
                value={pkg.files[pkg.active]?.content ?? ""}
                onChange={(e) => pkg.setText(pkg.active, e.target.value)}
                placeholder="Вставьте сюда YAML от агента"
                spellCheck={false}
              />
            )}
          </div>
          {drop.error && <p style={{ ...grayLine, color: "#b45309", marginTop: 6 }}>{drop.error}</p>}

          {pkg.files.length > 0 && (
            <>
              <div style={{ margin: "12px 0 6px" }}>
                {POLICY_LABELS.map((p) => (
                  <label
                    key={p.key}
                    style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}
                    title={p.hint}
                  >
                    <input
                      type="checkbox"
                      checked={policies[p.key]}
                      onChange={(e) => setPolicies((s) => ({ ...s, [p.key]: e.target.checked }))}
                    />
                    <span style={{ fontSize: 12.5, color: "#334155" }}>{p.title}</span>
                  </label>
                ))}
              </div>

              {checking && <p style={grayLine}>Сверяем со схемой…</p>}
              {preview && !preview.ok && (
                <NoteList title="YAML не читается" items={preview.errors ?? []} />
              )}
              {preview?.ok && (
                <>
                  <p style={{ ...grayLine, color: "#0f172a", fontWeight: 600 }}>
                    {planSummary(preview)}
                  </p>
                  {sections.map((s) => (
                    <div key={s.key} style={{ marginBottom: 10 }}>
                      <p
                        style={{
                          margin: "0 0 4px",
                          fontSize: 12,
                          fontWeight: 600,
                          color: s.attention ? "#b45309" : "#334155",
                        }}
                      >
                        {s.title} · {s.rows.length}
                      </p>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "#475569" }}>
                        {s.rows.map((r) => (
                          <li key={r.path}>
                            {r.path}
                            {r.note && <span style={{ color: "#94a3b8" }}> — {r.note}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {!!preview.conflicts?.length && (
                    <NoteList title="Есть нюанс" items={preview.conflicts} />
                  )}
                  {!!preview.warnings?.length && (
                    <NoteList title="Стоит проверить глазами" items={preview.warnings} />
                  )}
                </>
              )}
              {applyError && (
                <p style={{ ...grayLine, color: "#b91c1c" }}>{applyError}</p>
              )}
            </>
          )}
        </div>
      </div>

      <div style={footRow}>
        <button type="button" style={secondaryBtn} onClick={onClose}>
          Отмена
        </button>
        <button type="button" style={primaryBtn} onClick={apply} disabled={!canApply}>
          {applying ? "Применяем…" : "Применить"}
        </button>
      </div>
    </Modal>
  );
}
