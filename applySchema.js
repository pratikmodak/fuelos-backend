import fs from "fs";
import pkg from "pg";

const { Client } = pkg;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();

  const schema = fs.readFileSync("magrate.sql", "utf8");
  await client.query(schema);

  console.log("✅ Schema applied successfully");

  await client.end();
}

run();