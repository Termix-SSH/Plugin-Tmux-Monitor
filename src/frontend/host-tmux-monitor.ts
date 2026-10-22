import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";

/** Whether the monitor is enabled for this host, as the host payload's
 * pluginSettings carries it. */
export function tmuxMonitorEnabled(
  host: PluginHostRecord | null | undefined,
): boolean {
  const settings = (
    host?.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.["tmux-monitor"];
  return settings?.enableTmuxMonitor === true;
}

/** Whether tmux keeps mouse selections here (it does whenever mouse is on). */
export function tmuxPersistentSelection(
  host: PluginHostRecord | null | undefined,
): boolean {
  const settings = (
    host?.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.["tmux-monitor"];
  return settings?.mouseEnabled !== false;
}

/** Whether the panel beside this host's terminal is on. */
export function tmuxPanelEnabled(
  host: PluginHostRecord | null | undefined,
): boolean {
  const settings = (
    host?.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.["tmux-monitor"];
  return settings?.enableTmuxMonitor === true && settings.showPanel !== false;
}
