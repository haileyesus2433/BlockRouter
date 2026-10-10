import { DatabaseSync } from "node:sqlite";

export type ApiKeyRecord = {
  id: string;
  name: string;
  hash: string;
  sessionPubkey: string;
  ownerPubkey: string;
  createdAt: number;
  revokedAt: number | null;
};

export type UsageRecord = {
  sessionPubkey: string;
  promptTokens: bigint;
  completionTokens: bigint;
  estimatedPromptTokens: bigint;
  requests: number;
  closeRequested: boolean;
  firstUsageAt: number;
  settledAt: number | null;
  settleSignature: string | null;
  lastError: string | null;
};

type Row = Record<string, unknown>;

function toKey(row: Row): ApiKeyRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    hash: String(row.hash),
    sessionPubkey: String(row.session_pubkey),
    ownerPubkey: String(row.owner_pubkey),
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

function toUsage(row: Row): UsageRecord {
  return {
    sessionPubkey: String(row.session_pubkey),
    promptTokens: BigInt(row.prompt_tokens as number),
    completionTokens: BigInt(row.completion_tokens as number),
    estimatedPromptTokens: BigInt(row.estimated_prompt_tokens as number),
    requests: Number(row.requests),
    closeRequested: Boolean(row.close_requested),
    firstUsageAt: Number(row.first_usage_at),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    settleSignature: row.settle_signature === null ? null : String(row.settle_signature),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

// Usage is written before the response finishes, so a crash cannot lose billable tokens.
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        session_pubkey TEXT NOT NULL,
        owner_pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS api_keys_owner ON api_keys (owner_pubkey);
      CREATE TABLE IF NOT EXISTS usage (
        session_pubkey TEXT PRIMARY KEY,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        close_requested INTEGER NOT NULL DEFAULT 0,
        first_usage_at INTEGER NOT NULL,
        settled_at INTEGER,
        settle_signature TEXT,
        last_error TEXT
      );
    `);
  }

  insertKey(key: ApiKeyRecord): void {
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, hash, session_pubkey, owner_pubkey, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(key.id, key.name, key.hash, key.sessionPubkey, key.ownerPubkey, key.createdAt);
  }

  findKeyByHash(hash: string): ApiKeyRecord | null {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE hash = ?").get(hash) as Row | undefined;
    return row ? toKey(row) : null;
  }

  listKeys(owner: string): ApiKeyRecord[] {
    return (this.db
      .prepare("SELECT * FROM api_keys WHERE owner_pubkey = ? ORDER BY created_at")
      .all(owner) as Row[]).map(toKey);
  }

  revokeKey(id: string, owner: string, now: number): boolean {
    const result = this.db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND owner_pubkey = ? AND revoked_at IS NULL")
      .run(now, id, owner);
    return Number(result.changes) > 0;
  }

  getUsage(session: string): UsageRecord | null {
    const row = this.db.prepare("SELECT * FROM usage WHERE session_pubkey = ?").get(session) as Row | undefined;
    return row ? toUsage(row) : null;
  }

  addUsage(session: string, prompt: number, completion: number, estimatedPrompt: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO usage (session_pubkey, prompt_tokens, completion_tokens, estimated_prompt_tokens, requests, first_usage_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (session_pubkey) DO UPDATE SET
           prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens,
           estimated_prompt_tokens = estimated_prompt_tokens + excluded.estimated_prompt_tokens,
           requests = requests + 1`,
      )
      .run(session, prompt, completion, estimatedPrompt, now);
  }

  requestClose(session: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO usage (session_pubkey, close_requested, first_usage_at) VALUES (?, 1, ?)
         ON CONFLICT (session_pubkey) DO UPDATE SET close_requested = 1`,
      )
      .run(session, now);
  }

  unsettled(): UsageRecord[] {
    return (this.db.prepare("SELECT * FROM usage WHERE settled_at IS NULL").all() as Row[]).map(toUsage);
  }

  markSettled(session: string, signature: string, now: number): void {
    this.db
      .prepare("UPDATE usage SET settled_at = ?, settle_signature = ?, last_error = NULL WHERE session_pubkey = ?")
      .run(now, signature, session);
  }

  recordSettleError(session: string, error: string): void {
    this.db.prepare("UPDATE usage SET last_error = ? WHERE session_pubkey = ?").run(error, session);
  }

  close(): void {
    this.db.close();
  }
}
