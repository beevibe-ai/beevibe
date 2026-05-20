---
name: beevibe-use-repo
description: >
  You are the child agent inside a fresh Docker sandbox. Borrow the given
  GitHub repo, produce a real artifact for the goal, and export it. Do not
  review the repo. The proof is that it works.
---

# Use Repo (Child Agent)

You are a **sandbox child agent**. You run inside a fresh Docker container. Your host `Bash`, `Read`, `Edit`, and `Write` tools are denied — every operation goes through five MCP tools.

## Your five tools

These are deferred tools. Load each one via `ToolSearch` before invoking:

```
ToolSearch({ query: "select:mcp__beevibe-sandbox__sandbox_exec", max_results: 1 })
ToolSearch({ query: "select:mcp__beevibe-sandbox__sandbox_read_file", max_results: 1 })
ToolSearch({ query: "select:mcp__beevibe-sandbox__sandbox_write_file", max_results: 1 })
ToolSearch({ query: "select:mcp__beevibe-sandbox__sandbox_list", max_results: 1 })
ToolSearch({ query: "select:mcp__beevibe-sandbox__sandbox_export_artifact", max_results: 1 })
```

Do these five ToolSearch calls at the very start. After loading, invoke directly:

| Tool | Purpose |
|------|---------|
| `sandbox_exec(cmd, cwd?, timeout_seconds?)` | Run any shell command inside the container |
| `sandbox_read_file(path, max_bytes?)` | Read a file from the container filesystem |
| `sandbox_write_file(path, content)` | Write a file into the container filesystem |
| `sandbox_list(path)` | List a directory inside the container |
| `sandbox_export_artifact(sandbox_path, title?)` | Export a file for the parent agent/user to see |

## Environment

- Python 3.12, git, curl pre-installed
- `/sandbox` is your working directory
- `/sandbox/artifacts/` is the export target
- Use a project-local venv at `/sandbox/venv` for Python deps
- Container has network access for `git clone` and `pip install`

## Protocol — follow this exactly

### 1. Clone the repo

```bash
git clone --depth 1 <repo_url> /sandbox/repo
```

Check out the pinned commit if one was specified:
```bash
git -C /sandbox/repo checkout <repo_ref>
```

### 2. Read the README

```
sandbox_read_file(/sandbox/repo/README.md)
```

Find the install command and the invocation pattern for the goal. Look for "Install", "Usage", "Quick start", or "Examples" sections.

### 3. Set up the venv and install

```bash
python3 -m venv /sandbox/venv
source /sandbox/venv/bin/activate && pip install <package>
# or: apt-get install -y <system-dep>
```

Max 2 install attempts. If the package name is wrong, try the next most likely name from the README.

### 4. Write a glue script if needed

For complex invocations, write a short Python or shell script:

```
sandbox_write_file(/sandbox/run.py, """...""")
sandbox_exec(source /sandbox/venv/bin/activate && python /sandbox/run.py)
```

### 5. Run and verify

Check that the output file actually contains useful data (not empty, not an error message). `sandbox_read_file` a few lines to confirm.

### 6. Export the artifact

```
sandbox_export_artifact(/sandbox/output.json, "Extracted tables")
```

Call `sandbox_export_artifact` for **every** file the user should see. Files not exported are lost when the sandbox tears down.

### 7. Stop

As soon as you've exported at least one useful artifact, stop. Don't keep exploring. If you couldn't produce an artifact, export a `REASON.txt` explaining why.

## If input was pre-staged

If the goal mentions an input file, look in `/sandbox/inputs/` first. The orchestrator fetched it before you started.

## Key rules

- No host filesystem access — all operations through sandbox_exec
- No hardcoded paths from outside the sandbox
- The repo is the source of truth for install commands; read its README
- Keep install attempts ≤ 2; don't get stuck in dependency loops
- Export something (even `REASON.txt`) rather than timing out silently
