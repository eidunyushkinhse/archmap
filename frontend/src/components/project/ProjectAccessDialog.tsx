import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { getMe } from "../../api/auth";
import { projectsApi, usersApi } from "../../api/projects";
import type { Project, ProjectMember, UserBrief } from "../../types";
import ConfirmDialog from "../../ui/ConfirmDialog";
import Modal from "../../ui/Modal";
import { input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";

/**
 * Окно «Доступ к проекту» (docs/tasks/project-access.md): видимость всем,
 * участники с ролями, добавление по логину, передача владения. Управляет только
 * владелец (у администратора действующая роль в любом проекте тоже owner);
 * остальным окно показывает то же самое только для чтения.
 *
 * Состояние на сервере — источник правды: после каждой правки список участников
 * перечитывается, а карточка проекта (видимость, владелец, моя роль) берётся из
 * ответа. onChanged — сигнал странице проектов освежить список.
 */

interface Props {
  project: Project;
  onClose: () => void;
  onChanged: () => void;
}

type EditableRole = "editor" | "reader";

const ROLE_LABEL: Record<ProjectMember["role"], string> = {
  owner: "Владелец",
  editor: "Редактор",
  reader: "Читатель",
};

/** Кандидаты в участники: активные пользователи, которых ещё нет в проекте. */
function addCandidates(users: UserBrief[], members: ProjectMember[]): UserBrief[] {
  const taken = new Set(members.map((m) => m.user_id));
  return users.filter((u) => !taken.has(u.id));
}

export default function ProjectAccessDialog({ project: initial, onClose, onChanged }: Props) {
  const [project, setProject] = useState(initial);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [users, setUsers] = useState<UserBrief[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Добавление: логин из подсказок и роль.
  const [login, setLogin] = useState("");
  const [newRole, setNewRole] = useState<EditableRole>("editor");
  // Передача владения: выбор пользователя, затем подтверждение.
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const [confirming, setConfirming] = useState(false);

  const isOwner = project.my_role === "owner";

  const reloadMembers = useCallback(async () => {
    setMembers(await projectsApi.members(project.id));
  }, [project.id]);

  useEffect(() => {
    projectsApi
      .members(project.id)
      .then(setMembers)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Не удалось загрузить участников"));
  }, [project.id]);

  // Список пользователей нужен только тому, кто добавляет и передаёт.
  useEffect(() => {
    if (!isOwner) return;
    usersApi.list().then(setUsers).catch(() => setUsers([]));
  }, [isOwner]);

  const candidates = useMemo(() => addCandidates(users, members), [users, members]);
  const owner = members.find((m) => m.role === "owner") ?? null;
  const transferTargets = users.filter((u) => u.id !== owner?.user_id);
  const transferUser = transferTargets.find((u) => u.id === transferTo) ?? null;

  // Одна обёртка для всех правок: занятость, ошибка, перечитать участников.
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reloadMembers();
      onChanged();
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function toggleVisible(next: boolean) {
    void act(async () => setProject(await projectsApi.update(project.id, { visible_to_all: next })));
  }

  function addMember() {
    const name = login.trim();
    const user = users.find((u) => u.username === name);
    if (!user) {
      setError("Нет такого пользователя");
      return;
    }
    if (members.some((m) => m.user_id === user.id)) {
      setError("Пользователь уже в проекте");
      return;
    }
    void act(() => projectsApi.putMember(project.id, user.id, newRole)).then((ok) => {
      if (ok) setLogin("");
    });
  }

  async function transfer() {
    if (!transferUser) return;
    const ok = await act(async () => setProject(await projectsApi.transfer(project.id, transferUser.id)));
    setConfirming(false);
    if (ok) {
      setTransferOpen(false);
      setTransferTo("");
    }
  }

  // Подтверждение говорит, кто останется редактором: обычно это сам владелец,
  // но администратор передаёт и чужой проект.
  const meName = getMe()?.username ?? null;
  const stays = !owner || owner.username === meName
    ? "Вы останетесь редактором."
    : `${owner.username} останется редактором.`;

  return (
    <>
      <Modal onClose={onClose} boxStyle={{ width: 520, padding: 24, maxHeight: "86vh", overflowY: "auto" }}>
        <h3 style={title}>Доступ к проекту</h3>
        <p style={subtitle}>{project.name}</p>

        <label style={checkRow}>
          <input
            type="checkbox"
            checked={project.visible_to_all}
            disabled={!isOwner || busy}
            onChange={(e) => toggleVisible(e.target.checked)}
          />
          <span>
            Виден всем пользователям
            <span style={hint}>Остальные пользователи смогут только смотреть</span>
          </span>
        </label>

        <div style={sectionLabel}>Участники</div>
        <div style={list}>
          {members.map((m, i) => (
            <div key={m.user_id} style={{ ...row, borderTop: i === 0 ? "none" : row.borderTop }} data-testid={`member-${m.username}`}>
              <span style={loginCell}>{m.username}</span>
              {m.role === "owner" ? (
                <>
                  <span style={ownerTag}>Владелец</span>
                  {isOwner && (
                    <button style={linkBtn} disabled={busy} onClick={() => setTransferOpen((o) => !o)}>
                      Передать владение
                    </button>
                  )}
                </>
              ) : isOwner ? (
                <>
                  <select
                    aria-label={`Роль ${m.username}`}
                    style={roleSelect}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => void act(() => projectsApi.putMember(project.id, m.user_id, e.target.value as EditableRole))}
                  >
                    <option value="editor">Редактор</option>
                    <option value="reader">Читатель</option>
                  </select>
                  <button
                    style={{ ...linkBtn, color: "#dc2626" }}
                    disabled={busy}
                    aria-label={`Удалить ${m.username}`}
                    onClick={() => void act(() => projectsApi.removeMember(project.id, m.user_id))}
                  >
                    Удалить
                  </button>
                </>
              ) : (
                <span style={roleText}>{ROLE_LABEL[m.role]}</span>
              )}
            </div>
          ))}
        </div>

        {isOwner && transferOpen && (
          <div style={panel}>
            <label style={labelStyle} htmlFor="transfer-to">Новый владелец</label>
            <div style={inlineRow}>
              <select
                id="transfer-to"
                style={{ ...input, marginBottom: 0, flex: 1 }}
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
              >
                <option value="">Выберите пользователя</option>
                {transferTargets.map((u) => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>
              <button style={primaryBtn} disabled={!transferUser || busy} onClick={() => setConfirming(true)}>
                Передать
              </button>
            </div>
          </div>
        )}

        {isOwner ? (
          <div style={panel}>
            <label style={labelStyle} htmlFor="member-login">Добавить участника</label>
            <div style={inlineRow}>
              <input
                id="member-login"
                style={{ ...input, marginBottom: 0, flex: 1 }}
                list="member-candidates"
                placeholder="Логин"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addMember(); }}
              />
              <datalist id="member-candidates">
                {candidates.map((u) => <option key={u.id} value={u.username} />)}
              </datalist>
              <select
                aria-label="Роль нового участника"
                style={roleSelect}
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as EditableRole)}
              >
                <option value="editor">Редактор</option>
                <option value="reader">Читатель</option>
              </select>
              <button style={primaryBtn} disabled={!login.trim() || busy} onClick={addMember}>
                Добавить
              </button>
            </div>
          </div>
        ) : (
          <p style={readOnlyNote}>Менять доступ может владелец проекта.</p>
        )}

        {error && <p style={err}>{error}</p>}

        <div style={{ display: "flex", marginTop: 18 }}>
          <button style={secondaryBtn} onClick={onClose}>Закрыть</button>
        </div>
      </Modal>

      {/* Подтверждение — СИБЛИНГОМ окна, не внутри: вложенный <dialog> ломает Escape. */}
      {confirming && transferUser && (
        <ConfirmDialog
          title={`Передать проект «${project.name}» пользователю ${transferUser.username}?`}
          lead={stays}
          error={error}
          confirmLabel="Передать"
          busyLabel="Передаём…"
          busy={busy}
          onConfirm={() => void transfer()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

const title: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 700, color: "#0f172a" };
const subtitle: CSSProperties = { margin: "4px 0 16px", fontSize: 13.5, color: "#64748b" };
const checkRow: CSSProperties = {
  display: "flex", alignItems: "flex-start", gap: 9, fontSize: 14, fontWeight: 600,
  color: "#1e293b", cursor: "pointer", marginBottom: 18,
};
const hint: CSSProperties = { display: "block", fontSize: 12.5, fontWeight: 400, color: "#64748b", marginTop: 2 };
const sectionLabel: CSSProperties = { fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 6 };
const list: CSSProperties = { border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" };
const row: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
  borderTop: "1px solid #f1f5f9", fontSize: 14,
};
const loginCell: CSSProperties = {
  flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  color: "#0f172a", fontWeight: 600,
};
const ownerTag: CSSProperties = {
  padding: "2px 8px", borderRadius: 999, background: "#eff6ff", color: "#1d4ed8",
  fontSize: 12, fontWeight: 600,
};
const roleText: CSSProperties = { color: "#64748b", fontSize: 13 };
const roleSelect: CSSProperties = {
  padding: "6px 8px", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13,
  color: "#0f172a", background: "#fff",
};
const linkBtn: CSSProperties = {
  background: "none", border: "none", padding: "4px 2px", fontSize: 13, fontWeight: 600, color: "#2563eb",
};
const panel: CSSProperties = { marginTop: 16 };
const inlineRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const readOnlyNote: CSSProperties = { margin: "14px 0 0", fontSize: 13, color: "#64748b" };
const err: CSSProperties = { color: "#dc2626", fontSize: 13, margin: "10px 0 0" };
