import { describe, it, expect } from "vitest";
import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDismiss } from "../useDismiss";

// Панель вынесена из-под якоря (как легенда порталом): нажатие в ней — «внутри».
function Detached() {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, setOpen, panel);
  return (
    <>
      <div ref={ref}><button type="button">якорь</button></div>
      <p>снаружи</p>
      {open && <div ref={panel}><span>вынесенная панель</span></div>}
    </>
  );
}

function Popover() {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, setOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>открыть</button>
      <div ref={ref}>{open && <span>панель</span>}<button type="button">внутри</button></div>
      <p>снаружи</p>
    </>
  );
}

describe("useDismiss", () => {
  it("нажатие внутри не закрывает, снаружи — закрывает", () => {
    render(<Popover />);
    fireEvent.mouseDown(screen.getByText("внутри"));
    expect(screen.queryByText("панель")).not.toBeNull();
    fireEvent.mouseDown(screen.getByText("снаружи"));
    expect(screen.queryByText("панель")).toBeNull();
  });

  it("Escape закрывает, прочие клавиши — нет", () => {
    render(<Popover />);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.queryByText("панель")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("панель")).toBeNull();
  });

  it("вынесенная панель (inside) — тоже «внутри»", () => {
    render(<Detached />);
    fireEvent.mouseDown(screen.getByText("вынесенная панель"));
    expect(screen.queryByText("вынесенная панель")).not.toBeNull();
    fireEvent.mouseDown(screen.getByText("якорь"));
    expect(screen.queryByText("вынесенная панель")).not.toBeNull();
    fireEvent.mouseDown(screen.getByText("снаружи"));
    expect(screen.queryByText("вынесенная панель")).toBeNull();
  });
});
