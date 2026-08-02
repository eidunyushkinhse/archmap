// Правка вида схемы (kind) в YAML-тексте манифеста archmap-docs — для режима
// «по одной схеме» DocsAgentModal: пользователь меняет вид в превью, правка
// вносится в текст манифеста перед применением (бэк читает kind из манифеста).

import type { NodeDocKind } from "../../types";

// Блок схемы находится по строке `name: <имя>` (первое совпадение значения);
// kind меняется ТОЛЬКО в пределах блока: граница — следующая строка `name:` на
// том же отступе ключей либо непустая строка с меньшим отступом (дедент:
// openapi / новая запись узла). Точный отступ отличает ключ `kind:` от строки
// внутри mermaid-текста: строки блочного скаляра (mermaid: |) всегда глубже
// ключей элемента, а строка на отступе ключей уже завершила бы скаляр. Если
// ключа kind в блоке нет (бэк трактует отсутствие как overview) — вставляем
// сразу за строкой name (при дубле ключа yaml.safe_load берёт последний — наш).
// null — имя не найдено (фолбэк вызывающей стороны: применить манифест как есть).
export function replaceLogicKind(content: string, name: string, kind: NodeDocKind): string | null {
  const lines = content.split("\n");
  // `name: X` / `- name: X`, значение в кавычках или без
  const nameRe = /^(\s*)(?:-\s+)?name:\s*(?:"([^"]*)"|'([^']*)'|(.*?))\s*$/;
  let nameIdx = -1;
  let keyIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = nameRe.exec(lines[i]);
    if (m === null) continue;
    if ((m[2] ?? m[3] ?? m[4] ?? "").trim() !== name) continue;
    nameIdx = i;
    keyIndent = lines[i].indexOf("name:");
    break;
  }
  if (nameIdx < 0) return null;

  // Граница блока схемы
  let endIdx = lines.length;
  for (let i = nameIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // пустые строки блочного скаляра не в счёт
    const indent = line.length - line.trimStart().length;
    if (indent < keyIndent) { endIdx = i; break; } // дедент: openapi / новый узел
    if (line.indexOf("name:") === keyIndent && nameRe.test(line)) { endIdx = i; break; }
  }

  const kindLine = `${" ".repeat(keyIndent)}kind: ${kind}`;
  for (let i = nameIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    if (line.length - line.trimStart().length !== keyIndent) continue;
    if (!line.trimStart().startsWith("kind:")) continue;
    lines[i] = kindLine;
    return lines.join("\n");
  }
  lines.splice(nameIdx + 1, 0, kindLine);
  return lines.join("\n");
}
