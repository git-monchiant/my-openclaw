export {
  saveMessage,
  loadHistory,
  searchMemory,
  formatMemoryForPrompt,
  getMemoryStatus,
} from "./manager.js";
export type { MemoryConfig, SearchResult, MemoryChunk, MemoryStatus } from "./types.js";
export { DEFAULT_MEMORY_CONFIG } from "./types.js";
