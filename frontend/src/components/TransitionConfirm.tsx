// Окно «Принять переход»: план стал фактом — запланированное становится
// существующим, выводимое из эксплуатации уходит из схемы.
//
// Область — ВЕСЬ ПРОЕКТ (решение пользователя 2026-08-08): переход принимают
// целиком, а не по уровням. Кнопка живёт в шапке редактора рядом с
// переключателем вида — там, где статусы и видны.
//
// Операция НЕОБРАТИМА, поэтому окно устроено вокруг одного вопроса: что именно
// исчезнет. Отдельно и заметнее всего показаны «попутные потери» — объекты,
// которых устаревшими никто не помечал, но которые лежат внутри выводимых и
// уедут вместе с ними. Undo здесь нет осознанно: пакетное удаление десятков
// узлов в текущую историю не вписывается (см. docs/plan-work-2026-08-08.md).
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { TransitionPreview } from "../types";
import { transitionApi } from "../api/nodes";
import { ApiError } from "../api/client";
import Modal from "../ui/Modal";
import { primaryBtn, secondaryBtn, dangerBtn } from "../ui/styles";
import { plural } from "../ui/plural";

interface Props {
  onClose: () => void;
  /** Переход принят — страница перечитывает схему и показывает итог. */
  onApplied: (message: string) => void;
}

export default function TransitionConfirm({ onClose, onApplied }: Props) {
  const [preview, setPreview] = useState<TransitionPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    transitionApi
      .preview()
      .then((p) => { if (alive) setPreview(p); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  function apply() {
    if (!preview) return;
    setApplying(true);
    setError(null);
    transitionApi
      .apply(preview.graph_rev)
      .then((r) => {
        const bits: string[] = [];
        if (r.promoted_nodes) {
          bits.push(`${r.promoted_nodes} ${plural(r.promoted_nodes, ["объект переведён", "объекта переведено", "объектов переведено"])} в существующие`);
        }
        if (r.deleted_nodes) {
          bits.push(`${r.deleted_nodes} ${plural(r.deleted_nodes, ["удалён", "удалено", "удалено"])}`);
        }
        onApplied(bits.length ? `Переход принят: ${bits.join(", ")}` : "Принимать было нечего");
        onClose();
      })
      .catch((e: unknown) => {
        setError(
          e instanceof ApiError && e.status === 409
            ? "Схему изменили в другом окне — список ниже устарел. Закройте это окно и откройте снова."
            : "Не удалось применить. Проверьте соединение и повторите.",
        );
      })
      .finally(() => setApplying(false));
  }

  const canApply = !!preview && !preview.is_noop && !applying;

  return (
    <Modal onClose={onClose} boxStyle={{ width: 560, maxHeight: "84vh", overflowY: "auto" }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 700, color: "#1e293b" }}>
        Принять переход
      </h3>
      <p style={hint}>
        Запланированное станет существующим, а выводимое из эксплуатации — исчезнет
        из схемы. Действие затрагивает весь проект и отменить его нельзя.
      </p>

      {failed && <p style={errorText}>Не удалось посчитать, что изменится. Закройте окно и попробуйте снова.</p>}
      {!preview && !failed && <p style={hint}>Считаем, что изменится…</p>}

      {preview?.is_noop && (
        <p style={{ ...hint, color: "#334155" }}>
          Принимать нечего: в схеме нет ни запланированных объектов, ни выводимых
          из эксплуатации.
        </p>
      )}

      {preview && !preview.is_noop && (
        <>
          {preview.promote.length > 0 && (
            <Section title={`Станут существующими · ${preview.promote.length}`}>
              {preview.promote.map((n) => <li key={n.id}>{n.path}</li>)}
            </Section>
          )}

          {preview.delete.length > 0 && (
            <Section title={`Будут удалены · ${preview.delete.length}`} danger>
              {preview.delete.map((n) => <li key={n.id}>{n.path}</li>)}
            </Section>
          )}

          {/* Самое важное в окне: эти объекты никто устаревшими не помечал. */}
          {preview.collateral.length > 0 && (
            <div style={warnBox}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                Уедут заодно · {preview.collateral.length}
              </div>
              <div style={{ marginBottom: 6 }}>
                Эти объекты не помечены выводимыми — они просто лежат внутри удаляемых.
              </div>
              <ul style={list}>
                {preview.collateral.map((n) => <li key={n.id}>{n.path}</li>)}
              </ul>
            </div>
          )}

          {preview.delete_total > 0 && (
            <p style={hint}>
              Всего исчезнет {preview.delete_total} {plural(preview.delete_total, ["объект", "объекта", "объектов"])}
              {preview.delete_edges > 0 && `, ${preview.delete_edges} ${plural(preview.delete_edges, ["связь", "связи", "связей"])}`}
              {preview.delete_docs > 0 && `, ${preview.delete_docs} ${plural(preview.delete_docs, ["схема логики", "схемы логики", "схем логики"])}`}
              {preview.delete_specs > 0 && `, ${preview.delete_specs} ${plural(preview.delete_specs, ["спека", "спеки", "спек"])}`}.
            </p>
          )}
        </>
      )}

      {error && <p style={errorText}>{error}</p>}

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" style={secondaryBtn} onClick={onClose} data-autofocus>
          Отмена
        </button>
        <button
          type="button"
          style={preview?.delete.length ? dangerBtn : primaryBtn}
          disabled={!canApply}
          onClick={apply}
        >
          {applying ? "Применяем…" : "Принять переход"}
        </button>
      </div>
    </Modal>
  );
}

function Section({ title, danger, children }: { title: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: danger ? "#b91c1c" : "#334155" }}>
        {title}
      </div>
      <ul style={list}>{children}</ul>
    </div>
  );
}

const hint: CSSProperties = { margin: "0 0 4px", fontSize: 13, lineHeight: 1.5, color: "#64748b" };
const list: CSSProperties = { margin: "4px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: "#475569" };
const warnBox: CSSProperties = {
  marginTop: 12, padding: "10px 12px", borderRadius: 8,
  background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e", fontSize: 12.5,
};
const errorText: CSSProperties = { margin: "10px 0 0", fontSize: 13, color: "#b91c1c" };
