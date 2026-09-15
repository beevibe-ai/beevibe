import { describe, expect, it } from "vitest";
import type { DaemonPanelEntry, RuntimesListResponse } from "@/lib/api/client";
import {
  flattenRuntimes,
  groupRuntimesByDaemon,
  listRuntimeOptions,
  shortRuntimeLabel,
} from "./runtime-options";

function daemon(over: Partial<DaemonPanelEntry> = {}): DaemonPanelEntry {
  return {
    id: "dmn_1",
    device_name: "workbench",
    external_id: "ext_1",
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    runtimes: [],
    ...over,
  };
}

function runtime(over: Partial<DaemonPanelEntry["runtimes"][number]> = {}) {
  return {
    id: "rt_1",
    cli: "claude",
    cli_version: "1.2.3",
    last_heartbeat: null,
    online: true,
    capabilities: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function response(daemons: DaemonPanelEntry[]): RuntimesListResponse {
  return { ok: true, daemons };
}

describe("groupRuntimesByDaemon", () => {
  it("stamps the device label onto every runtime under a daemon", () => {
    const groups = groupRuntimesByDaemon(
      response([daemon({ runtimes: [runtime({ id: "rt_1" }), runtime({ id: "rt_2" })] })]),
    );

    expect(groups).toEqual([
      {
        device: "workbench",
        runtimes: [
          { id: "rt_1", cli: "claude", cli_version: "1.2.3", online: true, device: "workbench" },
          { id: "rt_2", cli: "claude", cli_version: "1.2.3", online: true, device: "workbench" },
        ],
      },
    ]);
  });

  // `device_name` is NOT NULL in the schema and non-optional in the
  // contract, so this can only come from a server that predates either.
  // Both hand-written copies carried the fallback and it's kept: a blank
  // row in the picker is a worse failure than showing an external id.
  // Hence the cast — the type says this state can't arrive.
  it("falls back to the external id when the daemon has no device name", () => {
    const groups = groupRuntimesByDaemon(
      response([daemon({ device_name: null as unknown as string, runtimes: [runtime()] })]),
    );

    expect(groups[0]!.device).toBe("ext_1");
    expect(groups[0]!.runtimes[0]!.device).toBe("ext_1");
  });

  it("returns nothing while the query is still in flight", () => {
    expect(groupRuntimesByDaemon(undefined)).toEqual([]);
  });

  it("keeps a daemon that has registered no runtimes", () => {
    expect(groupRuntimesByDaemon(response([daemon()]))).toEqual([
      { device: "workbench", runtimes: [] },
    ]);
  });
});

describe("listRuntimeOptions", () => {
  it("flattens across daemons, keeping each runtime's own device", () => {
    const options = listRuntimeOptions(
      response([
        daemon({ id: "dmn_1", device_name: "laptop", runtimes: [runtime({ id: "rt_1" })] }),
        daemon({
          id: "dmn_2",
          device_name: "desktop",
          external_id: "ext_2",
          runtimes: [runtime({ id: "rt_2" })],
        }),
      ]),
    );

    expect(options.map((r) => [r.id, r.device])).toEqual([
      ["rt_1", "laptop"],
      ["rt_2", "desktop"],
    ]);
  });

  it("agrees with grouping then flattening", () => {
    const data = response([daemon({ runtimes: [runtime()] })]);
    expect(listRuntimeOptions(data)).toEqual(flattenRuntimes(groupRuntimesByDaemon(data)));
  });
});

describe("shortRuntimeLabel", () => {
  it("appends the version when the daemon reported one", () => {
    expect(shortRuntimeLabel({ id: "rt_1", cli: "claude", cli_version: "1.2.3", online: true, device: "d" })).toBe(
      "claude 1.2.3",
    );
  });

  // The route sends `null`, not `undefined`, for a runtime that has never
  // reported a version. Both picker copies of this label typed the field as
  // optional, so this is the case their types said couldn't happen.
  it("omits a null version rather than printing it", () => {
    expect(
      shortRuntimeLabel({ id: "rt_1", cli: "codex", cli_version: null, online: false, device: "d" }),
    ).toBe("codex");
  });
});
