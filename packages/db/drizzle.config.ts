import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env["DATABASE_URL"] ?? "file:./data/local.db";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: databaseUrl,
  },
});
