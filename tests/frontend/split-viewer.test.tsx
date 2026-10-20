import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SplitViewer } from "../../src/frontend/SplitViewer";
import { PanePreview } from "../../src/frontend/PanePreview";
import * as api from "../../src/frontend/api";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@termix-ssh/plugin-sdk/ui", async (original) => ({
  ...(await original<object>()),
  PluginComponent: (props: { tmuxAttachSession?: string }) => (
    <div data-testid="term">{props.tmuxAttachSession}</div>
  ),
}));
vi.mock("../../src/frontend/api", () => ({
  createTmuxView: vi.fn(),
  releaseTmuxView: vi.fn().mockResolvedValue(undefined),
}));

const host = { id: 3, name: "h", ip: "h", port: 22 } as never;
const view = {
  id: "v1",
  hostId: 3,
  sessionName: "work",
  windowIndex: 1,
  column: "main",
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SplitViewer window/pane lifecycle", () => {
  it("attaches to the helper session, and recreates one on reattach", async () => {
    vi.mocked(api.createTmuxView)
      .mockResolvedValueOnce("termix-view-aaaaaaaa")
      .mockResolvedValueOnce("termix-view-bbbbbbbb");
    render(
      <SplitViewer host={host} view={view} isVisible onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("term")).toHaveTextContent(
        "termix-view-aaaaaaaa",
      ),
    );
    fireEvent.click(screen.getByLabelText("tmuxMonitor.reattach"));
    await waitFor(() =>
      expect(screen.getByTestId("term")).toHaveTextContent(
        "termix-view-bbbbbbbb",
      ),
    );
    expect(api.createTmuxView).toHaveBeenCalledTimes(2);
    expect(api.releaseTmuxView).toHaveBeenCalledWith(3, "termix-view-aaaaaaaa");
  });

  it("releases a session created after the viewer was already closed", async () => {
    let resolve!: (name: string) => void;
    vi.mocked(api.createTmuxView).mockReturnValue(
      new Promise<string>((r) => (resolve = r)),
    );
    const { unmount } = render(
      <SplitViewer host={host} view={view} isVisible onClose={() => {}} />,
    );
    unmount();
    vi.mocked(api.releaseTmuxView).mockRejectedValueOnce(new Error("down"));
    resolve("termix-view-cccccccc");
    await waitFor(() =>
      expect(api.releaseTmuxView).toHaveBeenCalledWith(
        3,
        "termix-view-cccccccc",
      ),
    );
  });

  it("releases the helper session when the viewer closes", async () => {
    vi.mocked(api.createTmuxView).mockResolvedValue("termix-view-dddddddd");
    const { unmount } = render(
      <SplitViewer host={host} view={view} isVisible onClose={() => {}} />,
    );
    await screen.findByTestId("term");
    unmount();
    expect(api.releaseTmuxView).toHaveBeenCalledWith(3, "termix-view-dddddddd");
  });

  it("shows a failure instead of a terminal when the window is gone", async () => {
    vi.mocked(api.createTmuxView).mockRejectedValue(new Error("404"));
    render(
      <SplitViewer host={host} view={view} isVisible onClose={() => {}} />,
    );
    await screen.findByText("tmuxMonitor.splitViewFailed");
    expect(screen.queryByTestId("term")).toBeNull();
  });
});

describe("right click after a kept tmux selection", () => {
  const preview = (keeps: boolean) =>
    render(
      <PanePreview
        host={host}
        pane={{ paneId: "", sessionName: "work", windowIndex: 0 }}
        onClose={() => {}}
        keepsSelection={keeps}
      />,
    );

  const rightClick = (el: Element) => {
    const reached = vi.fn();
    el.parentElement!.addEventListener("contextmenu", reached);
    const notPrevented = fireEvent.contextMenu(el);
    return { reached, notPrevented };
  };

  it("does not let the terminal's right-click paste fire", () => {
    preview(true);
    const term = screen.getByTestId("term");
    const { notPrevented } = rightClick(term);
    expect(notPrevented).toBe(false);
    expect(rightClick(term).notPrevented).toBe(false);
  });

  it("leaves right click alone when the option is off", () => {
    preview(false);
    const term = screen.getByTestId("term");
    expect(rightClick(term).notPrevented).toBe(true);
  });
});
