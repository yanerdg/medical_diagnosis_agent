import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { databaseSchema } from "./schema";

export type SqliteDatabase = Database.Database;

const DEFAULT_DATABASE_FILE = "medical-diagnosis-agent.sqlite";

let singletonDatabase: SqliteDatabase | undefined;

export function getDataDirectory(): string {
  return process.env.MEDICAL_AGENT_DATA_DIR ?? join(process.cwd(), "data");
}

export function getDatabasePath(): string {
  return (
    process.env.MEDICAL_AGENT_DATABASE_PATH ??
    join(getDataDirectory(), DEFAULT_DATABASE_FILE)
  );
}

export function initializeDatabase(database: SqliteDatabase): void {
  database.exec(databaseSchema);
  migrateDatabase(database);
}

function migrateDatabase(database: SqliteDatabase): void {
  const responseColumns = database
    .prepare("PRAGMA table_info(clarification_responses)")
    .all() as Array<{ name: string }>;
  if (!responseColumns.some((column) => column.name === "conflict_resolution")) {
    database.exec(
      "ALTER TABLE clarification_responses ADD COLUMN conflict_resolution TEXT CHECK (conflict_resolution IN ('confirm_left', 'confirm_right', 'acknowledge_unknown'))",
    );
  }
}

export function openDatabase(databasePath = getDatabasePath()): SqliteDatabase {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");

  if (databasePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
  }

  initializeDatabase(database);
  return database;
}

export function getDatabase(): SqliteDatabase {
  singletonDatabase ??= openDatabase();
  return singletonDatabase;
}

export function closeDatabase(): void {
  singletonDatabase?.close();
  singletonDatabase = undefined;
}
