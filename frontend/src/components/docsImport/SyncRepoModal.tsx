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
import type { SyncApplyOut, SyncPreviewOut } from "../../types";
import { projectsApi, type SyncPolicies } from "../../api/projects";
import { ApiError } from "../../api/client";
import { useDocsFiles, MAX_FILES } from "./useDocsFiles";
import { planSections, planSummary, applySummary } from "./syncPlanView";
import { NoteList } from "./agentModalReport";
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

const POLICY_LABELS: { key: keyof SyncPolicies; title: string; hint: string }[] = [
  {
    key: "update_descriptions",
    title: "Обновлять описания",
    hint: "Проза агента перезапишет описания. Выключено: она меняется от прогона к прогону.",
  },
  {
    key: "update_names",
    title: "Применять переименования",
    hint: "Имена из прогона заменят текущие. Переименования видны в плане и без этого.",
  },
  {
    key: "sync_components",
    title: "Синхронизировать компоненты",
    hint: "Внутренний слой (компоненты сервисов). Выключено: его состав нестабилен.",
  },
  {
    key: "mark_missing_deprecated",
    title: "Помечать пропавшие устаревшими",
    hint: "Пропавшим ставится статус «устаревший». Удаления не происходит никогда.",
  },
];

export default function SyncRepoModal({ projectId, onClose, onApplied }: Props) {
  // Имя системы в промпте = имя проекта: грузим здесь, а не тащим пропом через
  // оболочку — она его тоже не знает (в шапке имя рисует ProjectSwitcher).
  const [projectName, setProjectName] = useState("");
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [hints, setHints] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);
  const pkg = useDocsFiles();
  const [policies, setPolicies] = useState<SyncPolicies>({
    update_descriptions: false,
    update_names: false,
    sync_components: false,
    mark_missing_deprecated: false,
  });
  const [rawPreview, setRawPreview] = useState<SyncPreviewOut | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

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

  const copyPrompt = () => {
    projectsApi
      .importPrompt({ systemName: projectName, depth: 3, lang, hints: hints.trim() || undefined })
      .then((r) => navigator.clipboard.writeText(r.prompt))
      .then(() => {
        setPromptCopied(true);
        window.setTimeout(() => setPromptCopied(false), 1800);
      })
      .catch(() => setPromptCopied(false));
  };

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
            ? "Схема изменилась в другой сессии — план устарел. Закройте окно и повторите."
            : "Не удалось применить. Проверьте соединение и повторите.",
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
        Запустите промпт своим агентом в каждом репозитории системы и вставьте ответы сюда.
        Схема обновится, а раскладка, схемы логики, спецификации и бизнес-процессы останутся
        на месте. Ничего не удаляется.
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
          <button
            type="button"
            style={{ ...secondaryBtn, marginTop: 10 }}
            onClick={copyPrompt}
            disabled={!projectName}
          >
            {promptCopied ? "Скопировано" : "Скопировать промпт"}
          </button>
          <p style={leftNote}>
            Имя системы в промпте — «{projectName}». Один и тот же промпт запускается в каждом
            репозитории; объекты опознаются по источнику (git-remote, образ, сетевое имя),
            поэтому переименованный сервис не задвоится.
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
                <button type="button" style={chip} onClick={() => fileRef.current?.click()}>
                  Загрузить файлы…
                </button>
                <button type="button" style={chip} onClick={pkg.addPaste}>
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
          {pkg.files.length === 0 ? (
            <div style={dropHint}>
              Загрузите YAML-ответы агента — по файлу на репозиторий — или вставьте текстом.
              План обновления посчитается автоматически.
            </div>
          ) : (
            <>
              <textarea
                style={fileArea}
                value={pkg.files[pkg.active]?.content ?? ""}
                onChange={(e) => pkg.setText(pkg.active, e.target.value)}
                placeholder="Вставьте сюда YAML-ответ агента"
                spellCheck={false}
              />

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

              {checking && <p style={grayLine}>Считаем план…</p>}
              {preview && !preview.ok && (
                <NoteList title="Не удалось разобрать" items={preview.errors ?? []} />
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
                    <NoteList title="Решено правилом" items={preview.conflicts} />
                  )}
                  {!!preview.warnings?.length && (
                    <NoteList title="Проверьте глазами" items={preview.warnings} />
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
