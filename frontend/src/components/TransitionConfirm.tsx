// Окно «Принять переход»: план стал фактом — запланированное становится
// существующим, выводимое из эксплуатации уходит из схемы.
//
// Область — ВЕСЬ ПРОЕКТ (решение пользователя 2026-08-08): переход принимают
// целиком, а не по уровням. Кнопка живёт в шапке редактора рядом с
// переключателем вида — там, где статусы и видны.
//
// Операция НЕОБРАТИМА, поэтому окно устроено вокруг одного вопроса: что именно
// исчезнет. Отдельным блоком показаны «попутные потери» — объекты, которых
// устаревшими никто не помечал, но которые лежат внутри выводимых и уедут вместе
// с ними: у блока фраза-предупреждение. Undo здесь нет осознанно: пакетное удаление
// десятков узлов в текущую историю не вписывается (см. docs/plan-work-2026-08-08.md).
//
// Вид — каркас окна нового языка (.ds-win, редизайн): шапка с крестиком, тело с
// прокруткой, блоки с тихим числом у заголовка, подвал «Принять переход» и «Отмена».
import { useEffect, useState } from "react";
import type { TransitionPreview } from "../types";
import { transitionApi } from "../api/nodes";
import { ApiError } from "../api/client";
import Modal from "../ui/Modal";
import { CloseIcon } from "../ui/icons";
import { plural } from "../ui/plural";
import "../ui/ds.css";

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
            ? "Схему только что изменили в другом окне, и список ниже устарел. Закройте это окно и откройте снова."
            : "Не удалось применить. Проверьте соединение и повторите.",
        );
      })
      .finally(() => setApplying(false));
  }

  const canApply = !!preview && !preview.is_noop && !applying;

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 560, padding: 0 }}>
      <div className="ds ds-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Принять переход</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <p className="ds-confirm-lead">
            Проектируемые объекты станут существующими, а выводимые исчезнут из схемы.
            Действие затрагивает весь проект и отменить его нельзя.
          </p>

          {failed && <p className="ds-danger ds-confirm-flat">Не удалось посчитать, что изменится. Закройте окно и попробуйте снова.</p>}
          {!preview && !failed && <p className="ds-confirm-note ds-confirm-muted">Считаем, что изменится</p>}

          {preview?.is_noop && (
            <p className="ds-confirm-note">
              Принимать нечего, потому что в схеме нет ни проектируемых, ни выводимых
              объектов.
            </p>
          )}

          {preview && !preview.is_noop && (
            <>
              {preview.promote.length > 0 && <Block title="Станут существующими" items={preview.promote} />}

              {preview.delete.length > 0 && <Block title="Будут удалены" items={preview.delete} />}

              {/* Самое важное в окне: эти объекты никто устаревшими не помечал. */}
              {preview.collateral.length > 0 && (
                <Block
                  title="Удалятся вместе с ними"
                  items={preview.collateral}
                  warn="Эти объекты не помечены выводимыми, но лежат внутри удаляемых."
                />
              )}

              {preview.delete_total > 0 && (
                <p className="ds-confirm-note">
                  Всего исчезнет {preview.delete_total} {plural(preview.delete_total, ["объект", "объекта", "объектов"])}
                  {preview.delete_edges > 0 && `, ${preview.delete_edges} ${plural(preview.delete_edges, ["связь", "связи", "связей"])}`}
                  {preview.delete_docs > 0 && `, ${preview.delete_docs} ${plural(preview.delete_docs, ["схема логики", "схемы логики", "схем логики"])}`}
                  {preview.delete_specs > 0 && `, ${preview.delete_specs} ${plural(preview.delete_specs, ["спецификация", "спецификации", "спецификаций"])}`}.
                </p>
              )}
            </>
          )}
        </div>

        <div className="ds-win-foot">
          {error && <p className="ds-danger ds-win-err">{error}</p>}
          <button
            type="button"
            className={preview?.delete.length ? "ds-btn ds-btn--danger" : "ds-btn ds-btn--primary"}
            disabled={!canApply}
            onClick={apply}
          >
            {applying ? "Применяем" : "Принять переход"}
          </button>
          <button type="button" className="ds-btn" onClick={onClose} data-autofocus>
            Отмена
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Блок плана: заголовок с тихим числом, под ним (у попутных потерь) предупреждение и
// перечень путей; полный путь — в подсказке строки.
function Block({ title, items, warn }: { title: string; items: TransitionPreview["promote"]; warn?: string }) {
  return (
    <section className="ds-win-block">
      <h3 className="ds-win-block-title">
        {title}<span className="ds-confirm-count">{items.length}</span>
      </h3>
      {warn && <p className="ds-warn ds-confirm-flat">{warn}</p>}
      <ul className="ds-confirm-list">
        {items.map((n) => <li key={n.id} title={n.path}>{n.path}</li>)}
      </ul>
    </section>
  );
}
