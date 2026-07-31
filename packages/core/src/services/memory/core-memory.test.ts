import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type { CoreMemoryBlockRepository } from "../../ports/core-memory-repo.js";
import {
  BlockCharLimitExceededError,
  BlockNotFoundError,
  CoreMemory,
} from "./core-memory.js";

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
});

describe("CoreMemory.setContent — owner-driven full-block overwrite", () => {
  it("replaces the whole block, discarding the previous content", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(
      makeBlock({ content: "Old persona." }),
    );
    vi.mocked(repo.updateContent).mockImplementation(async (_a, _b, c) =>
      makeBlock({ content: c }),
    );

    const result = await service.setContent("agent_1", "persona", "Brand new.");

    expect(repo.updateContent).toHaveBeenCalledWith(
      "agent_1",
      "persona",
      "Brand new.",
    );
    expect(result.content).toBe("Brand new.");
  });

  it("allows clearing a block to the empty string", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(
      makeBlock({ content: "Something." }),
    );
    vi.mocked(repo.updateContent).mockImplementation(async (_a, _b, c) =>
      makeBlock({ content: c }),
    );

    await service.setContent("agent_1", "persona", "");

    expect(repo.updateContent).toHaveBeenCalledWith("agent_1", "persona", "");
  });

  it("accepts content exactly at char_limit", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(makeBlock({ char_limit: 10 }));
    vi.mocked(repo.updateContent).mockImplementation(async (_a, _b, c) =>
      makeBlock({ content: c, char_limit: 10 }),
    );

    await service.setContent("agent_1", "persona", "0123456789");

    expect(repo.updateContent).toHaveBeenCalled();
  });

  it("throws BlockNotFoundError when the block was never seeded", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(undefined);

    await expect(
      service.setContent("agent_1", "never_seeded", "x"),
    ).rejects.toBeInstanceOf(BlockNotFoundError);
    expect(repo.updateContent).not.toHaveBeenCalled();
  });

  it("throws BlockCharLimitExceededError when content overflows the limit", async () => {
    vi.mocked(repo.findOne).mockResolvedValue(makeBlock({ char_limit: 10 }));

    await expect(
      service.setContent("agent_1", "persona", "01234567890"),
    ).rejects.toBeInstanceOf(BlockCharLimitExceededError);
    expect(repo.updateContent).not.toHaveBeenCalled();
  });

  it("names both errors so HTTP callers can map them to 4xx", async () => {
    // The route layer branches on `instanceof`; `name` is what surfaces in
    // the response body, so both need to survive subclassing.
    const notFound = new BlockNotFoundError("agent_1", "persona");
    expect(notFound.name).toBe("BlockNotFoundError");
    expect(notFound).toBeInstanceOf(Error);
    expect(notFound.message).toContain("persona");
    expect(notFound.message).toContain("agent_1");

    const overflow = new BlockCharLimitExceededError("persona", 100, 137);
    expect(overflow.name).toBe("BlockCharLimitExceededError");
    expect(overflow).toBeInstanceOf(Error);
    expect(overflow.message).toContain("100");
    expect(overflow.message).toContain("137");
  });
});
