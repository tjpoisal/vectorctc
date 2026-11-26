export interface MemoryHit {
  id: string | null;
  content: string;
  tags: string[];
}

export interface MemoryWrite {
  content: string;
  tags: string[];
  file?: string | null;
  repo?: string | null;
}

export interface MemoryFeedback {
  rating: "helped" | "wrong" | "stale";
  query: string;
  note?: string;
}

/**
 * Unimatrix (or a test double). Implementations must not throw into the gate;
 * callers still catch, because a memory outage cannot block a write.
 */
export interface MemoryAdapter {
  store(input: MemoryWrite): void | Promise<void>;
  search(query: string): MemoryHit[] | Promise<MemoryHit[]>;
  recall(query: string): MemoryHit[] | Promise<MemoryHit[]>;
  getContext(query: string): MemoryHit[] | Promise<MemoryHit[]>;
  feedback(input: MemoryFeedback): void | Promise<void>;
}
