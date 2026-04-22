import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type { CoreMemoryBlockRepository } from "../../ports/core-memory-repo.js";
import { CoreMemory } from "./core-memory.js";

function makeBlock(overrides: Partial<CoreMemoryBlock> = {}): CoreMemoryBlock {
  return {
    id: "block_1",
    agent_id: "agent_1",
    block_name: "persona",
    content: "",
    char_limit: 2000,
    is_system: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

let repo: CoreMemoryBlockRepository;
let service: CoreMemory;

beforeEach(() => {
  repo = {
    findByAgent: vi.fn(),
    findOne: vi.fn(),
    upsert: vi.fn(),
    updateContent: vi.fn(),
    delete: vi.fn(),
    initDefaults: vi.fn(),
  };
  service = new CoreMemory({ repo });
});

describe("CoreMemory.applyUpdate — append", () => {
  it("appends content with a newline separator when block has existing content", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(
      makeBlock({ content: "You are a senior engineer." }),
    );
    vi.mocked(repo.updateContent).mockImplementation(async (_a, _b, c) =>
      makeBlock({ content: c }),
    );

    const result = await service.applyUpdate(
      "agent_1",
      "persona",
      "append",
      "You prefer TypeScript.",
    );

    expect(repo.updateContent).toHaveBeenCalledWith(
      "agent_1",
      "persona",
      "You are a senior engineer.\nYou prefer TypeScript.",
    );
    expect(result.content).toContain("TypeScript");
  });

  it("appends without a leading separator when block is empty", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(makeBlock({ content: "" }));
    vi.mocked(repo.updateContent).mockImplementation(async (_a, _b, c) =>
      makeBlock({ content: c }),
    );

    await service.applyUpdate("agent_1", "persona", "append", "Initial content.");

    expect(repo.updateContent).toHaveBeenCalledWith(
      "agent_1",
      "persona",
      "Initial content.",
    );
  });

  it("throws when the resulting content would exceed char_limit", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(
      makeBlock({ content: "x".repeat(1980), char_limit: 2000 }),
    );
    await expect(
      service.applyUpdate("agent_1", "persona", "append", "x".repeat(30)),
    ).rejects.toThrow(/char_limit/);
    expect(repo.updateContent).not.toHaveBeenCalled();
  });
});

describe("CoreMemory.applyUpdate — replace", () => {
  it("substitutes the old substring with new content", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(
      makeBlock({ content: "You are a junior engineer." }),
    );
    vi.mocked(repo.updateContent).mockImplementation(async (_a, _b, c) =>
      makeBlock({ content: c }),
    );

    await service.applyUpdate(
      "agent_1",
      "persona",
      "replace",
      "senior",
      "junior",
    );

    expect(repo.updateContent).toHaveBeenCalledWith(
      "agent_1",
      "persona",
      "You are a senior engineer.",
    );
  });

  it("throws when old_content is absent", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(makeBlock({ content: "hello world" }));
    await expect(
      service.applyUpdate("agent_1", "persona", "replace", "rust", "python"),
    ).rejects.toThrow(/old_content not found/);
  });

  it("throws when old_content is empty", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(makeBlock({ content: "anything" }));
    await expect(
      service.applyUpdate("agent_1", "persona", "replace", "new", ""),
    ).rejects.toThrow(/non-empty old_content/);
  });

  it("throws when old_content undefined", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(makeBlock({ content: "anything" }));
    await expect(
      service.applyUpdate("agent_1", "persona", "replace", "new"),
    ).rejects.toThrow(/non-empty old_content/);
  });
});

describe("CoreMemory plumbing", () => {
  it("throws on update when the named block doesn't exist", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(undefined);
    await expect(
      service.applyUpdate("agent_1", "never_seeded", "append", "x"),
    ).rejects.toThrow(/not found/);
  });

  it("read delegates to repo.findByAgent", async () => {
    vi.mocked(repo.findByAgent).mockResolvedValue([makeBlock()]);
    const blocks = await service.read("agent_1");
    expect(repo.findByAgent).toHaveBeenCalledWith("agent_1");
    expect(blocks).toHaveLength(1);
  });

  it("initDefaults delegates to repo.initDefaults with the given level", async () => {
    vi.mocked(repo.initDefaults).mockResolvedValue([]);
    await service.initDefaults("agent_1", "team");
    expect(repo.initDefaults).toHaveBeenCalledWith("agent_1", "team");
  });
});
