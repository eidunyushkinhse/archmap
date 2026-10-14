import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ConnectionNotice, { CONNECTION_NOTICE } from "../ConnectionNotice";
import { setOffline } from "../../lib/connection";

afterEach(() => setOffline(false));

describe("ConnectionNotice (аудит R-24)", () => {
  it("появляется, пока нет связи, и гаснет, когда она вернулась", () => {
    render(<ConnectionNotice />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => setOffline(true));
    expect(screen.getByRole("status")).toHaveTextContent(CONNECTION_NOTICE);
    act(() => setOffline(false));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
