import { useState } from "react";
import type { CSSProperties } from "react";
import { tokensApi } from "../../api/tokens";
import { useAsyncLoad } from "../../lib/useAsyncLoad";
import type { PersonalToken, PersonalTokenCreate, PersonalTokenCreated } from "../../types";
import ConfirmDialog from "../../ui/ConfirmDialog";
import DialogTitle from "../../ui/DialogTitle";
import LoadError from "../../ui/LoadError";
import Modal from "../../ui/Modal";
import { errText, input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";
import { useBusyAction } from "../../ui/useBusyAction";
import IssuedTokenView from "./IssuedTokenView";

/**
 * «Токены для агентов» из меню профиля (docs/plan-remote-mcp.md, Ф5): свои личные токены,
 * выпуск и отзыв. Токен подключает ИИ-агента к ArchMap по адресу …/mcp; права агента — ваши,
 * удалять он не может. Секрет показывается ОДИН раз — сразу после выпуска (IssuedTokenView);
 * живёт только в состоянии окна: ни хранилища браузера, ни кэша api.
 */

interface Props {
  onClose: () => void;
}

type Lifetime = PersonalTokenCreate["lifetime_days"];

const LIFETIMES: { value: string; days: Lifetime; label: string }[] = [
  { value: "30", days: 30, label: "30 дней" },
  { value: "90", days: 90, label: "90 дней" },
  { value: "365", days: 365, label: "Год" },
  { value: "none", days: null, label: "Бессрочно" },
];

/** Имя по умолчанию: «Агент», а если занято — «Агент 2», «Агент 3»… (имя уникально). */
function defaultTokenName(tokens: PersonalToken[]): string {
  const taken = new Set(tokens.map((t) => t.name));
  if (!taken.has("Агент")) return "Агент";
  let n = 2;
  while (taken.has(`Агент ${n}`)) n += 1;
  return `Агент ${n}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

// Строка под именем токена: когда пользовались и до какого числа действует.
function tokenMeta(t: PersonalToken): string {
  const used = t.last_used_at ? `использовался ${fmtDate(t.last_used_at)}` : "не использовался";
  return `${used} · ${t.expires_at ? `до ${fmtDate(t.expires_at)}` : "бессрочно"}`;
}

export default function AgentTokensDialog({ onClose }: Props) {
  const tokens = useAsyncLoad("tokens", tokensApi.list);
  // null — имя ещё не трогали: подставляется свободное по умолчанию.
  const [name, setName] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
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
  const shownName = name ?? defaultTokenName(list);
  const canIssue = shownName.trim().length > 0 && !issue.busy && tokens.data !== null;

  async function submit() {
    if (!canIssue) return;
    const days = LIFETIMES.find((l) => l.value === lifetime)?.days ?? 90;
    await issue.run(async () => {
      setIssued(await tokensApi.create({ name: shownName.trim(), read_only: readOnly, lifetime_days: days }));
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
      <Modal onClose={onClose} onSubmit={submit} boxStyle={{ width: 560, padding: 24, maxHeight: "86vh", overflowY: "auto" }}>
        <DialogTitle lead="С токеном ИИ-агент работает в ArchMap от вашего имени, но ничего не удаляет.">
          Токены для агентов
        </DialogTitle>

        {tokens.error !== null ? (
          <LoadError what="токены" error={tokens.error} onRetry={tokens.reload} />
        ) : tokens.loading && tokens.data === null ? (
          <p style={muted}>Загрузка…</p>
        ) : list.length > 0 && (
          <div style={listBox}>
            {list.map((t, i) => (
              <div key={t.id} style={{ ...row, borderTop: i === 0 ? "none" : row.borderTop }} data-testid={`token-${t.name}`}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={nameLine}>
                    <span style={nameCell}>{t.name}</span>
                    <code style={prefixCell}>{t.prefix}…</code>
                    {t.read_only && <span style={roTag}>только чтение</span>}
                  </div>
                  <div style={metaLine}>{tokenMeta(t)}</div>
                </div>
                <button
                  style={revokeBtn}
                  aria-label={`Отозвать ${t.name}`}
                  onClick={() => { setRevokeError(null); setRevoking(t); }}
                >
                  Отозвать
                </button>
              </div>
            ))}
          </div>
        )}

        {list.length > 0 && <div style={sectionLabel}>Новый токен</div>}
        <div style={fieldsRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle} htmlFor="tok-name">Название</label>
            <input
              id="tok-name"
              data-autofocus
              style={input}
              maxLength={64}
              value={shownName}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div style={{ width: 150, flex: "none" }}>
            <label style={labelStyle} htmlFor="tok-life">Срок действия</label>
            <select id="tok-life" style={input} value={lifetime} onChange={(e) => setLifetime(e.target.value)}>
              {LIFETIMES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
        </div>
        <label style={checkRow}>
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          <span>Только чтение</span>
        </label>

        {issue.error && <p style={errText}>{issue.error}</p>}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button style={{ ...primaryBtn, opacity: canIssue ? 1 : 0.55 }} disabled={!canIssue} onClick={() => void submit()}>
            {issue.busy ? "Выпускаем…" : "Выпустить токен"}
          </button>
          <button style={secondaryBtn} onClick={onClose}>Закрыть</button>
        </div>
      </Modal>

      {/* Подтверждение — СИБЛИНГОМ окна, не внутри: вложенный <dialog> ломает Escape. */}
      {revoking && (
        <ConfirmDialog
          title={`Отозвать токен «${revoking.name}»?`}
          lead="Агент с этим токеном сразу потеряет доступ."
          error={revokeError}
          confirmLabel="Отозвать"
          busyLabel="Отзываем…"
          busy={revokeBusy}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </>
  );
}

const muted: CSSProperties = { margin: "0 0 4px", fontSize: 14, color: "#64748b" };
const listBox: CSSProperties = { border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" };
const row: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
  borderTop: "1px solid #f1f5f9", fontSize: 14,
};
const nameLine: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
const nameCell: CSSProperties = {
  minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  color: "#0f172a", fontWeight: 600,
};
const prefixCell: CSSProperties = { fontSize: 12.5, color: "#64748b" };
const roTag: CSSProperties = {
  padding: "2px 8px", borderRadius: 999, background: "#f1f5f9", color: "#475569",
  fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
};
const metaLine: CSSProperties = { marginTop: 2, fontSize: 12.5, color: "#64748b" };
const revokeBtn: CSSProperties = {
  background: "none", border: "none", padding: "4px 2px", fontSize: 13, fontWeight: 600,
  color: "#dc2626", cursor: "pointer",
};
const sectionLabel: CSSProperties = { fontSize: 13, fontWeight: 600, color: "#475569", margin: "20px 0 10px" };
const fieldsRow: CSSProperties = { display: "flex", gap: 12, alignItems: "flex-start" };
const checkRow: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, color: "#1e293b",
  cursor: "pointer", margin: "0 0 16px",
};
