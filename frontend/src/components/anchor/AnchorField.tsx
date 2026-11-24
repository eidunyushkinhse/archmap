// Поле «Источник» (до 2026-10-17 — «Якорь») — ОДИН компонент на два места: строка
// «Источник» в «Свойствах» страницы объекта и в панели объекта редактора-карты (общие
// строки nodePage/PropRows). Источник до Ф1 был скрытой метаданной прогона агента: узел,
// созданный руками, обречён был вести себя при обновлениях иначе, чем агентский с виду
// такой же, и никто этого не видел. Здесь он виден и правится.
//
// Значение — одна строка моноширинным текстом без приставок вида. У редактора значение
// целиком открывает плавающую панель правки под ним (страница и панель редактора не
// сдвигаются); «Очистить» живёт в панели.
//
// Нормализации на фронте НЕТ ни строчки: и живая подсказка «будет сохранено
// как…», и отказы приходят с сервера (POST /nodes/anchor-preview той же
// функцией, что валидирует PATCH). Иначе форма обещала бы одно, а сохранение
// делало другое.
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeSource } from "../../types";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { AnchorKind } from "./anchorText";
import {
  FIELD_LABEL, KIND_LABEL, KIND_TAB, NO_ANCHOR_SHORT, PLACEHOLDER, PREVIEW_EMPTY, PREVIEW_PREFIX,
  anchorCompact, anchorKind as kindOf, anchorReadable as readable,
} from "./anchorText";
import "./anchor.css";
import "../../ui/ds.css";
import { noAutofill } from "../../ui/noAutofill";

// Вид якоря: код (репозиторий + путь) или имя зависимости. Третьего нет —
// контур развёртывания (образ, объект k8s) из идентичности убран (Ф0).
type Kind = AnchorKind;

// Совпадает ли то, что запишет сервер, с введённым: тогда подсказка «будет сохранено
// как» ничего не добавляет (сравниваются поля целиком, без своей нормализации).
function sameSource(a: NodeSource | null, b: NodeSource | null): boolean {
  return (a?.repo ?? null) === (b?.repo ?? null)
    && (a?.path ?? null) === (b?.path ?? null)
    && (a?.host ?? null) === (b?.host ?? null);
}

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
  // дальше, устаревшая подсказка не показывается (вместо неё — ничего). same — сервер
  // запишет ровно введённое (панель тогда подсказку не показывает).
  const [preview, setPreview] = useState<{ key: string; text: string; bad: boolean; same: boolean } | null>(null);
  // Значение-кнопка: фокус возвращается на неё, когда панель закрывается.
  const valueRef = useRef<HTMLButtonElement>(null);

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
          setPreview({ key, text, bad: false, same: sameSource(out.source ?? null, draft) });
        },
        (e: unknown) => {
          if (!alive) return;
          setPreview({ key, text: e instanceof ApiError ? e.message : "Проверка не удалась", bad: true, same: false });
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

  // Значение одной строкой; у редактора — кнопка панели.
  const text = source && kindNow ? anchorCompact(source) : null;
  const full = source && kindNow ? `${KIND_LABEL[kindNow]}: ${readable(source)}` : undefined;
  if (!isArchitect) {
    return (
      <span className="anchor-field">
        {text
          ? <span className="anchor-pv-text" title={full}>{text}</span>
          : <span className="ds-empty">{NO_ANCHOR_SHORT}</span>}
      </span>
    );
  }
  // Закрыть панель без сохранения (Escape, клик мимо, «Отмена»): фокус — на значение.
  const закрыть = () => {
    setEditing(false);
    setSaveError(null);
    valueRef.current?.focus();
  };
  const сохранить = async (next: NodeSource | null) => {
    if (await commit(next)) valueRef.current?.focus();
  };
  // «будет сохранено как» — только когда сервер приведёт ввод к другому виду; отказ
  // проверки виден всегда; пустая форма у объекта с источником — это очистка.
  const fresh = draft !== null && preview?.key === key ? preview : null;
  return (
    <span className="anchor-field">
      <button
        ref={valueRef}
        type="button"
        className="ds-value-btn anchor-pv"
        onClick={editing ? закрыть : открыть}
        disabled={saving}
        aria-label={text ? `Источник: ${text}` : "Задать источник"}
        aria-expanded={editing}
        title={full}
      >
        {text ? <span className="anchor-pv-text">{text}</span> : <span className="ds-empty">{NO_ANCHOR_SHORT}</span>}
      </button>
      {editing && (
        <>
          <div className="anchor-pop-backdrop" onClick={закрыть} />
          {/* tabIndex −1: клик по пустому месту панели держит фокус в ней, и Escape
              по-прежнему приходит сюда. */}
          <div
            className="anchor-pop"
            role="group"
            aria-label="Источник"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); закрыть(); }
              // Enter сохраняет из поля ввода; на кнопке он нажимает саму кнопку.
              if (e.key === "Enter" && e.target instanceof HTMLInputElement) { e.preventDefault(); void сохранить(draft); }
            }}
          >
            <div className="ds-tabs" role="radiogroup" aria-label="Вид источника">
              {(["code", "dependency"] as Kind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  className={"ds-tab" + (kind === k ? " is-active" : "")}
                  onClick={() => setKind(k)}
                >
                  {KIND_TAB[k]}
                </button>
              ))}
            </div>
            {kind === "code" ? (
              <>
                <label className="anchor-pop-label">
                  {FIELD_LABEL.repo}
                  <input {...noAutofill("anchor-field-1")} className="ds-input" value={repo} placeholder={PLACEHOLDER.repo}
                    autoFocus onChange={(e) => setRepo(e.target.value)} />
                </label>
                <label className="anchor-pop-label">
                  {FIELD_LABEL.path}
                  <input {...noAutofill("anchor-field-2")} className="ds-input" value={path} placeholder={PLACEHOLDER.path}
                    onChange={(e) => setPath(e.target.value)} />
                </label>
              </>
            ) : (
              <label className="anchor-pop-label">
                {FIELD_LABEL.host}
                <input {...noAutofill("anchor-field-3")} className="ds-input" value={host} placeholder={PLACEHOLDER.host}
                  autoFocus onChange={(e) => setHost(e.target.value)} />
              </label>
            )}
            {draft === null && source && <p className="anchor-pop-note">{PREVIEW_EMPTY}</p>}
            {fresh && (fresh.bad
              ? <p className="anchor-pop-err">{fresh.text}</p>
              : !fresh.same && <p className="anchor-pop-note">{fresh.text}</p>)}
            {saveError && <p className="anchor-pop-err" role="alert">{saveError}</p>}
            <div className="anchor-pop-acts">
              <button type="button" className="ds-btn ds-btn--primary" disabled={saving}
                onClick={() => { void сохранить(draft); }}>Сохранить</button>
              <button type="button" className="ds-btn" disabled={saving} onClick={закрыть}>Отмена</button>
              {source && (
                <button type="button" className="anchor-pop-clear" disabled={saving}
                  onClick={() => { void сохранить(null); }}>Очистить</button>
              )}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
