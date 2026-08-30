import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  plan: text("plan").notNull().default("free"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const oauthAccounts = sqliteTable(
  "oauth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("oauth_provider_subject_unique").on(table.provider, table.providerSubject),
    index("oauth_accounts_user_id_idx").on(table.userId),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("auth_sessions_user_id_idx").on(table.userId)],
);

export type OauthAccount = typeof oauthAccounts.$inferSelect;
export type AuthSession = typeof authSessions.$inferSelect;

export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["grant", "debit", "refund"] }).notNull(),
    // Integer minor-unit credits. Positive for grant/refund, negative for debit.
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("credit_ledger_idempotency_key_unique").on(table.idempotencyKey),
    index("credit_ledger_user_id_idx").on(table.userId),
  ],
);

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    units: integer("units").notNull(),
    credits: integer("credits").notNull(),
    model: text("model"),
    sessionId: text("session_id"),
    status: text("status", { enum: ["succeeded", "refunded"] }).notNull().default("succeeded"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("usage_events_user_id_idx").on(table.userId)],
);

export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    definitionId: text("definition_id").notNull(),
    projectId: text("project_id").notNull(),
    // JSON-encoded WebAppBootstrap fields (config, workspaceRoot, selectedDiffActionId, ...).
    bootstrapJson: text("bootstrap_json").notNull(),
    webEditorJson: text("web_editor_json").notNull(),
    // Version tag for the shared default workspace snapshot this session's
    // workspace_files rows are diffed against; null when the session has no
    // baseline (workspaceFiles was never set).
    workspaceBaselineVersion: text("workspace_baseline_version"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("sessions_owner_user_id_idx").on(table.ownerUserId)],
);

export const sessionEvents = sqliteTable(
  "session_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    eventJson: text("event_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("session_events_session_seq_unique").on(table.sessionId, table.seq),
    index("session_events_session_id_idx").on(table.sessionId),
  ],
);

export const workspaceFiles = sqliteTable(
  "workspace_files",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    // Null marks a tombstone: a baseline file this session has removed.
    content: text("content"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("workspace_files_session_path_unique").on(table.sessionId, table.path),
    index("workspace_files_session_id_idx").on(table.sessionId),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type WorkspaceFileRow = typeof workspaceFiles.$inferSelect;

export const workspaceBaselines = sqliteTable("workspace_baselines", {
  // The value produced by the server's workspace baseline fingerprint
  // (see apps/server/src/domain/workspace.ts:getWorkspaceBaselineVersion).
  version: text("version").primaryKey(),
  // JSON-encoded array of { path, content } entries for the full baseline
  // snapshot this version was computed from.
  filesJson: text("files_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type WorkspaceBaselineRow = typeof workspaceBaselines.$inferSelect;

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    inputJson: text("input_json").notNull(),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    version: integer("version").notNull().default(1),
  },
  (table) => [index("agent_runs_session_id_idx").on(table.sessionId)],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    eventJson: text("event_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("run_events_run_seq_unique").on(table.runId, table.seq),
    index("run_events_run_id_idx").on(table.runId),
  ],
);

export type AgentRunRow = typeof agentRuns.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
