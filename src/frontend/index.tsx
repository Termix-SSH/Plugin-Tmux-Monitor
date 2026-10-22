import { Layers } from "lucide-react";
import type {
  StandaloneViewProps,
  TabProps,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { setTmuxMonitorApi } from "./api";
import { tmuxMonitorEnabled, tmuxPanelEnabled } from "./host-tmux-monitor";
import { TmuxCompanion, useTmuxCompanionDefaults } from "./TmuxCompanion";
import { HostTmuxMonitorSection } from "./HostTmuxMonitorSection";
import { TmuxMonitor } from "./TmuxMonitor";
import TmuxMonitorApp from "./TmuxMonitorApp";

const VIEW_ID = "tmux_monitor";

function TmuxMonitorTab({ tab, isVisible }: TabProps) {
  const hostId = (tab.data?.hostId as number | undefined) ?? undefined;
  return (
    <TmuxMonitor
      initialHostId={hostId}
      initialHostRequest={tab.data?.hostRequest as number | undefined}
      isVisible={isVisible}
    />
  );
}

function TmuxMonitorStandalone(props: StandaloneViewProps) {
  return <TmuxMonitorApp {...props} />;
}

export function activate(app: TermixApp): void {
  setTmuxMonitorApi(app.api);
  app.onDispose(() => setTmuxMonitorApi(null));

  // A single cross-host browser, like the old core tab: opening it from a
  // host row just points the already-open (or newly opened) tab at that host.
  app.registerTab(VIEW_ID, TmuxMonitorTab, {
    icon: Layers,
    titleKey: "nav.tmuxMonitor",
    singleton: true,
    hostless: true,
    persistent: true,
    activityTypes: ["tmux_monitor"],
    standalone: TmuxMonitorStandalone,
  });

  app.registerHostAction({
    id: "tmux_monitor",
    titleKey: "nav.tmuxMonitor",
    icon: Layers,
    kind: "open",
    order: 70,
    copyUrlView: VIEW_ID,
    when: (host) => !!host.enableSsh && tmuxMonitorEnabled(host),
    run: (host, shell) =>
      shell.openSingletonTab(VIEW_ID, {
        data: { hostId: Number(host.id), hostRequest: Date.now() },
      }),
  });

  app.registerHostEditorSection({
    id: "tmux-monitor",
    group: "ssh",
    titleKey: "hosts.tabTmuxMonitor",
    icon: Layers,
    order: 45,
    defaults: true,
    component: HostTmuxMonitorSection,
  });

  // Cores before 26.10.3 have no panels beside tabs.
  if (typeof app.registerCompanion === "function") {
    app.registerCompanion("tmux", TmuxCompanion, {
      icon: Layers,
      titleKey: "nav.tmuxMonitor",
      order: 70,
      tabTypes: ["terminal"],
      when: (_tab, host) => !!host?.enableSsh && tmuxPanelEnabled(host),
      useDefaults: useTmuxCompanionDefaults,
    });
    app.registerAction("tmux-monitor.togglePanel", ((
      _handle: unknown,
      tab: unknown,
    ) => app.toggleCompanion(tab as never, "tmux")) as never);
    app.registerSlotContribution("tab.menu", {
      actionId: "tmux-monitor.togglePanel",
      titleKey: "companion.toggle",
      icon: Layers,
      kind: "button",
      order: 10,
      when: (context) => {
        const tab = context.tab as {
          type?: string;
          host?: unknown;
          hostConfig?: unknown;
        } | null;
        return (
          tab?.type === "terminal" &&
          tmuxPanelEnabled((tab.host ?? tab.hostConfig) as never)
        );
      },
    });
  }
}
