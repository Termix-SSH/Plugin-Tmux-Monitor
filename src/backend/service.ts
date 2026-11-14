import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  attachOrCreateTmuxSession,
  bindPersistentSelection,
  detectTmux,
  tmuxShellForStream,
  waitForTmuxSession,
  type TmuxDetectionResult,
} from "./tmux-commands.js";

export type TmuxDetection = TmuxDetectionResult;

/**
 * What the terminal (ssh-terminal's optional "tmux.sessions" consumer) asks
 * of this plugin. Clients and streams cross the service boundary as
 * `unknown`, since the SDK types services without an ssh2 dependency.
 */
export interface TmuxSessionsV1 {
  detect: (client: unknown) => Promise<TmuxDetection>;
  attachOrCreate: (
    stream: unknown,
    name?: string,
    newName?: string,
    hostId?: number,
  ) => Promise<void>;
  waitForSession: (client: unknown, name: string) => Promise<string>;
}

/**
 * What SSH Terminal sends when it runs in its own process: an ssh2 client
 * or channel can't cross, so it gives plain functions. The key is the same
 * for one connection.
 */
export interface TmuxShellHandle {
  termixShellKey: string;
  exec: (
    command: string,
  ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  write: (data: string) => void;
}

export function isShellHandle(value: unknown): value is TmuxShellHandle {
  const handle = value as Partial<TmuxShellHandle> | null;
  return (
    !!handle &&
    typeof handle.termixShellKey === "string" &&
    typeof handle.exec === "function" &&
    typeof handle.write === "function"
  );
}

const MAX_ADAPTERS = 200;
const adapters = new Map<string, { client: Client; handle: TmuxShellHandle }>();

/**
 * An ssh2 client stand-in over a handle, one per key so the detected shell
 * is remembered for the connection. Its exec answers like a channel that
 * gave all its output at once.
 */
export function clientFor(value: unknown): Client {
  if (!isShellHandle(value)) return value as Client;
  const known = adapters.get(value.termixShellKey);
  if (known) {
    known.handle = value;
    return known.client;
  }
  const entry = { client: null as unknown as Client, handle: value };
  entry.client = {
    exec: (command: string, cb: (err?: Error, channel?: unknown) => void) => {
      entry.handle.exec(command).then(
        (result) => {
          const channel = new EventEmitter() as EventEmitter & {
            stderr: EventEmitter;
          };
          channel.stderr = new EventEmitter();
          cb(undefined, channel);
          setImmediate(() => {
            if (result.stdout) channel.emit("data", Buffer.from(result.stdout));
            if (result.stderr) {
              channel.stderr.emit("data", Buffer.from(result.stderr));
            }
            channel.emit("exit", result.code);
            channel.emit("close", result.code);
          });
        },
        (error: unknown) =>
          cb(error instanceof Error ? error : new Error(String(error))),
      );
      return true;
    },
  } as unknown as Client;
  adapters.set(value.termixShellKey, entry);
  if (adapters.size > MAX_ADAPTERS) {
    adapters.delete(adapters.keys().next().value as string);
  }
  return entry.client;
}

/** A shell channel stand-in: writes go to the handle, the shell is known. */
export function channelFor(value: unknown): ClientChannel {
  if (!isShellHandle(value)) return value as ClientChannel;
  return {
    write: (data: string) => value.write(data),
    _client: clientFor(value),
  } as unknown as ClientChannel;
}

export function createTmuxSessionsService(ctx: PluginContext): TmuxSessionsV1 {
  return {
    detect(client) {
      return detectTmux(clientFor(client));
    },

    async attachOrCreate(stream, name, newName, hostId) {
      const mouseEnabled =
        hostId === undefined ||
        (await ctx.settings.getHost<boolean>(hostId, "mouseEnabled")) !== false;
      const channel = channelFor(stream);
      const session = attachOrCreateTmuxSession(
        channel,
        name,
        newName,
        mouseEnabled,
      );
      const client = (channel as unknown as { _client?: Client })._client;
      if (mouseEnabled && client && tmuxShellForStream(channel) === "posix") {
        void bindPersistentSelection(client, session).catch((error) =>
          ctx.log.warn(
            `Could not keep tmux mouse selections: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    },

    async waitForSession(client, name) {
      const confirmed = await waitForTmuxSession(clientFor(client), name);
      if (!confirmed) {
        ctx.log.warn(
          `Timed out waiting for a new tmux session to appear: ${name}`,
        );
        return name;
      }
      return confirmed;
    },
  };
}
