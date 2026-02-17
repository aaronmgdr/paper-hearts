import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL not set. DB queries will fail.");
}

const sql = DATABASE_URL
  ? postgres(DATABASE_URL)
  : (null as unknown as ReturnType<typeof postgres>);

export default sql;
