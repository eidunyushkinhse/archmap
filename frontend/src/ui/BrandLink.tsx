// Логотип и название ArchMap в левом верхнем углу. С onClick — кнопка, ведущая на
// экран «Все проекты» (оболочка проекта и редактор); без него — просто знак (сам
// экран «Все проекты» и вход: вести некуда).
import { LogoMark } from "./icons";
// Вид — классы ui/chrome.css (brand*): стили импортирует модуль, который ставит класс
// (шапки, где стоит логотип, chrome.css могут и не грузить).
import "./chrome.css";

export default function BrandLink({ onClick }: { onClick?: () => void }) {
  const inner = (
    <>
      <LogoMark />
      <span className="brand-word">
        Arch<span className="brand-word-accent">Map</span>
      </span>
    </>
  );
  if (!onClick) return <div className="brand">{inner}</div>;
  return (
    <button type="button" className="brand brand-link" data-tour="logo" onClick={onClick} title="Все проекты" aria-label="Все проекты">
      {inner}
    </button>
  );
}
