export {
  BlockCharLimitExceededError,
  BlockNotFoundError,
  CoreMemory,
} from "./core-memory.js";
export type { CoreMemoryDeps, CoreMemoryOperation } from "./core-memory.js";

export { FactStore } from "./fact-store.js";
export type { FactStoreDeps } from "./fact-store.js";

export { FactPromoter } from "./fact-promoter.js";
export type { FactPromoterDeps, PromotionResult } from "./fact-promoter.js";

export { createMemoryAgent } from "./memory-agent.js";
export type { MemoryAgent, MemoryAgentDeps } from "./memory-agent.js";
