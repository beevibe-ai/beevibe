#!/usr/bin/env node
/**
 * End-to-end sandbox smoke test (no agent, just the primitives).
 *
 * Proves: docker is reachable, a container spawns, git clone works,
 * pip install works, pdfplumber extracts tables from a real PDF, and
 * the artifact comes back to the host.
 *
 * Run: pnpm --filter @beevibe/sandbox smoke
 */
import {
  createSandbox,
  destroySandbox,
  exec,
  exportArtifact,
  listDir,
  prepareBaseEnvironment,
  readFileIn,
  writeFileIn,
} from "../docker.js";

async function main(): Promise<void> {
  let sandbox = null as Awaited<ReturnType<typeof createSandbox>> | null;
  try {
    log("creating sandbox…");
    sandbox = await createSandbox({ label: "smoke-pdfplumber" });
    log(`sandbox ${sandbox.id} created (image ${sandbox.image})`);
    log(`artifact dir: ${sandbox.artifact_dir}`);

    log("installing git + curl + ca-certificates inside sandbox…");
    await prepareBaseEnvironment(sandbox);
    log("base prep done");

    log("verifying tool availability…");
    const versions = await exec(sandbox, "python --version && git --version && pip --version");
    log(versions.stdout.trim());
    if (versions.exit_code !== 0) throw new Error("base tools missing");

    log("cloning pdfplumber…");
    const clone = await exec(
      sandbox,
      "git clone --depth 1 https://github.com/jsvine/pdfplumber.git /sandbox/repo",
    );
    if (clone.exit_code !== 0) throw new Error(`clone failed: ${clone.stderr}`);
    log("clone done");

    log("creating venv and installing pdfplumber…");
    const install = await exec(
      sandbox,
      "python -m venv /sandbox/venv && . /sandbox/venv/bin/activate && pip install --quiet -e /sandbox/repo",
      { timeout_seconds: 300 },
    );
    if (install.exit_code !== 0) {
      throw new Error(
        `install failed (exit ${install.exit_code}): ${install.stderr.slice(-1000)}`,
      );
    }
    log("install done");

    log("listing bundled sample PDFs…");
    const pdfs = await exec(
      sandbox,
      "ls /sandbox/repo/tests/pdfs | grep -E 'example|table|federal' | head -5",
    );
    log(pdfs.stdout.trim());

    log("writing extraction glue script (agent would do this)…");
    await writeFileIn(
      sandbox,
      "/sandbox/extract.py",
      [
        "import json, sys",
        "import pdfplumber",
        "path = sys.argv[1]",
        "out = sys.argv[2]",
        "with pdfplumber.open(path) as pdf:",
        "    tables = []",
        "    for i, page in enumerate(pdf.pages):",
        "        for t in page.extract_tables():",
        "            tables.append({'page': i + 1, 'rows': t})",
        "with open(out, 'w') as f:",
        "    json.dump({'tables': tables, 'page_count': len(pdf.pages)}, f, indent=2)",
        "print(f'wrote {out} with {len(tables)} table(s)')",
      ].join("\n"),
    );

    log("running extraction…");
    const run = await exec(
      sandbox,
      ". /sandbox/venv/bin/activate && python /sandbox/extract.py /sandbox/repo/tests/pdfs/federal-register-2020-17221.pdf /sandbox/artifacts/result.json",
    );
    log(run.stdout.trim());
    if (run.exit_code !== 0) {
      throw new Error(`extract failed (exit ${run.exit_code}): ${run.stderr}`);
    }

    log("artifact list inside sandbox:");
    const arts = await listDir(sandbox, "/sandbox/artifacts");
    for (const a of arts) log(`  ${a}`);

    log("reading first 200 chars of result.json from inside sandbox:");
    const preview = await readFileIn(sandbox, "/sandbox/artifacts/result.json");
    log(preview.slice(0, 200) + (preview.length > 200 ? "…" : ""));

    log("exporting result.json to host…");
    const exported = await exportArtifact(sandbox, "/sandbox/artifacts/result.json");
    log(`exported ${exported.size_bytes} bytes to ${exported.host_path}`);

    log("smoke OK ✓");
  } finally {
    if (sandbox) {
      log(`destroying sandbox ${sandbox.id}…`);
      await destroySandbox(sandbox);
      log("destroyed");
    }
  }
}

function log(msg: string): void {
  process.stdout.write(`[smoke] ${msg}\n`);
}

main().catch((err) => {
  process.stderr.write(`[smoke] FAILED: ${err.message ?? err}\n`);
  process.exit(1);
});
