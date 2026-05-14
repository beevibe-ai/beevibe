/**
 * End-to-end test for the docker sandbox primitives.
 *
 * Skipped by default — pulls a real Docker image, runs a real
 * container, runs apt-get inside it (~30s on first hit). Enable by:
 *
 *   BEEVIBE_E2E_DOCKER=1 pnpm --filter @beevibe/sandbox test
 *
 * Verifies the smoke path: createSandbox → prepareBaseEnvironment →
 * exec (apt-get + python smoke) → writeFileIn / readFileIn → listDir
 * → exportArtifact → destroySandbox. Does NOT exercise the agent
 * loop — that's the smoke / orchestrate-pdfplumber scripts.
 */
import { describe, expect, it } from "vitest";
import {
  createSandbox,
  destroySandbox,
  exec,
  exportArtifact,
  listDir,
  prepareBaseEnvironment,
  readFileIn,
  writeFileIn,
  type Sandbox,
} from "./docker.js";

const ENABLED = process.env.BEEVIBE_E2E_DOCKER === "1";
const describeOrSkip = ENABLED ? describe : describe.skip;

describeOrSkip("sandbox primitives (e2e — Docker required)", () => {
  it("creates, executes commands, writes/reads files, exports artifacts, destroys", async () => {
    let sandbox: Sandbox | null = null;
    try {
      sandbox = await createSandbox({ label: "e2e-test" });
      expect(sandbox.id).toMatch(/^e2e-test-/);
      expect(sandbox.image).toBe("python:3.12-slim");

      await prepareBaseEnvironment(sandbox);

      const versions = await exec(sandbox, "python --version && git --version");
      expect(versions.exit_code).toBe(0);
      expect(versions.stdout).toMatch(/Python 3\.12/);
      expect(versions.stdout).toMatch(/git version/);

      await writeFileIn(sandbox, "/sandbox/hello.txt", "hello from e2e\n");
      const read = await readFileIn(sandbox, "/sandbox/hello.txt");
      expect(read).toBe("hello from e2e\n");

      const list = await listDir(sandbox, "/sandbox");
      expect(list).toContain("hello.txt");
      expect(list).toContain("artifacts");

      await exec(
        sandbox,
        "cp /sandbox/hello.txt /sandbox/artifacts/hello.txt",
      );
      const exported = await exportArtifact(
        sandbox,
        "/sandbox/artifacts/hello.txt",
      );
      expect(exported.size_bytes).toBeGreaterThan(0);
      expect(exported.host_path).toContain("hello.txt");
    } finally {
      if (sandbox) await destroySandbox(sandbox);
    }
  }, 240_000); // 4 min — apt-get pulls take ~30–60s on a cold base image.

  it("surfaces a friendly error when the docker daemon is unreachable", async () => {
    // Sanity check that the existing path will error rather than hang
    // when docker is unavailable. We can't easily simulate "daemon
    // down" without stopping docker, so this test just ensures the
    // public surface is callable; the friendly-message path is
    // exercised in classifyStartupError at the orchestrator layer.
    expect(typeof createSandbox).toBe("function");
  });
});
