import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type {
  CompanionProps,
  PluginApiClient,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { TmuxCompanion, attachCommand } from "../../src/frontend/TmuxCompanion";
import { tmuxPanelEnabled } from "../../src/frontend/host-tmux-monitor";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const host = {
  id: "4",
  name: "box",
  ip: "10.0.0.4",
  port: 22,
  enableSsh: true,
  pluginSettings: { "tmux-monitor": { enableTmuxMonitor: true } },
};

const overview = {
  available: true,
  sessions: [
    {
      name: "work",
      created: 1,
      lastActivity: 1,
      attachedClients: 0,
      tags: [],
      windows: [
        {
          index: 0,
          name: "shell",
          active: true,
          panes: [
            {
              id: "%1",
              index: 0,
              pid: 1,
              active: true,
              width: 80,
              height: 24,
              command: "bash",
              path: "/",
              title: "",
            },
          ],
        },
      ],
    },
  ],
};

function withCompanion(sendInput: (data: string) => void) {
  return {
    activate(app: TermixApp) {
      plugin.activate(app);
      app.registerSlotContribution("test.companion", {
        actionId: "test.companion",
        titleKey: "nav.tmuxMonitor",
        kind: "component",
        component: (() => (
          <TmuxCompanion
            {...({
              tab: { id: "tab-1", type: "terminal", label: "box", host },
              host,
              getHandle: () => ({ sendInput }),
              side: "right",
              isVisible: true,
              close: () => {},
              setSide: () => {},
            } as unknown as CompanionProps)}
          />
        )) as never,
      });
    },
  };
}

describe("tmux panel beside a terminal", () => {
  it("registers the panel toggle", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.actions()).toContain("tmux-monitor.togglePanel");
    expect(rendered.registered.slot("tab.menu")).toContain(
      "tmux-monitor.togglePanel",
    );
  });

  it("follows the host's monitor and panel switches", () => {
    expect(tmuxPanelEnabled(host as never)).toBe(true);
    expect(
      tmuxPanelEnabled({
        ...host,
        pluginSettings: {
          "tmux-monitor": { enableTmuxMonitor: true, showPanel: false },
        },
      } as never),
    ).toBe(false);
    expect(tmuxPanelEnabled({ ...host, pluginSettings: {} } as never)).toBe(
      false,
    );
  });

  it("quotes the session name in the attach command", () => {
    expect(attachCommand("it's")).toBe(
      "tmux switch-client -t 'it'\\''s' 2>/dev/null || tmux attach -t 'it'\\''s'\r",
    );
  });

  it("attaches the terminal to a session", async () => {
    const sendInput = vi.fn();
    const api = {
      get: vi.fn(async () => ({ data: overview })),
      post: vi.fn(async () => ({ data: {} })),
    } as unknown as PluginApiClient;
    rendered = await renderWithApp(withCompanion(sendInput), {
      manifest,
      locales,
      api,
    });
    rendered.renderSlot("test.companion");
    expect(await screen.findByText("work")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Attach"));
    await waitFor(() =>
      expect(sendInput).toHaveBeenCalledWith(attachCommand("work")),
    );
  });
});
