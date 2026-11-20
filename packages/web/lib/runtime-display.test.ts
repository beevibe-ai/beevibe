import { describe, expect, it } from "vitest";
import type { RuntimesListResponse } from "@/lib/api/client";
import {
  flattenRuntimes,
  groupRuntimesByDaemon,
  shortRuntimeLabel,
} from "./runtime-display";

function response(
  daemons: RuntimesListResponse["daemons"],
): RuntimesListResponse {
  return { ok: true, daemons };
}

function daemon(
  over: Partial<RuntimesListResponse["daemons"][number]> = {},
): RuntimesListResponse["daemons"][number] {
  return {
    id: "d_1",
    device_name: "Air",
    external_id: "ext_1",
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    runtimes: [],
    ...over,
  };
}

function runtime(
  over: Partial<RuntimesListResponse["daemons"][number]["runtimes"][number]> = {},
) {
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

describe("groupRuntimesByDaemon", () => {
  it("returns an empty list for an absent response rather than throwing", () => {
    // Both call sites hand it `query.data` straight from react-query, which
    // is undefined on the first render.
    expect(groupRuntimesByDaemon(undefined)).toEqual([]);
  });

  it("folds the device label onto every runtime under the daemon", () => {
    const groups = groupRuntimesByDaemon(
      response([daemon({ runtimes: [runtime({ id: "a" }), runtime({ id: "b" })] })]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.device).toBe("Air");
    expect(groups[0]?.runtimes.map((r) => r.device)).toEqual(["Air", "Air"]);
  });

  it("falls back to external_id when the daemon has no device name", () => {
    const groups = groupRuntimesByDaemon(
      response([
        daemon({ device_name: undefined, external_id: "ext_9", runtimes: [runtime()] }),
      ]),
    );
    expect(groups[0]?.device).toBe("ext_9");
    expect(groups[0]?.runtimes[0]?.device).toBe("ext_9");
  });

  it("carries a null cli_version through rather than coercing it", () => {
    // The server sends null for a runtime that never reported a version.
    // All three hand-written copies of this projection typed the field
    // `string | undefined`, so this pins the wire shape.
    const groups = groupRuntimesByDaemon(
      response([daemon({ runtimes: [runtime({ cli_version: null })] })]),
    );
    expect(groups[0]?.runtimes[0]?.cli_version).toBeNull();
  });
});

describe("flattenRuntimes", () => {
  it("concatenates across daemons in server order", () => {
    const flat = flattenRuntimes(
      response([
        daemon({ id: "d_1", device_name: "Air", runtimes: [runtime({ id: "a" })] }),
        daemon({ id: "d_2", device_name: "Studio", runtimes: [runtime({ id: "b" })] }),
      ]),
    );
    expect(flat.map((r) => [r.id, r.device])).toEqual([
      ["a", "Air"],
      ["b", "Studio"],
    ]);
  });

  it("is empty for a daemon with no runtimes", () => {
    expect(flattenRuntimes(response([daemon()]))).toEqual([]);
  });
});

describe("shortRuntimeLabel", () => {
  it("appends the version when there is one", () => {
    expect(
      shortRuntimeLabel({
        id: "rt",
        cli: "claude",
        cli_version: "1.2.3",
        online: true,
        device: "Air",
      }),
    ).toBe("claude 1.2.3");
  });

  it("drops the version entirely when it is null", () => {
    expect(
      shortRuntimeLabel({
        id: "rt",
        cli: "codex",
        cli_version: null,
        online: false,
        device: "Air",
      }),
    ).toBe("codex");
  });
});
