import { useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  SchemaAlerts as Alerts,
  UnresolvedChannelRefAlert,
  UnresolvedDataRefAlert,
} from "../types";
import { plural } from "../ui/plural";
import { BulbIcon } from "../ui/icons";
import "./schemaAlerts.css";
import { useDismiss } from "../ui/useDismiss";

/**
 * Рекомендации по схеме для архитектора (подача «А1. Чистый список», 2026-09-29;
 * прежде — янтарный знак «Незавершённость схемы» со счётчиком, пульсом и тостом).
 * В коде и спеках словарь прежний («алерты», спека alerts.md), в интерфейсе —
 * только «Рекомендации».
 *
 *  • Кнопка-иконка «Рекомендации» (лампочка) того же вида, что «три точки»
 *    (SchemaActions), видна ВСЕГДА, в том числе при нуле рекомендаций. Пока
 *    рекомендации есть, в углу кнопки маленькая серая точка; числа нет.
 *  • Клик раскрывает панель: разделы подписями с числом, пункты обычным текстом.
 *    Все рекомендации равнозначны — ни деления по важности, ни выделения цветом.
 *    Пункт кликабелен и ведёт к объекту/связи на схеме (через onLocate — поведение
 *    перехода реализует вызывающая сторона); стрелка «→» появляется у пункта под
 *    курсором. Пустая панель говорит «Рекомендаций нет».
 *
 * Разделы (формулировки на «объект», не «узел»):
 *  1) Объекты без связей — атомарные объекты без единой связи;
 *  2) Связи в контейнер — связь упирается в контейнер, а не в атомарный объект;
 *  3) Изолированные группы — схема распалась на ≥2 несвязанных кластера;
 *  4) Контейнеры со своей документацией — у контейнера остались собственные
 *     (grandfather) логические диаграммы и/или спека; их надо распределить по
 *     дочерним сервисам. ЧТО ИМЕННО осталось, строка не уточняет: конкретное
 *     предупреждение с путём исправления живёт на странице объекта;
 *  5) Пользователи внутри контейнера — узел-человек вложен в другой объект, а по C4
 *     люди живут на контекстном уровне, ЗА границей системы;
 *  6) Незадокументированные сообщения — связь, которой шло сообщение, удалена из
 *     схемы. Клик ведёт В ПРОЦЕСС (чинить на холсте нечего), поэтому строки
 *     кликабельны только там, где переход передан (onOpenProcess);
 *  7) Обращения к неописанным данным — пометка «читает:/пишет:» в схеме логики не
 *     нашла свою таблицу структуры (AL29). Пометка — обещание факта, и строка
 *     называет причину невыполнения: таблицы нет / имя неоднозначно / нет колонки;
 *  8) Обращения к неописанным каналам — то же для событий: «публикует:/потребляет:»
 *     не нашла канал в структуре брокеров (AL30). Класс отдельный от (7): причины и
 *     слова починки свои («укажите „Брокер / канал“»), а искать топик в структуре
 *     базы человека посылать нельзя;
 *  9) Связи с брокером без канала — стрелка в брокер не назвала топик/очередь либо
 *     назвала неизвестный структуре (AL31). Чинится в инспекторе самой связи,
 *     поэтому строка ведёт К СВЯЗИ на схеме;
 * 10) Связи в собственный компонент — связь между узлом и его же потомком (AL32).
 *     Класс ОТДЕЛЬНЫЙ от (2): там конец уточняют до компонента, а здесь конец уже
 *     компонент этого самого контейнера — вложенность выражает иерархия, и связь
 *     удаляют либо перевешивают. Строка ведёт К СВЯЗИ на схеме.
 * 11) Объекты с неописанными схемами логики — у объекта есть заглушки разведки
 *     (схемы без тела, AL35). ОДНА строка на объект с числом заглушек, а не строка
 *     на заглушку: построчный бэклог живёт на странице объекта (блок «Не описано»).
 *     Строка ведёт К ОБЪЕКТУ на схеме, как (4).
 * Алерты глобальные, считаются на бэке — здесь только отображение.
 */

export type LocateTarget =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "group"; ids: string[] };

interface Props {
  alerts: Alerts;
  // Открыть процесс с повисшим сообщением. Не часть onLocate: цель не на схеме,
  // а в другом режиме — и передаётся только там, где такой переход существует.
  onOpenProcess?: (processId: string) => void;
  // Переход к проблемному объекту/связи на схеме (pan + подсветка) — реализуется
  // вызывающей стороной (MapEditorPage). Если не передан — пункты не кликабельны.
  onLocate?: (target: LocateTarget) => void;
  // Размер кнопки — как у соседних «трёх точек» (SchemaActions): в шапке оболочки
  // 34, на холсте редактора 32.
  size?: number;
  // Где стоит кнопка: на холсте она висит над схемой и получает лёгкую тень.
  placement?: "header" | "canvas";
}

// Почему пометка не срослась. Текст обязан подсказывать действие: неоднозначность
// лечится квалификатором, поэтому строка прямо его называет.
const REF_REASON: Record<UnresolvedDataRefAlert["reason"], string> = {
  unknown_table: "таблица не найдена",
  ambiguous: "имя неоднозначно, укажите „БД / таблица“",
  unknown_column: "колонки нет в таблице",
};

// То же для каналов: слова СВОИ — «Брокер / канал» вместо «БД / таблица», иначе
// подсказка ведёт чинить не туда.
const CHANNEL_REASON: Record<UnresolvedChannelRefAlert["reason"], string> = {
  unknown_channel: "канал не найден у брокеров проекта",
  ambiguous: "имя неоднозначно, укажите „Брокер / канал“",
  unknown_field: "поля нет в канале",
};

// Куда ведёт строка раздела: к объекту, связи или группе на схеме — либо в процесс
// (чинить там, а не на холсте).
type Go = { locate: LocateTarget } | { process: string };

// Переходы, переданные вызывающей стороной; нет перехода — строки не кликабельны.
interface Nav {
  locate?: (target: LocateTarget) => void;
  openProcess?: (processId: string) => void;
}

interface SectionSpec<T> {
  title: string;
  items: (a: Alerts) => T[];
  // Вклад раздела в общий счёт рекомендаций; по умолчанию — проблема на запись.
  problems?: (items: T[]) => number;
  key: (item: T, i: number) => string | number;
  go: (item: T, i: number) => Go;
  body: (item: T, i: number) => ReactNode;
}

// Раздел со стёртым типом записей: пятнадцать разных классов живут одним списком, и
// общий счёт считается по нему же (аудит F-35: раньше — деструктуризация, сумма из
// пятнадцати слагаемых и пятнадцать <Section> тремя несвязанными списками; забытое
// слагаемое не проявилось бы ничем).
interface AlertSection {
  problems: (a: Alerts) => number;
  render: (a: Alerts, nav: Nav) => ReactNode;
}

function section<T>(spec: SectionSpec<T>): AlertSection {
  return {
    problems: (a) => {
      const items = spec.items(a);
      return spec.problems ? spec.problems(items) : items.length;
    },
    render: (a, { locate, openProcess }) => {
      const items = spec.items(a);
      return (
        <Section key={spec.title} title={spec.title} count={items.length}>
          {items.map((item, i) => {
            const go = spec.go(item, i);
            const onClick = "locate" in go
              ? locate && (() => locate(go.locate))
              : openProcess && (() => openProcess(go.process));
            return (
              <Item key={spec.key(item, i)} hint={"process" in go ? "Открыть процесс" : undefined} onClick={onClick}>
                {spec.body(item, i)}
              </Item>
            );
          })}
        </Section>
      );
    },
  };
}

const toNode = (id: string): Go => ({ locate: { kind: "node", id } });
const toEdge = (id: string): Go => ({ locate: { kind: "edge", id } });

// Шаг процесса в строке: процесс и подпись, ниже — концы (и, если нужно, канал).
function stepLine(m: { process_name: string; caption: string | null }) {
  return (
    <span className="sa-line">
      <span className="sa-where">{m.process_name}:</span>{" "}
      {m.caption ? `«${m.caption}»` : "без подписи"}
    </span>
  );
}

// Порядок списка — порядок разделов в панели.
const ALERT_SECTIONS: AlertSection[] = [
  section({
    title: "Объекты без связей",
    items: (a: Alerts) => a.disconnected_nodes,
    key: (d) => d.node_id,
    go: (d) => toNode(d.node_id),
    body: (d) => d.node_name,
  }),
  section({
    title: "Связи в контейнер",
    items: (a: Alerts) => a.intermediate_edges,
    key: (e) => e.edge_id,
    go: (e) => toEdge(e.edge_id),
    body: (e) => (
      <span className="sa-row">
        <span className={e.source_is_intermediate ? "sa-strong" : undefined}>{e.source_name}</span>
        <span className="sa-muted">→</span>
        <span className={e.target_is_intermediate ? "sa-strong" : undefined}>{e.target_name}</span>
      </span>
    ),
  }),
  // Связи узла с его же потомком: иерархия вложенность уже выразила. Отдельно от
  // «связей в контейнер» — там конец уточняют до компонента, здесь совет
  // ПРОТИВОПОЛОЖЕН: не «уточните конец», а «удалите или перевесьте». Строка ведёт К СВЯЗИ.
  section({
    title: "Связи в собственный компонент",
    items: (a: Alerts) => a.descendant_edges,
    key: (e) => e.edge_id,
    go: (e) => toEdge(e.edge_id),
    body: (e) => {
      const part = e.source_is_part ? e.source_name : e.target_name;
      const whole = e.source_is_part ? e.target_name : e.source_name;
      return (
        <>
          <span className="sa-line">
            <span className="sa-where">{e.source_name} → {e.target_name}:</span>{" "}
            <span className="sa-strong">«{part}»</span> входит в «{whole}»
          </span>
          <span className="sa-hint">
            иерархия уже выражает вложенность, удалите связь или перевесьте её
          </span>
        </>
      );
    },
  }),
  // Изолированные группы — это «не хватает (групп − 1) связей»: 2 группы → 1 недостающая
  // связь, 3 → 2 и т.д. В общее число рекомендаций идёт groups − 1 (число проблем), а
  // в число самого раздела — фактическое число групп. Общее число на экран не
  // выводится: оно лишь зажигает точку на кнопке и решает, пуста ли панель.
  section({
    title: "Изолированные группы",
    items: (a: Alerts) => a.isolated_groups,
    problems: (groups) => Math.max(0, groups.length - 1),
    key: (_grp, i) => i,
    go: (grp) => ({ locate: { kind: "group", ids: grp.node_ids } }),
    body: (grp, i) => <><span className="sa-where">Группа {i + 1}:</span> {grp.node_names.join(", ")}</>,
  }),
  // Контейнер с СОБСТВЕННЫМИ доками/спекой (grandfather): каждая запись — одна проблема
  // (схемы/спеку надо распределить по детям). Что именно осталось, строка НЕ уточняет:
  // конкретное предупреждение с путём исправления ждёт на странице объекта.
  section({
    title: "Контейнеры со своей документацией",
    items: (a: Alerts) => a.container_own_docs,
    key: (c) => c.node_id,
    go: (c) => toNode(c.node_id),
    body: (c) => c.node_name,
  }),
  // Пометка обещает факт («пишет: orders.status»), а структура его не подтверждает.
  // Единственное место, где видна битая КОЛОНКА — обратный индекс базы показывает такую
  // пометку как обращение к таблице целиком. Строка ведёт к узлу-ВЛАДЕЛЬЦУ дока:
  // чинится текст у него, а не структура базы.
  section({
    title: "Обращения к неописанным данным",
    items: (a: Alerts) => a.unresolved_data_refs,
    key: (r) => `${r.doc_id}:${r.mode}:${r.ref}`,
    go: (r) => toNode(r.node_id),
    body: (r) => (
      <span className="sa-line">
        <span className="sa-where">{r.node_name} · {r.doc_name}:</span>{" "}
        <span className="sa-strong">„{r.ref}“</span>: {REF_REASON[r.reason]}
      </span>
    ),
  }),
  // Событийный близнец предыдущего раздела: пометка обещала канал, а структура брокеров
  // его не знает. Отдельный класс — чинится другими словами (см. CHANNEL_REASON); строка
  // так же ведёт к узлу-ВЛАДЕЛЬЦУ дока.
  section({
    title: "Обращения к неописанным каналам",
    items: (a: Alerts) => a.unresolved_channel_refs,
    key: (r) => `${r.doc_id}:${r.mode}:${r.ref}`,
    go: (r) => toNode(r.node_id),
    body: (r) => (
      <span className="sa-line">
        <span className="sa-where">{r.node_name} · {r.doc_name}:</span>{" "}
        <span className="sa-strong">„{r.ref}“</span>: {CHANNEL_REASON[r.reason]}
      </span>
    ),
  }),
  // Третья семья пометок: обещала ручку, а её у ОБЪЕКТА нет (искать больше негде —
  // параметры принадлежат самому сервису), поэтому и место починки ровно одно. Причины у
  // класса нет: она единственная. Класс заведомо ловит и ПРОЗУ («зависит от: нагрузки»)
  // — так задумано (маркер с двоеточием обещает факт), и подсказка называет оба выхода,
  // иначе строка читалась бы как шум.
  section({
    title: "Обращения к неописанным параметрам",
    items: (a: Alerts) => a.unresolved_config_refs,
    key: (r) => `${r.doc_id}:${r.ref}`,
    go: (r) => toNode(r.node_id),
    body: (r) => (
      <span className="sa-line">
        <span className="sa-where">{r.node_name} · {r.doc_name}:</span>{" "}
        <span className="sa-strong">„{r.ref}“</span>: параметра нет в конфигурации
        объекта: опишите его или, если это обычная фраза, уберите двоеточие
      </span>
    ),
  }),
  // Стрелка в брокер обязана назвать топик (решение №4): шов «стрелка ↔ структура
  // брокера» держат алерты, а не FK, — это единственное место, где он виден. Строка
  // ведёт К СВЯЗИ — канал правится в её инспекторе, а не в структуре брокера.
  section({
    title: "Связи с брокером без канала",
    items: (a: Alerts) => a.broker_edge_channels,
    key: (b) => b.edge_id,
    go: (b) => toEdge(b.edge_id),
    body: (b) => (
      <span className="sa-line">
        <span className="sa-where">{b.source_name} → {b.target_name}:</span>{" "}
        {/* Тексты причин разные по СМЫСЛУ починки: «не указан» — дописать
            канал в инспекторе; «не найден» — опечатка либо канал не описан
            в структуре брокера (и тогда чинят её). */}
        {b.reason === "missing" ? (
          "канал не указан"
        ) : (
          <>канал <span className="sa-strong">«{b.channel}»</span> не найден у брокера «{b.broker_name}»</>
        )}
      </span>
    ),
  }),
  // Повисшие сообщения процессов: связь под сообщением удалили из схемы. Чинить на
  // холсте нечего — строка ведёт В ПРОЦЕСС.
  section({
    title: "Незадокументированные сообщения",
    items: (a: Alerts) => a.dangling_messages,
    key: (m) => m.message_id,
    go: (m) => ({ process: m.process_id }),
    body: (m) => <>{stepLine(m)}<span className="sa-hint">{m.from_name} → {m.to_name}</span></>,
  }),
  // Шаги, у которых пропало ПЛЕЧО канала: связь на месте, но она стала асинхронной, а у
  // такой «ответа» не бывает. Отдельно от повисших: «Восстановить связи» тут бессильна —
  // чинится возвратом синхронности либо удалением шага.
  section({
    title: "Ответ на асинхронном канале",
    items: (a: Alerts) => a.orphan_legs,
    key: (m) => m.message_id,
    go: (m) => ({ process: m.process_id }),
    body: (m) => (
      <>
        {stepLine(m)}
        <span className="sa-hint">
          {m.from_name} → {m.to_name}
          {m.edge_label ? ` · канал «${m.edge_label}»` : ""}
        </span>
      </>
    ),
  }),
  // Участники процессов без узла схемы: линия жизни есть, объекта архитектуры за ней нет
  // (импорт не сопоставил имя либо узел удалили). Чинится привязкой на шапке.
  section({
    title: "Незадокументированные участники",
    items: (a: Alerts) => a.unbound_participants,
    key: (p) => p.participant_id,
    go: (p) => ({ process: p.process_id }),
    body: (p) => (
      <span className="sa-row">
        <span className="sa-where">{p.process_name}:</span>
        <span className="sa-strong">{p.name}</span>
      </span>
    ),
  }),
  // Шаги процессов без привязки к схеме логики — алерт ПОЛНОТЫ (Р4 «шумно, зато
  // консистентно»): не «сломалось», а «не документировано», гаснет привязкой шагов.
  section({
    title: "Шаги без схемы логики",
    items: (a: Alerts) => a.unlinked_messages,
    key: (m) => m.message_id,
    go: (m) => ({ process: m.process_id }),
    body: (m) => <>{stepLine(m)}<span className="sa-hint">{m.from_name} → {m.to_name}</span></>,
  }),
  // Объекты с заглушками разведки (схемы без тела) — та же полнота, но ОДНА строка на
  // объект с числом заглушек: две сотни строк после разведки монолита были бы стеной, а
  // не сигналом. Построчный бэклог — на странице объекта (блок «Не описано»).
  section({
    title: "Объекты с неописанными схемами логики",
    items: (a: Alerts) => a.undescribed_docs,
    key: (u) => u.node_id,
    go: (u) => toNode(u.node_id),
    body: (u) => (
      <span className="sa-row">
        <span>{u.node_name}</span>
        <span className="sa-muted">{u.count} {plural(u.count, ["схема", "схемы", "схем"])}</span>
      </span>
    ),
  }),
  // Люди внутри системы: каждый вложенный человек — одна проблема (вынести в корень).
  section({
    title: "Пользователи внутри контейнера",
    items: (a: Alerts) => a.persons_inside,
    key: (p) => p.node_id,
    go: (p) => toNode(p.node_id),
    body: (p) => (
      <span className="sa-row">
        <span className="sa-strong">{p.node_name}</span>
        <span className="sa-muted">внутри</span>
        <span>{p.parent_name}</span>
      </span>
    ),
  }),
];

export default function SchemaAlerts({ alerts, onLocate, onOpenProcess, size = 32, placement = "header" }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const total = ALERT_SECTIONS.reduce((n, s) => n + s.problems(alerts), 0);

  useDismiss(open, ref, setOpen);

  // Клик по пункту ведёт к цели (на страницу объекта, в редактор или в процесс) —
  // переход уводит с текущего экрана, поэтому панель сразу закрываем.
  const nav: Nav = {
    locate: onLocate && ((target) => { setOpen(false); onLocate(target); }),
    openProcess: onOpenProcess && ((id) => { setOpen(false); onOpenProcess(id); }),
  };

  return (
    <div ref={ref} style={wrap}>
      <button
        type="button"
        className={"sa-btn" + (placement === "canvas" ? " sa-btn--canvas" : "")}
        style={{ width: size, height: size }}
        onClick={() => setOpen((o) => !o)}
        title="Рекомендации"
        aria-label="Рекомендации"
        aria-expanded={open}
      >
        <BulbIcon />
        {/* Точка вместо числа: «есть что посмотреть», а не «сколько долга». */}
        {total > 0 && <span className="sa-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="sa-panel" role="dialog" aria-label="Рекомендации">
          <div className="sa-head">
            <h3 className="sa-title">Рекомендации</h3>
            {total > 0 && <p className="sa-sub">Что ещё можно дополнить в схеме.</p>}
          </div>

          {/* Пустые разделы не рендерятся, поэтому при нуле ниже ничего нет. */}
          {total === 0 && <div className="sa-empty">Рекомендаций нет. Схема описана полностью.</div>}

          {ALERT_SECTIONS.map((s) => s.render(alerts, nav))}
        </div>
      )}
    </div>
  );
}

/* раздел: подпись с числом + строки */
function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null; // пустые разделы не показываем
  return (
    <div className="sa-sec">
      <div className="sa-sec-head">
        <span>{title}</span>
        <span className="sa-sec-count">{count}</span>
      </div>
      {children}
    </div>
  );
}

/* строка-пункт: обычный текст, стрелка перехода — у пункта под курсором. Кликабельна, если есть onClick */
// hint — подсказка перехода: к объекту на схеме или (у пунктов процессов) в процесс.
function Item({ children, onClick, hint = "Показать на схеме" }: {
  children: ReactNode; onClick?: (() => void) | false | undefined; hint?: string;
}) {
  return (
    <div
      className={"sa-item" + (onClick ? " sa-item--clickable" : "")}
      onClick={onClick || undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={onClick ? hint : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <span className="sa-text">{children}</span>
      {onClick && <span className="sa-go" aria-hidden="true">→</span>}
    </div>
  );
}

// Якорь выпадающей панели (relative). pointerEvents возвращаем: рейл холста
// (MapEditorPage.toastRail) прозрачен для мыши, а кнопка и панель — интерактивные.
// flex, а не блок: иначе строчный бокс кнопки добавил бы снизу зазор под строку.
const wrap: CSSProperties = { position: "relative", display: "flex", pointerEvents: "auto" };
