// Список СОБСТВЕННЫХ схем логики объекта — группами по видам, со сворачиванием.
//
// Зачем группы: разведка монолита кладёт в «Логику» двести с лишним строк (у Zulip
// посчитано 212 точек входа), а до неё полевым максимумом были тринадцать. Плоский
// столбец из двухсот кнопок — не витрина, а стена: в ней не видно ни того, что уже
// сделано, ни того, за что браться. Сворачиваемые заголовки с числами дают и то, и
// другое, а свёрнутой стартует только та группа, которая сама стена (порог считается
// по её строкам): на маленьком объекте список выглядит как раньше.
//
// Списки «схемы потомков» у контейнера сюда НЕ ходят: там своя группировка по
// объектам, и вторая вложенность сделала бы кашу.
//
// Компоненты объявлены НА ВЕРХНЕМ УРОВНЕ МОДУЛЯ: объявленный внутри другого
// ремаунтится каждый рендер (ловушка проекта — так ломался drag палитры).
import { useCallback, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { NodeDocKind, NodeDocMeta } from "../types";
import { ChevronDownIcon } from "../ui/icons";
import { KIND_LABEL, OPEN_LIMIT } from "./docsList";

// Порядок групп — тот же, что у вида схемы во всём проекте: обзор → операция →
// воркер. Внутри группы порядок приходит с бэка (по имени) и фильтром сохраняется —
// сортировать заново незачем.
const GROUPS: { kind: NodeDocKind; title: string }[] = [
  { kind: "overview", title: "Обзоры" },
  { kind: "operation", title: "Операции" },
  { kind: "worker", title: "Воркеры" },
];

interface Props {
  docs: NodeDocMeta[];
  // Клик по строке открывает схему в оверлее документации.
  onOpen: (docId: string) => void;
  // Кнопка «Описать» у НЕописанной точки входа: адрес уезжает в окно доков режимом
  // «по одной». Не передан (читатель, чужая форма объекта) — кнопки нет вовсе.
  onDescribe?: (doc: NodeDocMeta) => void;
}

export default function NodeDocsList({ docs, onOpen, onDescribe }: Props) {
  // Группы — ПРОИЗВОДНОЕ в рендере (эффект с setState тут запрещён линтом и
  // рассинхронился бы с метой). Пустая группа не рисуется вовсе.
  //
  // Стартовая поза считается ПО СВОЕЙ ГРУППЕ, а не по объекту целиком: свернуть
  // надо то, что реально стена. У объекта на тринадцать схем (полевой Zulip до
  // разведки) стены нет ни в одной группе — список остаётся читаемым, как был; у
  // монолита свёрнуты «Операции (198)», а обзоры и воркеры видны сразу, и на экране
  // видно, где работа. Порог общий с превью окна разведки.
  //
  // Ключом идёт и сама поза: пока группа не перешла порог, поза пользователя живёт,
  // а перешла (приехал перечень на две сотни) — встаёт в новую, иначе развёрнутая
  // вчера «Операции» вернулась бы стеной.
  const groups = useMemo(
    () => GROUPS
      .map((g) => {
        const items = docs.filter((d) => d.kind === g.kind);
        return { ...g, items, startOpen: items.length <= OPEN_LIMIT };
      })
      .filter((g) => g.items.length > 0),
    [docs],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {groups.map((g) => (
        <DocKindGroup
          key={`${g.kind}:${g.startOpen}`}
          kind={g.kind}
          title={g.title}
          items={g.items}
          startOpen={g.startOpen}
          onOpen={onOpen}
          onDescribe={onDescribe}
        />
      ))}
    </div>
  );
}

// Группа одного вида: заголовок с числом строк и остатком работы, тело — строки.
// Состояние «свёрнуто/развёрнуто» живёт здесь и никуда не сохраняется: это поза
// списка на время просмотра, а не настройка.
function DocKindGroup({ kind, title, items, startOpen, onOpen, onDescribe }: {
  kind: NodeDocKind;
  title: string;
  items: NodeDocMeta[];
  startOpen: boolean;
  onOpen: (docId: string) => void;
  onDescribe?: (doc: NodeDocMeta) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const described = items.filter((d) => d.described).length;
  return (
    <>
      <button type="button" className="np-doc-group-toggle" onClick={toggle} aria-expanded={open}>
        <span className="np-doc-group-chev" style={{ transform: open ? "none" : "rotate(-90deg)" }}>
          <ChevronDownIcon />
        </span>
        {title}
        <span style={groupCount}>({items.length})</span>
        {/* У обзоров остатка работы нет: обзор не точка входа, в счётчик секции он
            тоже не входит — и расхождение двух чисел на одном экране читалось бы
            как ошибка. */}
        {kind !== "overview" && <span style={groupDescribed}>описано {described}</span>}
      </button>
      {open && (
        <div className="np-doc-group-body">
          {items.map((d) => (
            <DocRow key={d.id} doc={d} onOpen={onOpen} onDescribe={onDescribe} />
          ))}
        </div>
      )}
    </>
  );
}

// Строка схемы. Кнопка «Описать» — СОСЕД строки, а не вложенная кнопка: <button>
// внутри <button> невалиден, и клик по вложенной открывал бы заодно схему. Форма та
// же, что у split-строк объединения контейнера.
function DocRow({ doc, onOpen, onDescribe }: {
  doc: NodeDocMeta;
  onOpen: (docId: string) => void;
  onDescribe?: (doc: NodeDocMeta) => void;
}) {
  // Кнопка положена только неописанной точке входа: у обзора её нет (он не
  // адресуется как точка входа), у описанной строки путь прежний — «открыть →».
  const describe = onDescribe && !doc.described && doc.kind !== "overview" ? onDescribe : null;
  return (
    <div className="np-doc-split">
      <button
        type="button"
        className="np-doc-split-main"
        onClick={() => onOpen(doc.id)}
        title={`Открыть схему «${doc.name}»`}
      >
        <span style={rowName}>{doc.name}</span>
        <span className={`np-doc-chip np-doc-chip--${doc.kind}`}>{KIND_LABEL[doc.kind]}</span>
        {!doc.described && <StubMark />}
        {doc.operation && <span style={rowOperation}>{doc.operation}</span>}
        <span style={rowOpen}>открыть →</span>
      </button>
      {describe && (
        <button
          type="button"
          className="np-doc-split-child"
          style={describeBtn}
          onClick={() => describe(doc)}
          title={`Описать «${doc.name}» с помощью ИИ-агента`}
        >
          Описать
        </button>
      )}
    </div>
  );
}

// Метка заглушки: схема в списке есть, а тела у неё нет — список операций от агента
// создал её строкой перечня (docs/plan-recon.md). Спокойный пунктирный контур, а НЕ
// красная тревога: неописанная точка входа — нормальное состояние работы по списку,
// а не ошибка.
export function StubMark() {
  return <span style={stubMark}>не описана</span>;
}

// ── inline-стили строк и заголовков групп ─────────────────────────────
const groupCount: CSSProperties = { fontSize: 12, fontWeight: 400, color: "#94a3b8" };
const groupDescribed: CSSProperties = {
  marginLeft: "auto", fontSize: 12, fontWeight: 500, color: "#64748b", whiteSpace: "nowrap",
};
const rowName: CSSProperties = { fontWeight: 600, fontSize: 13 };
const rowOperation: CSSProperties = { fontSize: 12, color: "#64748b", fontFamily: "ui-monospace, monospace" };
const rowOpen: CSSProperties = { marginLeft: "auto", fontSize: 12, color: "#94a3b8" };
// «Описать» — действие, а не пояснение: тот же синий, что у «+ Добавить», иначе
// кнопка теряется в сером хвосте строки.
const describeBtn: CSSProperties = { color: "#2563eb", fontWeight: 600 };
const stubMark: CSSProperties = {
  flex: "none", fontSize: 11, fontWeight: 600, color: "#64748b",
  background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 5, padding: "1px 6px",
  whiteSpace: "nowrap",
};
