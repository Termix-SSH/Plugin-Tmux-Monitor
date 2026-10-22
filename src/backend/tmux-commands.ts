import { randomUUID } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";
import { SEP, shellEscape } from "./monitor-helpers.js";

const TMUX_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/bin",
  "/usr/pkg/bin",
];

export function withTmuxPath(command: string): string {
  const script = `PATH=${TMUX_PATH_DIRS.join(":")}:"$PATH"; export PATH; ${command}`;
  return `/bin/sh -c ${shellEscape(script)}`;
}

export function tmuxCommand(args: string): string {
  return withTmuxPath(`tmux -u ${args}`);
}

/**
 * "windows" is a host without /bin/sh, like Windows OpenSSH running psmux
 * under cmd.exe or PowerShell. Commands there skip the sh wrapper and use
 * double quotes, which both shells read.
 */
export type TmuxShell = "posix" | "windows";

const shells = new WeakMap<Client, TmuxShell>();

// Read the same way by sh, cmd.exe and PowerShell, so left unquoted.
const PLAIN_ARG = /^[\w@+=:,./-]+$/;

export function windowsQuote(arg: string): string {
  if (PLAIN_ARG.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function posixQuote(arg: string): string {
  return PLAIN_ARG.test(arg) ? arg : shellEscape(arg);
}

/** One tmux call running each argument list in turn, quoted for the shell. */
export function buildTmuxCommand(
  shell: TmuxShell,
  ...commands: string[][]
): string {
  if (shell === "windows") {
    const parts = commands.map((args) => args.map(windowsQuote).join(" "));
    return `tmux -u ${parts.join(' ";" ')}`;
  }
  const parts = commands.map((args) => args.map(posixQuote).join(" "));
  return tmuxCommand(parts.join(" \\; "));
}

/**
 * Run a command on the remote host via a separate exec channel.
 * Returns stdout as a string. Does not pollute the interactive shell.
 */
export function execCommand(conn: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });
      stream.on("error", (err: Error) => {
        reject(err);
      });
      stream.on("close", (code: number) => {
        if (code !== 0 && stdout === "") {
          reject(
            new Error(stderr.trim() || `Command exited with code ${code}`),
          );
        } else {
          // Windows hosts end lines with CRLF.
          resolve(stdout.replace(/\r\n/g, "\n").trim());
        }
      });
    });
  });
}

/** Which shell runs tmux on this connection, or null without tmux. */
export async function detectTmuxShell(conn: Client): Promise<TmuxShell | null> {
  const known = shells.get(conn);
  if (known) return known;
  for (const shell of ["posix", "windows"] as const) {
    try {
      const version = await execCommand(conn, buildTmuxCommand(shell, ["-V"]));
      // Git for Windows can provide sh while tmux is native psmux. Its cmd
      // launcher cannot preserve POSIX quoting in format strings.
      const detected = /^psmux\s/im.test(version) ? "windows" : shell;
      shells.set(conn, detected);
      return detected;
    } catch {
      // try the next shell
    }
  }
  return null;
}

export async function tmuxShellFor(conn: Client): Promise<TmuxShell> {
  return (await detectTmuxShell(conn)) ?? "posix";
}

/** Runs one tmux call on the connection, in whatever shell it has. */
export async function execTmux(
  conn: Client,
  ...commands: string[][]
): Promise<string> {
  return execCommand(
    conn,
    buildTmuxCommand(await tmuxShellFor(conn), ...commands),
  );
}

interface TmuxSessionInfo {
  name: string;
  created: number;
  lastActivity: number;
  windows: number;
  attachedClients: number;
}

export interface TmuxDetectionResult {
  available: boolean;
  sessions: TmuxSessionInfo[];
}

/**
 * Detect whether tmux is installed and list all existing sessions with details.
 */
export async function detectTmux(conn: Client): Promise<TmuxDetectionResult> {
  if (!(await detectTmuxShell(conn))) {
    return { available: false, sessions: [] };
  }

  let sessions: TmuxSessionInfo[] = [];
  try {
    const output = await execTmux(conn, [
      "list-sessions",
      "-F",
      `#{session_name}${SEP}#{session_created}${SEP}#{session_activity}${SEP}#{session_windows}${SEP}#{session_attached}`,
    ]);
    if (output) {
      sessions = output
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name, created, activity, windows, attached] = line.split(SEP);
          return {
            name,
            created: parseInt(created, 10) || 0,
            lastActivity: parseInt(activity, 10) || 0,
            windows: parseInt(windows, 10) || 0,
            attachedClients: parseInt(attached, 10) || 0,
          };
        });
    }
  } catch {
    // tmux server not running yet -- no sessions exist
  }

  return { available: true, sessions };
}

/**
 * Wait for a tmux session to appear by polling via exec channel.
 * Returns the session name once found, or null on timeout.
 */
export async function waitForTmuxSession(
  conn: Client,
  sessionName: string,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await execTmux(conn, ["has-session", "-t", `=${sessionName}`]);
      return sessionName;
    } catch {
      // session not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/** The shell an interactive stream's connection was detected with. */
export function tmuxShellForStream(stream: ClientChannel): TmuxShell {
  // ssh2 keeps the owning client on every channel.
  const client = (stream as unknown as { _client?: Client })._client;
  return (client && shells.get(client)) || "posix";
}

/**
 * Session-scoped options set before attaching. set-option takes a pane target,
 * where a bare "=name" matches nothing and -q hides the error, so the options
 * would never be applied. "=name:" names the session exactly.
 */
export function sessionOptionCommands(
  name: string,
  mouseEnabled: boolean,
): string[][] {
  const target = `=${name}:`;
  return [
    ["set-option", "-q", "-t", target, "mouse", mouseEnabled ? "on" : "off"],
    ["set-option", "-q", "-t", target, "history-limit", "50000"],
  ];
}

/**
 * Write tmux attach or new-session command to the interactive shell stream.
 * Uses && exit so the shell only closes if tmux started successfully.
 *
 * Options are set on this session only so the user's own tmux config stays
 * untouched. -q keeps an older tmux that lacks an option from aborting the
 * attach.
 */
export function attachOrCreateTmuxSession(
  stream: ClientChannel,
  existingSessionName?: string,
  newSessionName?: string,
  mouseEnabled = true,
  shell: TmuxShell = tmuxShellForStream(stream),
): void {
  const name =
    existingSessionName || newSessionName || `termix-${randomUUID()}`;
  const commands = existingSessionName
    ? []
    : [["new-session", "-d", "-s", name]];
  commands.push(...sessionOptionCommands(name, mouseEnabled), [
    "attach-session",
    "-t",
    `=${name}`,
  ]);
  const command = buildTmuxCommand(shell, ...commands);
  // PowerShell 5 has no &&, so a Windows shell stays open after a detach.
  stream.write(shell === "windows" ? `${command}\r` : `${command} && exit\r`);
}
