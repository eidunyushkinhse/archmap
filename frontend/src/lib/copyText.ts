// Копирование в буфер, которое работает там, где ArchMap реально стоит (аудит R-6).
// navigator.clipboard есть только в защищённом контексте: на http:// не-localhost (это
// поддерживаемый режим установки в закрытом контуре) его нет вовсе. Safari к тому же
// пускает запись только в жесте пользователя, а промпт приходит с сервера ПОСЛЕ await —
// жест к этому моменту потерян. Раньше отказ глотался: главная кнопка BYOA «не работала».
//
// Порядок попыток: ClipboardItem с обещанием (запись начинается синхронно, в жесте, а
// текст догружается — так Safari принимает) → clipboard.writeText → скрытая textarea и
// execCommand("copy") (работает и на http) → CopyFailed с текстом: вызывающий показывает
// его, чтобы скопировать вручную.

export class CopyFailed extends Error {
  readonly text: string;
  constructor(text: string) {
    super("Не удалось скопировать в буфер обмена");
    this.text = text;
  }
}

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export async function copyText(source: string | Promise<string>): Promise<void> {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (typeof source !== "string" && clip && typeof clip.write === "function" && typeof ClipboardItem !== "undefined") {
    try {
      const blob = source.then((t) => new Blob([t], { type: "text/plain" }));
      await clip.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // ниже — попытки попроще; сам текст (если он не загрузился) отклонит await ниже
    }
  }
  const text = await source;
  if (clip && typeof clip.writeText === "function") {
    try {
      await clip.writeText(text);
      return;
    } catch {
      // отказ разрешения или потерянный жест — пробуем по-старому
    }
  }
  if (legacyCopy(text)) return;
  throw new CopyFailed(text);
}

/** Скопировать готовый текст; если браузер не дал — показать его в окне для ручного
 *  копирования (для мелких кнопок вроде «Скопировать замечания», у которых нет своего
 *  места под текст). Разрешается, только если текст попал в буфер. */
export async function copyTextOrShow(text: string): Promise<void> {
  try {
    await copyText(text);
  } catch (e) {
    if (e instanceof CopyFailed) window.prompt("Скопируйте текст вручную (Ctrl+C):", text);
    throw e;
  }
}
