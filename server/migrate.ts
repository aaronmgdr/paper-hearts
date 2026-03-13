import postgres from "postgres";
import { readdir } from "fs/promises";
import { join } from "path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Skipping migrations.");
  process.exit(0);
}

// Ensure the target database exists before attempting migrations.
// Connect to the "postgres" maintenance DB (always exists) to create it.
const url = new URL(DATABASE_URL);
const dbName = url.pathname.slice(1); // strip leading "/"
const maintenanceUrl = new URL(DATABASE_URL);
maintenanceUrl.pathname = "/postgres";
const maintenance = postgres(maintenanceUrl.toString());
const existing = await maintenance`
  SELECT 1 FROM pg_database WHERE datname = ${dbName}
`;
if (existing.length === 0) {
  console.log(`  create database: ${dbName}`);
  await maintenance.unsafe(`CREATE DATABASE "${dbName}"`);
}
await maintenance.end();

const sql = postgres(DATABASE_URL);
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

async function migrate() {
  // Create migrations tracking table
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Get already-applied migrations
  const applied = await sql`SELECT filename FROM schema_migrations ORDER BY filename`;
  const appliedSet = new Set(applied.map((r) => r.filename));

  // Read migration files
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip: ${file} (already applied)`);
      continue;
    }

    const filePath = join(MIGRATIONS_DIR, file);
    const migration = await Bun.file(filePath).text();

    console.log(`  apply: ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
  }

  console.log("Migrations complete.");
  await sql.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
