import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ClientChannel } from "ssh2";
import { describe, expect, it } from "vitest";
import {
  attachOrCreateTmuxSession,
  buildTmuxCommand,
  sessionOptionCommands,
  detectTmux,
  tmuxCommand,
  withTmuxPath,
} from "../../src/backend/tmux-commands.js";

describe("tmux command path handling", () => {
  it("prepends all non-login tmux paths while preserving inherited PATH", () => {
    expect(withTmuxPath("command -v tmux")).toBe(
      `/bin/sh -c 'PATH=/opt/homebrew/bin:/usr/local/bin:/opt/bin:/usr/pkg/bin:"$PATH"; export PATH; command -v tmux'`,
    );
  });

  it("shell-escapes embedded single quotes in wrapped commands", () => {
    // Asserted as a string so the escaping rule is covered everywhere. The
    // round-trip below proves it against a real parser, but only where one
    // exists -- see the note there.
    expect(withTmuxPath(`printf '%s' "can't"`)).toBe(
      "/bin/sh -c 'PATH=/opt/homebrew/bin:/usr/local/bin:/opt/bin:/usr/pkg/bin:\"$PATH\"; export PATH; printf '\\''%s'\\'' \"can'\\''t\"'",
    );
  });

  // /bin/sh is not on Windows, and Windows is a supported platform for the
  // desktop app -- contributors run `npm test` there. CI is ubuntu-only, so it
  // would never notice this failing.
  it.skipIf(process.platform === "win32")(
    "produces a command a real shell parses back to the original",
    () => {
      const command = withTmuxPath(`printf '%s' "can't"`);

      expect(
        execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }),
      ).toBe("can't");
    },
  );

  it("runs every tmux invocation in UTF-8 mode through the path wrapper", () => {
    expect(tmuxCommand("list-sessions")).toBe(
      `/bin/sh -c 'PATH=/opt/homebrew/bin:/usr/local/bin:/opt/bin:/usr/pkg/bin:"$PATH"; export PATH; tmux -u list-sessions'`,
    );
  });

  it("detects tmux with the UTF-8 wrapper", async () => {
    const commands: string[] = [];
    const conn = {
      exec(command: string, callback: (error: null, stream: never) => void) {
        commands.push(command);
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);

        queueMicrotask(() => {
          if (commands.length === 1) {
            stream.emit("data", Buffer.from("tmux 3.7b\n"));
            stream.emit("close", 0);
            return;
          }
          stream.emit("close", 1);
        });
      },
    } as unknown as Client;

    await expect(detectTmux(conn)).resolves.toEqual({
      available: true,
      sessions: [],
    });
    expect(commands).toEqual([
      `/bin/sh -c 'PATH=/opt/homebrew/bin:/usr/local/bin:/opt/bin:/usr/pkg/bin:"$PATH"; export PATH; tmux -u -V'`,
      `/bin/sh -c 'PATH=/opt/homebrew/bin:/usr/local/bin:/opt/bin:/usr/pkg/bin:"$PATH"; export PATH; tmux -u list-sessions -F '\\''#{session_name}<<TMX>>#{session_created}<<TMX>>#{session_activity}<<TMX>>#{session_windows}<<TMX>>#{session_attached}'\\'''`,
    ]);
  });
});

describe("native psmux with Git sh", () => {
  it("uses Windows quoting even when the POSIX version probe succeeds", async () => {
    const commands: string[] = [];
    const conn = {
      exec(command: string, callback: (error: null, stream: never) => void) {
        commands.push(command);
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);
        queueMicrotask(() => {
          stream.emit(
            "data",
            Buffer.from(
              commands.length === 1
                ? "tmux 3.3.8\npsmux 3.3.8 (Windows)\n"
                : "claude-work<<TMX>>1<<TMX>>2<<TMX>>1<<TMX>>1\n",
            ),
          );
          stream.emit("close", 0);
        });
      },
    } as unknown as Client;
    const result = await detectTmux(conn);
    expect(result.sessions[0].name).toBe("claude-work");
    expect(commands[1]).toBe(
      'tmux -u list-sessions -F "#{session_name}<<TMX>>#{session_created}<<TMX>>#{session_activity}<<TMX>>#{session_windows}<<TMX>>#{session_attached}"',
    );
  });
});

describe("session-scoped tmux mouse", () => {
  it.skipIf(process.platform === "win32")(
    "passes an exact session target and literal separator through both shells",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "termix-tmux-"));
      try {
        writeFileSync(join(dir, "tmux"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
          mode: 0o755,
        });
        let command = "";
        const stream = {
          write: (value: string) => {
            command = value;
          },
        };
        const name = "qa's $(echo injected)";
        attachOrCreateTmuxSession(
          stream as unknown as ClientChannel,
          name,
          undefined,
          false,
        );
        expect(command.endsWith("\r")).toBe(true);
        // Keep the test double ahead of Homebrew's real tmux as well.
        const testCommand = command.trim().replace("PATH=", `PATH=${dir}:`);
        const args = execFileSync("/bin/sh", ["-c", testCommand], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
        })
          .trim()
          .split("\n");
        expect(args).toEqual([
          "-u",
          "set-option",
          "-q",
          "-t",
          `=${name}:`,
          "mouse",
          "off",
          ";",
          "set-option",
          "-q",
          "-t",
          `=${name}:`,
          "history-limit",
          "50000",
          ";",
          "attach-session",
          "-t",
          `=${name}`,
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("creates the named session before configuring and attaching it", () => {
    let command = "";
    attachOrCreateTmuxSession(
      {
        write: (value: string) => {
          command = value;
        },
      } as unknown as ClientChannel,
      undefined,
      "work",
    );
    expect(command.indexOf("new-session")).toBeLessThan(
      command.indexOf("set-option"),
    );
    expect(command.indexOf("set-option")).toBeLessThan(
      command.indexOf("attach-session"),
    );
    expect(command).toContain("mouse on");
    expect(command).toContain("history-limit 50000");
    expect(command).not.toMatch(/set -g|set-hook|bind-key|set-clipboard/);
  });
});

describe("tmux on a host without /bin/sh", () => {
  function windowsClient(commands: string[]): Client {
    return {
      exec(command: string, callback: (error: null, stream: never) => void) {
        commands.push(command);
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);
        queueMicrotask(() => {
          if (command.startsWith("/bin/sh")) {
            stream.stderr.emit(
              "data",
              Buffer.from("'/bin/sh' is not recognized as a command"),
            );
            stream.emit("close", 1);
            return;
          }
          stream.emit(
            "data",
            Buffer.from(
              command.includes("list-sessions")
                ? "main<<TMX>>1<<TMX>>2<<TMX>>3<<TMX>>0\r\n"
                : "tmux 3.3.8\r\n",
            ),
          );
          stream.emit("close", 0);
        });
      },
    } as unknown as Client;
  }

  it("falls back to running tmux straight from cmd.exe or PowerShell", async () => {
    const commands: string[] = [];
    await expect(detectTmux(windowsClient(commands))).resolves.toEqual({
      available: true,
      sessions: [
        {
          name: "main",
          created: 1,
          lastActivity: 2,
          windows: 3,
          attachedClients: 0,
        },
      ],
    });
    expect(commands.slice(1)).toEqual([
      "tmux -u -V",
      'tmux -u list-sessions -F "#{session_name}<<TMX>>#{session_created}<<TMX>>#{session_activity}<<TMX>>#{session_windows}<<TMX>>#{session_attached}"',
    ]);
  });

  it("quotes with double quotes and separates commands with a quoted ;", () => {
    expect(
      buildTmuxCommand(
        "windows",
        ["select-window", "-t", "%3"],
        ["rename-session", "-t", "=a b", 'say "hi"'],
      ),
    ).toBe(
      'tmux -u select-window -t "%3" ";" rename-session -t "=a b" "say \\"hi\\""',
    );
  });

  it("attaches without && exit, which PowerShell 5 lacks", () => {
    let command = "";
    attachOrCreateTmuxSession(
      {
        write: (value: string) => (command = value),
      } as unknown as ClientChannel,
      "main",
      undefined,
      true,
      "windows",
    );
    expect(command).toBe(
      'tmux -u set-option -q -t =main: mouse on ";" set-option -q -t =main: history-limit 50000 ";" attach-session -t =main\r',
    );
  });
});

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("session options on a real tmux server", () => {
  it.skipIf(!hasTmux || process.platform === "win32")(
    "applies mouse and history-limit to the named session only",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "termix-tmux-"));
      const env = { ...process.env, TMUX_TMPDIR: dir, TMUX: "" };
      const tmux = (...args: string[]) =>
        execFileSync("tmux", ["-f", "/dev/null", ...args], {
          encoding: "utf8",
          env,
        }).trim();
      try {
        tmux("new-session", "-d", "-s", "work");
        tmux("new-session", "-d", "-s", "work2");
        const globalMouse = tmux("show-options", "-g", "-v", "mouse");
        for (const args of sessionOptionCommands("work", true)) tmux(...args);
        expect(tmux("show-options", "-t", "=work:", "-v", "mouse")).toBe("on");
        expect(
          tmux("show-options", "-t", "=work:", "-v", "history-limit"),
        ).toBe("50000");
        expect(tmux("show-options", "-t", "=work2:", "mouse")).toBe("");
        expect(tmux("show-options", "-g", "-v", "mouse")).toBe(globalMouse);
      } finally {
        try {
          tmux("kill-server");
        } catch {
          // server already gone
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
