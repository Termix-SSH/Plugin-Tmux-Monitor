import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { startServer, type TestServer } from "./helpers";

function fakeSshClient(outputs: Record<string, string>, exitCode = 0) {
  const client = new EventEmitter() as EventEmitter & {
    exec: (
      command: string,
      cb: (err: Error | null, stream: unknown) => void,
    ) => void;
  };
  client.exec = (command, cb) => {
    const stream = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
    };
    stream.stderr = new EventEmitter();
    const matchKey = Object.keys(outputs).find((k) => command.includes(k));
    const output = matchKey ? outputs[matchKey] : "";
    cb(null, stream);
    setImmediate(() => {
      if (output) stream.emit("data", Buffer.from(output));
      stream.emit("close", exitCode);
    });
  };
  return client;
}

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("GET /:hostId/overview", () => {
  it("403s when the host does not exist or is not reachable", async () => {
    server = await startServer({ hosts: [] });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(403);
  });

  it("403s when the monitor is disabled for the host", async () => {
    server = await startServer({ enabledHosts: [] });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it("403s without the tmux-monitor.use permission", async () => {
    server = await startServer({ permissions: [] });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(403);
  });

  it("reports tmux unavailable when the exec exits non-zero", async () => {
    server = await startServer({ sshClient: fakeSshClient({}, 127) });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, sessions: [] });
  });
});

describe("PUT /:hostId/tags", () => {
  it("saves tags for the acting user and session", async () => {
    server = await startServer();
    const res = await server.request("PUT", "/7/tags", {
      body: { sessionName: "work", tags: ["a", "b", "b", "  "] },
    });
    expect(res.status).toBe(200);
    expect(res.body.tags.sort()).toEqual(["a", "b"]);
  });

  it("rejects a non-array tags field", async () => {
    server = await startServer();
    const res = await server.request("PUT", "/7/tags", {
      body: { sessionName: "work", tags: "nope" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /:hostId/sessions", () => {
  it("rejects an invalid session name", async () => {
    server = await startServer();
    const res = await server.request("POST", "/7/sessions", {
      body: { name: "bad:name" },
    });
    expect(res.status).toBe(400);
  });
});

function recordingClient(
  respond: (command: string) => { out?: string; code?: number },
) {
  const commands: string[] = [];
  const client = new EventEmitter() as EventEmitter & {
    exec: (
      command: string,
      cb: (err: Error | null, stream: unknown) => void,
    ) => void;
  };
  client.exec = (command, cb) => {
    commands.push(command);
    const stream = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
    };
    stream.stderr = new EventEmitter();
    const { out = "", code = 0 } = respond(command);
    cb(null, stream);
    setImmediate(() => {
      if (out) stream.emit("data", Buffer.from(out));
      stream.emit("close", code);
    });
  };
  return { client, commands };
}

describe("view sessions", () => {
  const view = (body: unknown) =>
    ["POST", "/7/view-session", { body }] as const;

  it("rejects bad input and the reserved name prefix", async () => {
    server = await startServer({
      sshClient: recordingClient(() => ({})).client,
    });
    for (const body of [
      { sessionName: "termix-view-abcd1234", windowIndex: 0 },
      { sessionName: "a:b", windowIndex: 0 },
      { sessionName: "work", windowIndex: -1 },
      { sessionName: "work", windowIndex: 1.5 },
      { sessionName: "work", windowIndex: 0, paneId: "%1; rm -rf /" },
    ]) {
      const res = await server.request(...view(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("404s, creating nothing, when the pane is not in that window", async () => {
    const { client, commands } = recordingClient((c) =>
      c.includes("list-panes") ? { out: "%1\n%2\n" } : {},
    );
    server = await startServer({ sshClient: client });
    const res = await server.request(
      ...view({ sessionName: "work", windowIndex: 0, paneId: "%9" }),
    );
    expect(res.status).toBe(404);
    expect(commands.some((c) => c.includes("new-session"))).toBe(false);
  });

  it("creates one marked, randomly named grouped session in a single tmux call", async () => {
    const { client, commands } = recordingClient((c) =>
      c.includes("list-panes") ? { out: "%1\n%2\n" } : {},
    );
    server = await startServer({ sshClient: client });
    const res = await server.request(
      ...view({ sessionName: "work", windowIndex: 2, paneId: "%2" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.name).toMatch(/^termix-view-[0-9a-f]{8}$/);
    const create = commands.filter((c) => c.includes("new-session"));
    expect(create).toHaveLength(1);
    expect(create[0]).toContain("@termix_view");
    expect(create[0]).toMatch(/select-pane -t \S+%2\S+/);
  });

  it("removes a half-created session when creation fails", async () => {
    const { client, commands } = recordingClient((c) =>
      c.includes("new-session")
        ? { code: 1 }
        : c.includes("list-panes")
          ? { out: "%1\n" }
          : {},
    );
    server = await startServer({ sshClient: client });
    const res = await server.request(
      ...view({ sessionName: "work", windowIndex: 0 }),
    );
    expect(res.status).toBe(500);
    expect(commands.some((c) => c.includes("kill-session"))).toBe(true);
  });

  it("release only reaps a marked, unattached session, decided by tmux", async () => {
    const { client, commands } = recordingClient(() => ({}));
    server = await startServer({ sshClient: client });
    expect(
      (
        await server.request("POST", "/7/view-session/release", {
          body: { name: "termix-view-work" },
        })
      ).status,
    ).toBe(400);
    const ok = await server.request("POST", "/7/view-session/release", {
      body: { name: "termix-view-abcd1234" },
    });
    expect(ok.status).toBe(200);
    const reap = commands.find((c) => c.includes("kill-session"))!;
    expect(reap).toContain("if-shell");
    expect(reap).toContain("@termix_view");
    expect(reap).toContain("session_attached");
  });

  it("does not let ordinary create or rename use the reserved prefix", async () => {
    server = await startServer({
      sshClient: recordingClient(() => ({})).client,
    });
    expect(
      (
        await server.request("POST", "/7/sessions", {
          body: { name: "termix-view-work" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await server.request("POST", "/7/rename", {
          body: { sessionName: "a", newName: "termix-view-x" },
        })
      ).status,
    ).toBe(400);
  });

  it("hides marked view sessions from the overview and reaps stale ones, never by name", async () => {
    const SEP = "<<TMX>>";
    const old = Math.floor(Date.now() / 1000) - 3600;
    const { client, commands } = recordingClient((c) => {
      if (c.includes("list-sessions"))
        return {
          out: [
            ["work", old, old, 0, ""],
            ["termix-view-abcd1234", old, old, 0, "1"],
            ["termix-view-mine", old, old, 0, ""],
          ]
            .map((r) => r.join(SEP))
            .join("\n"),
        };
      return {};
    });
    server = await startServer({ sshClient: client });
    const res = await server.request("GET", "/7/overview");
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: { name: string }) => s.name)).toEqual([
      "work",
      "termix-view-mine",
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const kills = commands.filter((c) => c.includes("kill-session"));
    expect(kills).toHaveLength(1);
    expect(kills[0]).toContain("termix-view-abcd1234");
    expect(kills[0]).not.toContain("termix-view-mine");
  });

  it("kills a session's marked helpers even when its group has another name", async () => {
    const SEP = "<<TMX>>";
    const { client, commands } = recordingClient((c) => {
      if (c.includes("list-sessions"))
        return {
          out: [
            ["work", "shared", ""],
            ["termix-view-abcd1234", "shared", "1"],
            ["termix-view-beef0000", "other", "1"],
            ["termix-view-mine", "shared", ""],
          ]
            .map((r) => r.join(SEP))
            .join("\n"),
        };
      return {};
    });
    server = await startServer({ sshClient: client });
    const res = await server.request("POST", "/7/kill", {
      body: { sessionName: "work" },
    });
    expect(res.status).toBe(200);
    const kills = commands.filter((c) => c.includes("kill-session"));
    expect(kills).toHaveLength(2);
    expect(kills[0]).toContain("termix-view-abcd1234");
    expect(kills[1]).toContain("=work");
    expect(kills.join()).not.toMatch(/beef0000|view-mine/);
  });
});
