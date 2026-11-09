import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createSummaryCache } from "../../src/backend/summary.js";

describe("tmux summary", () => {
  it("keeps a host error as a result and caches it", async () => {
    const get = vi.fn(async () => null);
    const ctx = {
      currentActor: () => "1",
      hosts: { get },
    } as unknown as PluginContext;
    const cache = createSummaryCache(ctx);
    const first = await cache.check(1);
    expect(first.error).toBe("Host not found");
    expect(first.sessions).toBe(0);
    await cache.check(1);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
