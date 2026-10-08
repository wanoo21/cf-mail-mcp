import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function mailboxDomain(address) {
  const at = address.lastIndexOf("@");
  return at < 1 ? "" : address.slice(at + 1).toLowerCase();
}

export function parseJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1"));
}

export function mailAddressFromConfig(text) {
  return parseJsonc(text).vars?.MAIL_ADDRESS?.trim() ?? "";
}

function denied(text) {
  return /403|unauthorized|not authorized|authentication error|permission denied|lacks permission/i.test(text);
}

export function runWrangler(args, { spawnFn = spawn, env = process.env } = {}) {
  return new Promise((ok) => {
    const child = spawnFn("npx", ["wrangler", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => ok({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => ok({ code: 1, stdout, stderr: String(err) }));
  });
}

function field(out, name) {
  const m = out.match(new RegExp(`^\\s*${name}:\\s*(.+)\\s*$`, "im"));
  return m?.[1]?.trim() ?? "";
}

export async function checkSetup({ address, run = runWrangler, token = process.env.CLOUDFLARE_API_TOKEN } = {}) {
  const rows = [];
  const add = (name, ok, detail) => rows.push({ name, ok, detail });

  if (!token) {
    add("token", false, "set CLOUDFLARE_API_TOKEN");
    return rows;
  }

  const who = await run(["whoami", "--json"]);
  const whoText = `${who.stdout}\n${who.stderr}`;
  add("token", who.code === 0, who.code === 0 ? "wrangler whoami" : denied(whoText) ? "token rejected" : who.stderr.trim() || "wrangler whoami failed");

  const perms = [
    ["D1 Edit", ["d1", "list", "--json"], "add Account D1 Edit"],
    ["Workers R2 Storage Edit", ["r2", "bucket", "list"], "add Account Workers R2 Storage Edit"],
    ["Workers Scripts Edit", ["deployments", "list", "--json"], "add Account Workers Scripts Edit"],
    ["Email Sending Edit", ["email", "sending", "list"], "add Account Email Sending Edit"],
  ];
  for (const [name, args, fix] of perms) {
    const r = await run(args);
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) add(name, true, "ok");
    else if (denied(text)) add(name, false, fix);
    else add(name, true, "api reachable");
  }

  const domain = mailboxDomain(address ?? "");
  if (!domain) {
    add("domain", false, "pass a mailbox address or set vars.MAIL_ADDRESS in wrangler.jsonc");
    return rows;
  }

  const rules = await run(["email", "routing", "rules", "list", domain]);
  const rulesText = `${rules.stdout}\n${rules.stderr}`;
  if (denied(rulesText)) add("Email Routing Rules Edit", false, "add Zone Email Routing Rules Edit");
  else add("Email Routing Rules Edit", rules.code === 0 || !denied(rulesText), rules.code === 0 ? "ok" : "api reachable");

  const routing = await run(["email", "routing", "settings", domain]);
  const routingText = `${routing.stdout}\n${routing.stderr}`;
  if (denied(routingText)) add("Email Routing", false, "add Zone Email Routing Rules Edit");
  else if (routing.code !== 0) add("Email Routing", false, routing.stderr.trim() || "could not read routing settings");
  else {
    const enabled = field(routing.stdout, "Enabled") === "true";
    const status = field(routing.stdout, "Status");
    const apex = routing.stdout.match(/^Email Routing for (.+):/m)?.[1]?.trim() || domain;
    const sub = domain !== apex;
    if (enabled && (status === "ready" || !status)) {
      add(sub ? `Email Routing on apex ${apex}` : `Email Routing on ${domain}`, true, status || "enabled");
    } else {
      add(
        sub ? `Email Routing on apex ${apex}` : `Email Routing on ${domain}`,
        false,
        sub
          ? `apex must already be onboarded to Routing (status ${status || "unknown"}). If apex mail lives at iCloud/Google, use another domain. Never onboard an apex that has other MX.`
          : `not ready (enabled=${enabled}, status=${status || "unknown"}). Confirm before any MX change, then wrangler email routing enable ${domain}`,
      );
    }
  }

  const sending = await run(["email", "sending", "settings", domain]);
  const sendingText = `${sending.stdout}\n${sending.stderr}`;
  if (denied(sendingText)) add("Email Sending", false, "add Account Email Sending Edit");
  else if (sending.code !== 0) add("Email Sending", false, `not enabled for ${domain}. Confirm DNS, then wrangler email sending enable ${domain}`);
  else {
    const enabled = field(sending.stdout, "Enabled") === "true";
    add(`Email Sending on ${domain}`, enabled, enabled ? "enabled" : `not enabled. Confirm DNS, then wrangler email sending enable ${domain}`);
  }

  return rows;
}

function print(rows) {
  let failed = 0;
  for (const r of rows) {
    console.log(`${r.ok ? "pass" : "fail"}  ${r.name}${r.detail ? `  ${r.detail}` : ""}`);
    if (!r.ok) failed++;
  }
  process.exitCode = failed ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const token = io.token ?? process.env.CLOUDFLARE_API_TOKEN;
  let address = argv[0] ?? "";
  if (!address) {
    try {
      address = mailAddressFromConfig(readFileSync(io.configPath ?? "wrangler.jsonc", "utf8"));
    } catch {
      address = "";
    }
  }
  const rows = await checkSetup({ address, run: io.run, token });
  (io.print ?? print)(rows);
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
