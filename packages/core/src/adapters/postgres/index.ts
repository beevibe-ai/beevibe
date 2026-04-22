export { createPool } from "./client.js";
export type { Pool, PoolClient, CreatePoolOptions } from "./client.js";
export type {
  PersonRow,
  AgentRow,
  TaskRow,
  SessionRow,
  CoreMemoryBlockRow,
  WorkProductRow,
  MemoryFactRow,
} from "./row-types.js";
export { PostgresPersonRepository } from "./person-repo.js";
export { PostgresAgentRepository } from "./agent-repo.js";
export { PostgresCoreMemoryRepository } from "./core-memory-repo.js";
export { PostgresTaskRepository } from "./task-repo.js";
export { PostgresSessionRepository } from "./session-repo.js";
export { PostgresWorkProductRepository } from "./work-product-repo.js";
export { PostgresMemoryFactRepository } from "./memory-fact-repo.js";
