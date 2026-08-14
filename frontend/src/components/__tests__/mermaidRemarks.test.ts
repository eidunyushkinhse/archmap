// Проверка схем пакета НАСТОЯЩИМ mermaid-парсером (Ф8и).
//
// Полевая находка (Zulip v2, финальный пакет): 9 из 30 применённых схем не
// парсились — класс «рассогласованные скобки вершины» (`F{"Есть вложения?"]`:
// открыто `{"`, закрыто `"]`). Схемы применились мёртвыми для рендера, и человек
// узнавал об этом, открыв док. Здесь проверяется обе половины лечения: что парсер
// такой класс ЛОВИТ (smoke настоящим парсером) и что замечание называет ФАЙЛ —
// чинит агент файлы, и «схема "Приём заказа"» ему адреса не даёт.
import { describe, it, expect, vi } from "vitest";
import { checkMermaid, MAX_MERMAID_REMARKS } from "../docsImport/agentModalShared";
import { validateMermaid } from "../mermaidLoader";

const ОШИБКА = 'Parse error on line 7:\n...F{"Есть вложения?"]\n----------------^\nExpecting SQE, got PS';

function строка(source: string, mermaid = "graph TD\n  A --> B\n") {
  return { source, mermaid };
}

describe("checkMermaid · замечания о непарсящихся схемах", () => {
  it("замечание называет файл и первую строку сообщения парсера", async () => {
    // Парсер внедряется: тяжёлый чанк mermaid тесту не нужен, а формат — нужен.
    const парсер = vi.fn((text: string) =>
      Promise.resolve(text.includes("битая") ? ОШИБКА : null),
    );

    const { errs, remarks } = await checkMermaid(
      [строка("01-create-order.mmd", "graph TD\n битая"), строка("02-ok.mmd")],
      парсер,
    );

    // В первой строке парсера есть номер строки — по нему агент чинит за один заход
    // (тот же приём, что закрыл классы битого YAML).
    expect(remarks).toEqual([
      "01-create-order.mmd: mermaid не парсится — Parse error on line 7:",
    ]);
    // Ошибки по схемам остаются отдельно: из них рисуется значок ✗ в строке файла.
    expect(errs).toEqual([ОШИБКА, null]);
  });

  it("здоровый пакет замечаний не даёт", async () => {
    const { errs, remarks } = await checkMermaid(
      [строка("a.mmd"), строка("b.mmd")],
      () => Promise.resolve(null),
    );

    expect(remarks).toEqual([]);
    expect(errs).toEqual([null, null]);
  });

  it("кап замечаний и хвост «…ещё N»", async () => {
    // Замечания уезжают агенту ОДНИМ списком: три десятка строк одного класса
    // вытеснят из него всё остальное (кап-паттерн бэковых проверок).
    const пакет = Array.from({ length: MAX_MERMAID_REMARKS + 3 }, (_, i) =>
      строка(`${i}.mmd`, "graph TD\n битая"),
    );

    const { remarks } = await checkMermaid(пакет, () => Promise.resolve(ОШИБКА));

    expect(remarks).toHaveLength(MAX_MERMAID_REMARKS + 1);
    expect(remarks[MAX_MERMAID_REMARKS]).toBe("…ещё 3 схем не парсятся");
  });
});

describe("mermaid-парсер · полевой класс рассогласованных скобок", () => {
  it("схему со скобками вразнобой отвергает, здоровую принимает", async () => {
    // Smoke НАСТОЯЩИМ парсером — дёшево ровно так же, как у соседей (mermaidLimits,
    // dbErDiagram): чанк грузится один раз на файл тестов. Без этого теста вся
    // проверка держалась бы на моке, а вопрос поля был именно «ловит ли парсер».
    const битая = 'graph TD\n  A["Старт"] --> F{"Есть вложения?"]\n  F --> B["Готово"]\n';
    const здоровая = 'graph TD\n  A["Старт"] --> F{"Есть вложения?"}\n  F --> B["Готово"]\n';

    expect(await validateMermaid(битая)).toContain("Parse error on line 2");
    expect(await validateMermaid(здоровая)).toBeNull();
  }, 60_000);
});
