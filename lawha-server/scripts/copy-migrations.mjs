// tsc only emits TypeScript, so the .sql migrations have to be copied across
// or the built server boots against an empty database.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.join(root, "src", "db", "migrations");
const to = path.join(root, "dist", "db", "migrations");

fs.mkdirSync(to, { recursive: true });

const copied = fs
  .readdirSync(from)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => {
    fs.copyFileSync(path.join(from, name), path.join(to, name));
    return name;
  });

process.stdout.write(`lawha: copied ${copied.length} migration(s) to dist\n`);
