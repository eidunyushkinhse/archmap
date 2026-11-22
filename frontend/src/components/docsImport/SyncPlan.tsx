// План обновления в окне «Обновить из кода»: галочки «что обновлять», состояние сверки и
// сам план по разделам (syncPlanView считает, здесь только вид). Показываются только
// изменения; раздел — название и число тихим цветом, разделы, требующие внимания
// (пропажи), — цветом предупреждения. Плашки пределов демо-стенда прежнего вида живут в
// legacy-root: область .ds окна держит их на прежних метриках (ui/tokens.css).
import type { SyncPolicies } from "../../types";
import type { SyncImport } from "./useSyncImport";
import { planSections, planSummary } from "./syncPlanView";
import { NoteList } from "./agentModalReport";
import { DemoExcessNotice, FileTooBigNotice } from "../demo/DemoLimitNotice";
import "../../ui/ds.css";
import "./syncRepo.css";

// Подсказки описывают ЭФФЕКТ для пользователя, а не механику: в интерфейс не
// должны попадать наши рабочие слова («прогон», «политика», «якорь», «слой»).
const POLICY_LABELS: { key: keyof SyncPolicies; title: string; hint: string }[] = [
  {
    key: "update_descriptions",
    title: "Заменить описания",
    hint: "Описания объектов будут заменены на те, что в YAML. Если вы правили описания вручную, эти правки пропадут. По умолчанию выключено, потому что агент каждый раз описывает объекты немного по-разному.",
  },
  {
    key: "update_names",
    title: "Переименовать объекты",
    hint: "Объекты получат имена из YAML. Без этой галочки имена в схеме останутся прежними, а расхождение будет просто показано в списке ниже.",
  },
  {
    key: "sync_components",
    title: "Обновлять компоненты контейнеров",
    hint: "Обновление затронет и компоненты внутри контейнеров. Без галочки всё, что лежит внутри контейнеров, остаётся как есть. По умолчанию выключено, потому что компоненты агент описывает менее надёжно и такие изменения обычно только мешают увидеть главное.",
  },
  {
    key: "mark_missing_deprecated",
    title: "Помечать выводимыми то, чего нет в файлах",
    hint: "Объекты, которых в файлах больше нет, получат статус «Выводится». Удалять их ArchMap не будет ни при каких настройках.",
  },
  {
    key: "restore_returned",
    title: "Снимать статус «Выводится» с объектов, которые снова есть в файлах",
    hint: "Объекты со статусом «Выводится», которые снова есть в файлах, получат статус «Существует». По умолчанию выключено, потому что статус могли поставить вы вручную, и снимать его без спроса неправильно. План обновления показывает вернувшиеся объекты в любом случае.",
  },
];

export default function SyncPlan({ imp }: { imp: SyncImport }) {
  const { preview, excess } = imp;
  return (
    <>
      <div className="sync-policies">
        {POLICY_LABELS.map((p) => (
          <label key={p.key} className="ds-check" title={p.hint}>
            <input
              type="checkbox"
              checked={imp.policies[p.key]}
              onChange={(e) => imp.setPolicy(p.key, e.target.checked)}
            />
            <span>{p.title}</span>
          </label>
        ))}
      </div>

      {imp.checking && <p className="sync-line sync-quiet">Сверяем со схемой</p>}
      {imp.tooBig && <div className="legacy-root"><FileTooBigNotice {...imp.tooBig} /></div>}
      {/* Не помещается в демо: вместо плана — отказ с полоской. */}
      {excess && <div className="legacy-root"><DemoExcessNotice excess={excess} scope="project" /></div>}
      {preview && !preview.ok && <NoteList title="YAML не читается" items={preview.errors ?? []} />}
      {preview?.ok && !excess && (
        <div className="sync-plan">
          <p className="sync-summary">{planSummary(preview)}</p>
          {planSections(preview).map((s) => (
            <div key={s.key} className={"sync-sec" + (s.attention ? " is-attention" : "")}>
              <p className="sync-sec-title">
                {s.title} <span className="sync-count">{s.rows.length}</span>
              </p>
              <ul className="sync-rows">
                {s.rows.map((r) => (
                  <li key={r.path}>
                    {r.path}
                    {r.note && <span className="sync-note">: {r.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {!!preview.conflicts?.length && <NoteList title="Есть нюанс" items={preview.conflicts} />}
          {!!preview.warnings?.length && <NoteList title="Стоит проверить глазами" items={preview.warnings} />}
        </div>
      )}
    </>
  );
}
