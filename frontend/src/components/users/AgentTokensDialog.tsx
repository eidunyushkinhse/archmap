import { useState } from "react";
import { tokensApi } from "../../api/tokens";
import { useAsyncLoad } from "../../lib/useAsyncLoad";
import type { PersonalToken, PersonalTokenCreate, PersonalTokenCreated } from "../../types";
import ConfirmDialog from "../../ui/ConfirmDialog";
import LoadError from "../../ui/LoadError";
import Modal from "../../ui/Modal";
import { ChevronDownIcon, CloseIcon } from "../../ui/icons";
import { useBusyAction } from "../../ui/useBusyAction";
import IssuedTokenView from "./IssuedTokenView";
import "../../ui/ds.css";
import "./userDialogs.css";

/**
 * «Токены для MCP» из меню профиля (docs/plan-remote-mcp.md, Ф5): свои личные токены,
 * выпуск и отзыв. Токен подключает ИИ-агента к ArchMap по адресу …/mcp; права агента — ваши,
 * удаляет он только пачкой с версией перед удалением (app/deletions.py). Секрет показывается ОДИН раз — сразу после выпуска (IssuedTokenView);
 * живёт только в состоянии окна: ни хранилища браузера, ни кэша api.
 *
 * Вид (редизайн, фаза 9д): каркас окна нового языка (ui/ds.css, ds-win), токены тихими
 * строками без коробки (название, префикс, доступ словом, под ними когда пользовались и
 * срок; «Отозвать» тихой красной кнопкой-текстом), блок «Новый токен» строками «подпись —
 * поле в рамке» (users/userDialogs.css), в подвале «Выпустить токен» и «Закрыть».
 */

interface Props {
  // «Пользователю» (роль viewer) токен положен только для чтения — правило держит бэк
  // (app/personal_tokens.py), здесь выбор доступа лишь показан закрытым.
  readOnlyOnly: boolean;
  onClose: () => void;
}

type Lifetime = PersonalTokenCreate["lifetime_days"];

const LIFETIMES: { value: string; days: Lifetime; label: string }[] = [
  { value: "30", days: 30, label: "30 дней" },
  { value: "90", days: 90, label: "90 дней" },
  { value: "365", days: 365, label: "Год" },
  { value: "none", days: null, label: "Бессрочно" },
];

// Что умеет токен: всё, что владелец (кроме удаления без версии), только читать или
// только сообщать ArchMap о слиянии в репозитории из CI (backend/app/code_changes.py).
type Access = "full" | "read" | "ci";

const ACCESS: { value: Access; label: string }[] = [
  { value: "full", label: "Полный" },
  { value: "read", label: "Только чтение" },
  { value: "ci", label: "Только сигнал из CI" },
];

/** Имя по умолчанию: «Агент» (у токена CI «CI»), а если занято — «Агент 2», «Агент 3»…
 *  (имя уникально). */
function defaultTokenName(tokens: PersonalToken[], base: string): string {
  const taken = new Set(tokens.map((t) => t.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

// Строка под именем токена: когда пользовались и до какого числа действует.
function tokenMeta(t: PersonalToken): string {
  const used = t.last_used_at ? `использовался ${fmtDate(t.last_used_at)}` : "не использовался";
  return `${used}, ${t.expires_at ? `до ${fmtDate(t.expires_at)}` : "бессрочно"}`;
}

export default function AgentTokensDialog({ readOnlyOnly, onClose }: Props) {
  const tokens = useAsyncLoad("tokens", tokensApi.list);
  // null — имя ещё не трогали: подставляется свободное по умолчанию.
  const [name, setName] = useState<string | null>(null);
  const [access, setAccess] = useState<Access>("full");
  const shownAccess: Access = readOnlyOnly ? "read" : access;
  const [lifetime, setLifetime] = useState("90");
  const [issued, setIssued] = useState<PersonalTokenCreated | null>(null);
  const [revoking, setRevoking] = useState<PersonalToken | null>(null);
  // Выпуск сменяет вид окна (секрет), а «Готово» закрывает окно целиком — занятость
  // формы после успеха снимать не нужно, как и задумано в useBusyAction.
  const issue = useBusyAction("Не удалось выпустить токен");
  // Отзыв — своё состояние: окно живёт дальше, и следующий отзыв не должен застать
  // кнопку подтверждения «занятой».
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const list = tokens.data ?? [];
  const shownName = name ?? defaultTokenName(list, shownAccess === "ci" ? "CI" : "Агент");
  const canIssue = shownName.trim().length > 0 && !issue.busy && tokens.data !== null;

  async function submit() {
    if (!canIssue) return;
    // «Бессрочно» — найденный вариант с days: null (токен без срока); запасные 90 дней —
    // только если вариант не найден. `?.days ?? 90` путало эти случаи и выпускало
    // «бессрочный» токен на 90 дней.
    const picked = LIFETIMES.find((l) => l.value === lifetime);
    const days: Lifetime = picked === undefined ? 90 : picked.days;
    await issue.run(async () => {
      setIssued(await tokensApi.create({
        name: shownName.trim(),
        read_only: shownAccess === "read",
        ci_only: shownAccess === "ci",
        lifetime_days: days,
      }));
    });
  }

  async function confirmRevoke() {
    const target = revoking;
    if (!target || revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await tokensApi.revoke(target.id);
      setRevoking(null);
      // Убираем строку на месте: перечитывание мигнуло бы «Загрузкой…» вместо списка.
      tokens.update((all) => all.filter((t) => t.id !== target.id));
    } catch (e: unknown) {
      setRevokeError(e instanceof Error ? e.message : "Не удалось отозвать токен");
    } finally {
      setRevokeBusy(false);
    }
  }

  if (issued) {
    return <IssuedTokenView issued={issued} onDone={onClose} />;
  }

  return (
    <>
      <Modal onClose={onClose} onSubmit={submit} closeButton={false} boxStyle={{ width: 560, padding: 0 }}>
        <div className="ds ds-win">
          <div className="ds-win-head">
            <h2 className="ds-win-title">Токены для MCP</h2>
            <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>

          <div className="ds-win-body">
            {tokens.error !== null ? (
              <LoadError what="токены" error={tokens.error} onRetry={tokens.reload} />
            ) : tokens.loading && tokens.data === null ? (
              <p className="ds-empty ud-flat">Загрузка</p>
            ) : list.length > 0 && (
              <section className="ds-win-block">
                <ul className="ud-tokens">
                  {list.map((t) => (
                    <li key={t.id} className="ud-token" data-testid={`token-${t.name}`}>
                      <div className="ud-token-text">
                        <div className="ud-token-line">
                          <span className="ud-token-name">{t.name}</span>
                          <code className="ds-mono ud-token-prefix">{t.prefix}…</code>
                          {t.read_only && <span className="ud-token-access">только чтение</span>}
                          {t.ci_only && <span className="ud-token-access">сигнал из CI</span>}
                        </div>
                        <div className="ud-token-meta">{tokenMeta(t)}</div>
                      </div>
                      <button
                        type="button"
                        className="ud-revoke"
                        aria-label={`Отозвать ${t.name}`}
                        onClick={() => { setRevokeError(null); setRevoking(t); }}
                      >
                        Отозвать
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="ds-win-block">
              {list.length > 0 && <h3 className="ds-win-block-title">Новый токен</h3>}
              <dl className="ds-props ud-props">
                <div className="ds-prop">
                  <dt className="ds-prop-term"><label htmlFor="tok-name">Название</label></dt>
                  <dd className="ds-prop-value">
                    <input
                      id="tok-name"
                      className="ds-input"
                      data-autofocus
                      maxLength={64}
                      value={shownName}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </dd>
                </div>
                <div className="ds-prop">
                  <dt className="ds-prop-term"><label htmlFor="tok-life">Срок действия</label></dt>
                  <dd className="ds-prop-value">
                    <span className="ds-select">
                      <select id="tok-life" value={lifetime} onChange={(e) => setLifetime(e.target.value)}>
                        {LIFETIMES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                      </select>
                      <ChevronDownIcon />
                    </span>
                  </dd>
                </div>
                <div className="ds-prop">
                  <dt className="ds-prop-term"><label htmlFor="tok-access">Доступ</label></dt>
                  <dd className="ds-prop-value">
                    <span className="ds-select">
                      <select
                        id="tok-access"
                        value={shownAccess}
                        disabled={readOnlyOnly}
                        onChange={(e) => setAccess(ACCESS.find((a) => a.value === e.target.value)?.value ?? "full")}
                      >
                        {ACCESS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                      </select>
                      <ChevronDownIcon />
                    </span>
                  </dd>
                </div>
              </dl>
            </section>
          </div>

          <div className="ds-win-foot">
            {issue.error && <p className="ds-danger ds-win-err" role="alert">{issue.error}</p>}
            <button type="button" className="ds-btn ds-btn--primary" disabled={!canIssue} onClick={() => void submit()}>
              {issue.busy ? "Выпускаем" : "Выпустить токен"}
            </button>
            <button type="button" className="ds-btn" onClick={onClose}>Закрыть</button>
          </div>
        </div>
      </Modal>

      {/* Подтверждение — СИБЛИНГОМ окна, не внутри: вложенный <dialog> ломает Escape. */}
      {revoking && (
        <ConfirmDialog
          title={`Отозвать токен «${revoking.name}»?`}
          lead="Агент с этим токеном сразу потеряет доступ."
          error={revokeError}
          confirmLabel="Отозвать"
          busyLabel="Отзываем"
          busy={revokeBusy}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </>
  );
}
