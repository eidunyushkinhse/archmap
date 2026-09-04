// Поле «Якорь» — ОДИН компонент на два места: карточка объекта (NodePage,
// «Свойства») и инспектор карты (NodeInspector). Якорь до Ф1 был скрытой
// метаданной прогона агента: узел, созданный руками, обречён был вести себя при
// обновлениях иначе, чем агентский с виду такой же, и никто этого не видел.
// Здесь он виден, объясняет себя (ⓘ) и правится.
//
// Нормализации на фронте НЕТ ни строчки: и живая подсказка «будет сохранено
// как…», и отказы приходят с сервера (POST /nodes/anchor-preview той же
// функцией, что валидирует PATCH). Иначе форма обещала бы одно, а сохранение
// делало другое.
import { useEffect, useMemo, useState } from "react";
import type { NodeSource } from "../../types";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import InfoPopover from "../../ui/InfoPopover";
import type { AnchorKind } from "./anchorText";
import {
  ANCHOR_HELP, FIELD_LABEL, FORM_HINT, HELP_LABEL, KIND_LABEL, KIND_TAB,
  NO_ANCHOR, PLACEHOLDER, PREVIEW_EMPTY, PREVIEW_PREFIX,
  anchorKind as kindOf, anchorReadable as readable,
} from "./anchorText";
import "./anchor.css";

// Вид якоря: код (репозиторий + путь) или имя зависимости. Третьего нет —
// контур развёртывания (образ, объект k8s) из идентичности убран (Ф0).
type Kind = AnchorKind;

interface Props {
  // Якорь узла как его отдаёт сервер (заполнена ровно одна сторона) либо ничего.
  source: NodeSource | null | undefined;
  isArchitect: boolean;
  // Сохранение якоря делает РОДИТЕЛЬ (у него CAS-версия и полный payload узла).
  // Возвращает текст отказа сервера — или null, если сохранилось: 422 обязан
  // остаться под формой, где человек его исправит, а не увести форму со сцены.
  onSave: (source: NodeSource | null) => Promise<string | null>;
}

export default function AnchorField({ source, isArchitect, onSave }: Props) {
  const kindNow = kindOf(source);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<Kind>("code");
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("");
  const [host, setHost] = useState("");
  const [saving, setSaving] = useState(false);
  // Отказ сохранения (422/409) — под формой, у самого поля.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Ответ dry-run с ключом ввода, которому он принадлежит: пока человек печатает
  // дальше, устаревшая подсказка не показывается (вместо неё — ничего).
  const [preview, setPreview] = useState<{ key: string; text: string; bad: boolean } | null>(null);

  const открыть = () => {
    setKind(kindNow ?? "code");
    setRepo(source?.repo ?? "");
    setPath(source?.path ?? "");
    setHost(source?.host ?? "");
    setSaveError(null);
    setPreview(null);
    setEditing(true);
  };

  // Что уйдёт на сервер (и ключ ввода для dry-run) — производное, считается в
  // рендере: эффект здесь только шлёт запрос, стейт из него не выводится.
  const draft = useMemo<NodeSource | null>(() => {
    if (kind === "code") {
      const r = repo.trim(), p = path.trim();
      return r || p ? { repo: r || null, path: p || null } : null;
    }
    const h = host.trim();
    return h ? { host: h } : null;
  }, [kind, repo, path, host]);
  const key = JSON.stringify(draft);

  // Живая нормализация: 300 мс тишины после последнего нажатия — и сервер
  // отвечает, что именно он запишет. Пустая форма запроса не стоит: пусто — это
  // очистка, и сказать об этом можно без сервера.
  useEffect(() => {
    if (!editing || draft === null) return;
    let alive = true;
    const timer = setTimeout(() => {
      void nodesApi.anchorPreview(draft).then(
        (out) => {
          if (!alive) return;
          const text = out.source
            ? `${PREVIEW_PREFIX} ${readable(out.source)}`
            : PREVIEW_EMPTY;
          setPreview({ key, text, bad: false });
        },
        (e: unknown) => {
          if (!alive) return;
          setPreview({ key, text: e instanceof ApiError ? e.message : "Проверка не удалась", bad: true });
        },
      );
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [editing, draft, key]);

  const commit = async (next: NodeSource | null) => {
    setSaving(true);
    const err = await onSave(next);
    setSaving(false);
    if (err) { setSaveError(err); return false; }
    setSaveError(null);
    setEditing(false);
    return true;
  };

  const help = (
    <InfoPopover label={HELP_LABEL}>
      {ANCHOR_HELP.map((p) => (
        <p key={p.head}><b>{p.head}</b> {p.body}</p>
      ))}
    </InfoPopover>
  );

  if (!editing) {
    return (
      <span className="anchor-field">
        <span className="anchor-read">
          {source && kindNow ? (
            <>
              <span className="anchor-kind">{KIND_LABEL[kindNow]}:</span>{" "}
              <span className="anchor-val">{readable(source)}</span>
            </>
          ) : (
            <span className="anchor-empty">{NO_ANCHOR}</span>
          )}
          {help}
          {isArchitect && (
            <span className="anchor-acts">
              <button type="button" className="anchor-link" onClick={открыть} disabled={saving}>
                Изменить
              </button>
              {source && (
                <>
                  {/* Разделитель: без него два действия читались одним словом. */}
                  <span className="anchor-sep" aria-hidden>·</span>
                  <button
                    type="button"
                    className="anchor-link"
                    onClick={() => { void commit(null); }}
                    disabled={saving}
                  >
                    Очистить
                  </button>
                </>
              )}
            </span>
          )}
        </span>
        {saveError && <span className="anchor-err">{saveError}</span>}
      </span>
    );
  }

  return (
    <span
      className="anchor-field"
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); void commit(draft); }
        // Escape закрывает форму, а не уходит выше (снятие выделения на холсте).
        if (e.key === "Escape") { e.stopPropagation(); setEditing(false); }
      }}
    >
      <span className="anchor-tabs" role="radiogroup" aria-label="Вид якоря">
        {(["code", "dependency"] as Kind[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            className={"anchor-tab" + (kind === k ? " is-on" : "")}
            onClick={() => setKind(k)}
          >
            {KIND_TAB[k]}
          </button>
        ))}
        {help}
      </span>

      {kind === "code" ? (
        <>
          <label className="anchor-label">
            {FIELD_LABEL.repo}
            <input className="anchor-input" value={repo} placeholder={PLACEHOLDER.repo}
              autoFocus onChange={(e) => setRepo(e.target.value)} />
          </label>
          <label className="anchor-label">
            {FIELD_LABEL.path}
            <input className="anchor-input" value={path} placeholder={PLACEHOLDER.path}
              onChange={(e) => setPath(e.target.value)} />
          </label>
        </>
      ) : (
        <label className="anchor-label">
          {FIELD_LABEL.host}
          <input className="anchor-input" value={host} placeholder={PLACEHOLDER.host}
            autoFocus onChange={(e) => setHost(e.target.value)} />
        </label>
      )}

      <span className="anchor-hint">{FORM_HINT[kind]}</span>
      {draft === null ? (
        <span className="anchor-preview">{PREVIEW_EMPTY}</span>
      ) : (
        preview?.key === key && (
          <span className={preview.bad ? "anchor-err" : "anchor-preview"}>{preview.text}</span>
        )
      )}
      {saveError && <span className="anchor-err">{saveError}</span>}

      <span className="anchor-actions">
        <button type="button" className="anchor-btn is-primary" disabled={saving}
          onClick={() => { void commit(draft); }}>Сохранить</button>
        <button type="button" className="anchor-btn" disabled={saving}
          onClick={() => setEditing(false)}>Отмена</button>
      </span>
    </span>
  );
}
