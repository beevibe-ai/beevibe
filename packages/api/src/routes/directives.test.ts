import { describe, expect, it } from "vitest";
import { processResponse } from "./directives.js";

describe("processResponse — view_refs", () => {
  it("collects entity ids inline in the visible text", () => {
    const r = processResponse("see task_abc123def456 and agent_xyz123abc456");
    expect(r.view_refs).toEqual(["task_abc123def456", "agent_xyz123abc456"]);
  });

  it("dedupes repeated ids", () => {
    const r = processResponse("task_abc123def456 again task_abc123def456");
    expect(r.view_refs).toEqual(["task_abc123def456"]);
  });

  it("does not match malformed ids (wrong length, wrong prefix)", () => {
    const r = processResponse("task_short agent_TOOLONGTOOLONG12 unknown_abc123def456");
    expect(r.view_refs).toEqual([]);
  });
});

describe("processResponse — open_view path allow-list", () => {
  it("accepts an allow-listed path", () => {
    const r = processResponse(`<open_view path="/tasks/task_abc123def456" />`);
    expect(r.open_view).toEqual({ path: "/tasks/task_abc123def456" });
  });

  it("accepts a bare allow-listed path with an exact match", () => {
    const r = processResponse(`<open_view path="/mesh" />`);
    expect(r.open_view).toEqual({ path: "/mesh" });
  });

  it("captures an optional label attribute", () => {
    const r = processResponse(`<open_view path="/agents" label="See team" />`);
    expect(r.open_view).toEqual({ path: "/agents", label: "See team" });
  });

  it("rejects an off-list path", () => {
    const r = processResponse(`<open_view path="/admin/users" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("rejects an external URL", () => {
    const r = processResponse(`<open_view path="https://attacker.example/x" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("rejects a protocol-relative URL", () => {
    const r = processResponse(`<open_view path="//attacker.example/x" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("rejects a path with traversal", () => {
    const r = processResponse(`<open_view path="/tasks/../../etc/passwd" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("rejects when the path looks like a prefix-collision (e.g. /tasksomething)", () => {
    // /tasks must match exactly OR be followed by '/'. /taskstats is
    // not a known surface and shouldn't be accepted by a sloppy
    // startsWith check.
    const r = processResponse(`<open_view path="/taskstats" />`);
    expect(r.open_view).toBeUndefined();
  });

  it("strips the directive from visible text even when path is rejected", () => {
    const r = processResponse(
      `Some context text.\n<open_view path="/admin/users" />`,
    );
    expect(r.open_view).toBeUndefined();
    expect(r.visible).toBe("Some context text.");
  });
});

describe("processResponse — suggest_action chips", () => {
  it("parses self-closing label-only form", () => {
    const r = processResponse(`<suggest_action label="Approve" />`);
    expect(r.suggested_actions).toEqual([{ label: "Approve" }]);
  });

  it("parses self-closing label+prompt form", () => {
    const r = processResponse(
      `<suggest_action label="Approve" prompt="Approve as-is and ship it." />`,
    );
    expect(r.suggested_actions).toEqual([
      { label: "Approve", prompt: "Approve as-is and ship it." },
    ]);
  });

  it("parses paired-tag inline-text form", () => {
    const r = processResponse(`<suggest_action>Reject</suggest_action>`);
    expect(r.suggested_actions).toEqual([{ label: "Reject" }]);
  });

  it("parses paired-tag with label attribute (label visible, inline text becomes prompt)", () => {
    const r = processResponse(
      `<suggest_action label="Revise">Please tighten the intro.</suggest_action>`,
    );
    expect(r.suggested_actions).toEqual([
      { label: "Revise", prompt: "Please tighten the intro." },
    ]);
  });

  it("collects multiple chips", () => {
    const r = processResponse(
      `<suggest_action label="Approve" />\n<suggest_action label="Reject" />`,
    );
    expect(r.suggested_actions).toEqual([{ label: "Approve" }, { label: "Reject" }]);
  });

  it("dedupes chips with the same label", () => {
    const r = processResponse(
      `<suggest_action label="Approve" /><suggest_action label="Approve" />`,
    );
    expect(r.suggested_actions).toEqual([{ label: "Approve" }]);
  });

  it("ignores empty-label suggest_action tags", () => {
    const r = processResponse(`<suggest_action />`);
    expect(r.suggested_actions).toBeUndefined();
  });
});

describe("processResponse — visible text stripping", () => {
  it("strips both directive types from visible text", () => {
    const r = processResponse(
      `Here's the plan.\n<open_view path="/tasks" />\n<suggest_action label="OK" />`,
    );
    expect(r.visible).toBe("Here's the plan.");
  });

  it("returns the trimmed raw text when there are no directives", () => {
    const r = processResponse("  just a normal reply.  ");
    expect(r.visible).toBe("just a normal reply.");
  });
});

describe("processResponse — repo_card", () => {
  it("parses self-closing tag with all attributes", () => {
    const r = processResponse(
      `<repo_card repo_url="https://github.com/karpathy/nanoGPT" stars="42500" language="Python" source="trending" description="The simplest, fastest repository for training GPTs." />`,
    );
    expect(r.repo_cards).toEqual([
      {
        repo_url: "https://github.com/karpathy/nanoGPT",
        owner: "karpathy",
        name: "nanoGPT",
        stars: 42500,
        language: "Python",
        source: "trending",
        description: "The simplest, fastest repository for training GPTs.",
      },
    ]);
  });

  it("supports inline body as description", () => {
    const r = processResponse(
      `<repo_card repo_url="https://github.com/foo/bar">An inline description.</repo_card>`,
    );
    expect(r.repo_cards).toEqual([
      {
        repo_url: "https://github.com/foo/bar",
        owner: "foo",
        name: "bar",
        description: "An inline description.",
      },
    ]);
  });

  it("strips comma-separated star count to integer", () => {
    const r = processResponse(
      `<repo_card repo_url="https://github.com/foo/bar" stars="1,234" />`,
    );
    expect(r.repo_cards?.[0]?.stars).toBe(1234);
  });

  it("strips repo_card tags from visible text and parses multiple", () => {
    const r = processResponse([
      "Here's what surfaced:",
      `<repo_card repo_url="https://github.com/a/one" stars="100" />`,
      `<repo_card repo_url="https://github.com/b/two" stars="50" />`,
    ].join("\n"));
    expect(r.visible).toBe("Here's what surfaced:");
    expect(r.repo_cards).toHaveLength(2);
    expect(r.repo_cards?.map((c) => c.name)).toEqual(["one", "two"]);
  });

  it("dedupes by canonical URL — second mention of same repo is dropped", () => {
    const r = processResponse([
      `<repo_card repo_url="https://github.com/foo/bar" />`,
      `<repo_card repo_url="https://github.com/foo/bar.git" stars="50" />`,
    ].join("\n"));
    expect(r.repo_cards).toHaveLength(1);
  });

  it("drops cards with malformed repo_url (non-github host)", () => {
    const r = processResponse(
      `<repo_card repo_url="https://gitlab.com/foo/bar" />`,
    );
    expect(r.repo_cards).toBeUndefined();
  });

  it("drops cards missing repo_url entirely", () => {
    const r = processResponse(`<repo_card stars="100" />`);
    expect(r.repo_cards).toBeUndefined();
  });

  it("ignores unknown source values rather than passing them through", () => {
    const r = processResponse(
      `<repo_card repo_url="https://github.com/foo/bar" source="bogus" />`,
    );
    expect(r.repo_cards?.[0]?.source).toBeUndefined();
  });
});

describe("processResponse — github URL auto-promotion", () => {
  it("auto-promotes a bare github URL in the visible text to a repo_card", () => {
    // Agent drifted from the <repo_card> directive and emitted a
    // markdown link. UI still gets a Try button.
    const r = processResponse(
      "Try https://github.com/mattpocock/skills — Skills for Real Engineers.",
    );
    expect(r.repo_cards).toEqual([
      {
        repo_url: "https://github.com/mattpocock/skills",
        owner: "mattpocock",
        name: "skills",
      },
    ]);
    // Visible text keeps the URL so the markdown link still renders.
    expect(r.visible).toContain("https://github.com/mattpocock/skills");
  });

  it("auto-promotes multiple bare URLs in the same message", () => {
    const r = processResponse([
      "Top picks:",
      "- https://github.com/karpathy/nanoGPT",
      "- https://github.com/foo/bar",
    ].join("\n"));
    expect(r.repo_cards).toHaveLength(2);
    expect(r.repo_cards?.map((c) => c.name)).toEqual(["nanoGPT", "bar"]);
  });

  it("does not duplicate when both <repo_card> and a bare URL reference the same repo", () => {
    const r = processResponse([
      `<repo_card repo_url="https://github.com/foo/bar" stars="100" />`,
      "I picked foo/bar — see https://github.com/foo/bar.",
    ].join("\n"));
    expect(r.repo_cards).toHaveLength(1);
    // Explicit card wins (keeps stars metadata).
    expect(r.repo_cards?.[0]?.stars).toBe(100);
  });

  it("collapses subpaths to repo root and strips .git", () => {
    const r = processResponse(
      "Reading https://github.com/foo/bar/blob/main/README.md and git clone https://github.com/baz/qux.git",
    );
    expect(r.repo_cards?.map((c) => c.repo_url)).toEqual([
      "https://github.com/foo/bar",
      "https://github.com/baz/qux",
    ]);
  });

  it("filters non-repo github paths (orgs, settings, marketplace)", () => {
    const r = processResponse(
      "See https://github.com/orgs/foo/teams and https://github.com/settings/profile and https://github.com/karpathy/llm.c",
    );
    expect(r.repo_cards).toHaveLength(1);
    expect(r.repo_cards?.[0]?.owner).toBe("karpathy");
  });

  it("leaves visible text intact (URLs still render as markdown links)", () => {
    const r = processResponse("check https://github.com/foo/bar out");
    expect(r.visible).toBe("check https://github.com/foo/bar out");
  });

  it("does not strip URLs that came from explicit <repo_card> tags", () => {
    // The card tag is removed; the bare URL elsewhere in prose is kept.
    const r = processResponse([
      `<repo_card repo_url="https://github.com/explicit/one" />`,
      "Also mentioned https://github.com/explicit/one in prose.",
    ].join("\n"));
    expect(r.repo_cards).toHaveLength(1);
    expect(r.visible).toContain("Also mentioned https://github.com/explicit/one");
  });
});
