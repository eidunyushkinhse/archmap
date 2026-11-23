import { useCallback, useEffect, useMemo, useState } from "react";
import { getMe } from "../../api/auth";
import { projectsApi, usersApi } from "../../api/projects";
import type { Project, ProjectMember, UserBrief } from "../../types";
import ConfirmDialog from "../../ui/ConfirmDialog";
import Modal from "../../ui/Modal";
import { ChevronDownIcon, CloseIcon } from "../../ui/icons";
import { noAutofill } from "../../ui/noAutofill";
import "../../ui/ds.css";
import "./projectAccess.css";

/**
 * Окно «Доступ к проекту» (docs/tasks/project-access.md): видимость всем,
 * участники с ролями, добавление по логину, передача владения. Управляет только
 * владелец (у администратора действующая роль в любом проекте тоже owner);
 * остальным окно показывает то же самое только для чтения. «Пользователь» (can_edit
 * false) бывает только читателем: редактором его не назначить и проект ему не передать
 * — правило держит бэк (app/access.py), окно лишь не предлагает лишнего.
 *
 * Состояние на сервере — источник правды: после каждой правки список участников
 * перечитывается, а карточка проекта (видимость, владелец, моя роль) берётся из
 * ответа. onChanged — сигнал странице проектов освежить список.
 *
 * Вид (редизайн, фаза 9г): каркас окна нового языка (ui/ds.css, ds-win), имя проекта
 * тихой первой строкой, флажок видимости с пояснением в подсказке, участники тихими
 * строками 30px (роль и действие у всех на одной вертикали, projectAccess.css), под
 * ними строки передачи владения и добавления. Флажок и смена роли в списке пишут сразу,
 * без кнопки. В подвале одна «Закрыть»: главного действия у окна нет.
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

  // Ответ по прежнему проекту (окно переоткрыли на другом) не применяем (аудит F-49).
  useEffect(() => {
    let alive = true;
    projectsApi
      .members(project.id)
      .then((ms) => { if (alive) setMembers(ms); })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Не удалось загрузить участников");
      });
    return () => { alive = false; };
  }, [project.id]);

  // Список пользователей нужен только тому, кто добавляет и передаёт.
  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    usersApi.list()
      .then((us) => { if (alive) setUsers(us); })
      .catch(() => { if (alive) setUsers([]); });
    return () => { alive = false; };
  }, [isOwner]);

  const candidates = useMemo(() => addCandidates(users, members), [users, members]);
  const owner = members.find((m) => m.role === "owner") ?? null;
  // Пока список пользователей не пришёл, ничего не запрещаем: последнее слово за бэком.
  const canEdit = (userId: string) => users.find((u) => u.id === userId)?.can_edit ?? true;
  const transferTargets = users.filter((u) => u.id !== owner?.user_id && u.can_edit);
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

  // Набран логин «Пользователя» — роль нового участника только «Читатель».
  const typed = users.find((u) => u.username === login.trim()) ?? null;
  const onlyReader = typed !== null && !typed.can_edit;
  const addRole: EditableRole = onlyReader ? "reader" : newRole;

  function addMember() {
    const user = typed;
    if (!user) {
      setError("Нет такого пользователя");
      return;
    }
    if (members.some((m) => m.user_id === user.id)) {
      setError("Пользователь уже в проекте");
      return;
    }
    void act(() => projectsApi.putMember(project.id, user.id, addRole)).then((ok) => {
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
      <Modal onClose={onClose} boxStyle={{ width: 520, padding: 0 }}>
        <div className="ds ds-win">
          <div className="ds-win-head">
            <h2 className="ds-win-title">Доступ к проекту</h2>
            <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>

          <div className="ds-win-body">
            <p className="ds-win-lead">{project.name}</p>

            <label className="ds-check" title="Остальные пользователи смогут только смотреть">
              <input
                type="checkbox"
                checked={project.visible_to_all}
                disabled={!isOwner || busy}
                onChange={(e) => toggleVisible(e.target.checked)}
              />
              <span>Виден всем пользователям</span>
            </label>

            <section className="ds-win-block pa-block">
              <h3 className="ds-win-block-title">Участники</h3>
              <div className={"pa-members " + (isOwner ? "pa-members--edit" : "pa-members--read")}>
                {members.map((m) => (
                  <div key={m.user_id} className="pa-member" data-testid={`member-${m.username}`}>
                    <span className="pa-login" title={m.username}>{m.username}</span>
                    {m.role === "owner" ? (
                      <>
                        <span className="pa-role">{ROLE_LABEL.owner}</span>
                        {isOwner && (
                          <button
                            type="button"
                            className="ds-add"
                            aria-expanded={transferOpen}
                            disabled={busy}
                            onClick={() => setTransferOpen((o) => !o)}
                          >
                            Передать владение
                          </button>
                        )}
                      </>
                    ) : isOwner ? (
                      <>
                        <span className="ds-select">
                          <select
                            aria-label={`Роль ${m.username}`}
                            value={m.role}
                            disabled={busy}
                            onChange={(e) => void act(() => projectsApi.putMember(project.id, m.user_id, e.target.value as EditableRole))}
                          >
                            <option value="editor" disabled={!canEdit(m.user_id)}>Редактор</option>
                            <option value="reader">Читатель</option>
                          </select>
                          <ChevronDownIcon />
                        </span>
                        <button
                          type="button"
                          className="pa-del"
                          disabled={busy}
                          aria-label={`Удалить ${m.username}`}
                          onClick={() => void act(() => projectsApi.removeMember(project.id, m.user_id))}
                        >
                          Удалить
                        </button>
                      </>
                    ) : (
                      <span className="pa-role">{ROLE_LABEL[m.role]}</span>
                    )}
                  </div>
                ))}

                {/* Строки передачи владения и добавления стоят в той же сетке, что
                    участники: «Передать», «Добавить» и список роли нового участника — на
                    вертикалях действий и ролей списка. */}
                {isOwner && transferOpen && (
                  <div className="pa-addrow pa-gap">
                    <div className="pa-line pa-pick">
                      <label className="pa-line-cap" htmlFor="transfer-to">Новый владелец</label>
                      <span className="ds-select pa-line-grow">
                        <select id="transfer-to" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                          <option value="">Выберите пользователя</option>
                          {transferTargets.map((u) => (
                            <option key={u.id} value={u.id}>{u.username}</option>
                          ))}
                        </select>
                        <ChevronDownIcon />
                      </span>
                    </div>
                    <button type="button" className="ds-btn" disabled={!transferUser || busy} onClick={() => setConfirming(true)}>
                      Передать
                    </button>
                  </div>
                )}

                {isOwner && (
                  <div className="pa-addrow pa-gap">
                    {/* Видимой подписи у поля нет: строка стоит под списком участников и
                        говорит сама за себя, подпись — для скринридера. */}
                    <label className="ds-sr" htmlFor="member-login">Добавить участника</label>
                    <input
                      {...noAutofill("project-access-dialog-1")}
                      id="member-login"
                      className="ds-input"
                      list="member-candidates"
                      placeholder="Логин"
                      value={login}
                      onChange={(e) => setLogin(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addMember(); }}
                    />
                    <datalist id="member-candidates">
                      {candidates.map((u) => <option key={u.id} value={u.username} />)}
                    </datalist>
                    <span className="ds-select">
                      <select
                        aria-label="Роль нового участника"
                        value={addRole}
                        onChange={(e) => setNewRole(e.target.value as EditableRole)}
                      >
                        <option value="editor" disabled={onlyReader}>Редактор</option>
                        <option value="reader">Читатель</option>
                      </select>
                      <ChevronDownIcon />
                    </span>
                    <button type="button" className="ds-btn" disabled={!login.trim() || busy} onClick={addMember}>
                      Добавить
                    </button>
                  </div>
                )}
                {isOwner && onlyReader && <p className="pa-hint pa-span">«Пользователь» может быть только читателем</p>}
              </div>

              {!isOwner && (
                <p className="pa-note">Менять доступ может владелец проекта.</p>
              )}
            </section>

            {error && <p className="ds-danger pa-err" role="alert">{error}</p>}
          </div>

          <div className="ds-win-foot">
            <button type="button" className="ds-btn" onClick={onClose}>Закрыть</button>
          </div>
        </div>
      </Modal>

      {/* Подтверждение — СИБЛИНГОМ окна, не внутри: вложенный <dialog> ломает Escape. */}
      {confirming && transferUser && (
        <ConfirmDialog
          title={`Передать проект «${project.name}» пользователю ${transferUser.username}?`}
          lead={stays}
          error={error}
          confirmLabel="Передать"
          busyLabel="Передаём"
          busy={busy}
          onConfirm={() => void transfer()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
