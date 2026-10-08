import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

const migrations = env.TEST_MIGRATIONS;
if (!migrations) throw new Error("TEST_MIGRATIONS missing");
await applyD1Migrations(env.DB, migrations);
