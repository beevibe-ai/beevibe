/**
 * The package's public surface.
 *
 * `index.ts` is what other packages import from `@beevibe/sandbox`, so
 * dropping an export here is a breaking change that no other test would
 * notice — the barrel is re-exports only, and dead-code tools routinely
 * flag such exports as unused.
 */
import { describe, expect, it } from "vitest";
import * as sandbox from "./index.js";

describe("@beevibe/sandbox public surface", () => {
  it("exports exactly the documented primitives", () => {
    // Types are erased at runtime, so this covers the value exports only.
    expect(Object.keys(sandbox).sort()).toEqual([
      "ALLOWED_CLONE_HOSTS",
      "DEFAULT_IMAGE",
      "SandboxError",
      "cleanupArtifactDir",
      "createSandbox",
      "destroySandbox",
      "ensureArtifactDir",
      "exec",
      "exportArtifact",
      "listDir",
      "prepareBaseEnvironment",
      "readFileIn",
      "writeFileIn",
    ]);
  });

  it("exposes the sandbox lifecycle as callable functions", () => {
    expect(typeof sandbox.createSandbox).toBe("function");
    expect(typeof sandbox.prepareBaseEnvironment).toBe("function");
    expect(typeof sandbox.exec).toBe("function");
    expect(typeof sandbox.destroySandbox).toBe("function");
  });

  it("exports SandboxError as a real Error subclass", () => {
    const err = new sandbox.SandboxError("boom");
    // Callers catch on `instanceof`, so the prototype chain matters.
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SandboxError");
    expect(err.message).toBe("boom");
  });
});
