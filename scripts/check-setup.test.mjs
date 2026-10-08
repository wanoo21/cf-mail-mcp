import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSetup, mailboxDomain, mailAddressFromConfig, parseJsonc } from "./check-setup.mjs";

test("parses mailbox domain and jsonc", () => {
  assert.equal(mailboxDomain("agent@mail.example.com"), "mail.example.com");
  assert.equal(mailAddressFromConfig(`{ "vars": { "MAIL_ADDRESS": "a@x.com" } }`), "a@x.com");
  assert.equal(parseJsonc(`{ // x\n"vars": { "MAIL_ADDRESS": "a@x.com" },\n}`).vars.MAIL_ADDRESS, "a@x.com");
});

function script(map) {
  return async (args) => map[args.join(" ")] ?? { code: 1, stdout: "", stderr: "unknown" };
}

test("fails without a token", async () => {
  const rows = await checkSetup({ token: "", address: "a@mail.example.com" });
  assert.deepEqual(rows, [{ name: "token", ok: false, detail: "set CLOUDFLARE_API_TOKEN" }]);
});

test("reports token perms and domain readiness", async () => {
  const rows = await checkSetup({
    token: "t",
    address: "agent@mail.example.com",
    run: script({
      "whoami --json": { code: 0, stdout: "{}", stderr: "" },
      "d1 list --json": { code: 0, stdout: "[]", stderr: "" },
      "r2 bucket list": { code: 0, stdout: "", stderr: "" },
      "deployments list --json": { code: 0, stdout: "[]", stderr: "" },
      "email sending list": { code: 0, stdout: "", stderr: "" },
      "email routing rules list mail.example.com": { code: 0, stdout: "", stderr: "" },
      "email routing settings mail.example.com": {
        code: 0,
        stdout: "Email Routing for example.com:\n  Enabled:  true\n  Status:   ready\n",
        stderr: "",
      },
      "email sending settings mail.example.com": {
        code: 0,
        stdout: "Email Sending for mail.example.com:\n  Enabled:            true\n",
        stderr: "",
      },
    }),
  });
  assert.equal(rows.every((r) => r.ok), true);
  assert.ok(rows.some((r) => r.name === "Email Routing on apex example.com"));
});

test("fails missing perms and unready domains with a fix", async () => {
  const rows = await checkSetup({
    token: "t",
    address: "agent@mail.example.com",
    run: script({
      "whoami --json": { code: 1, stdout: "", stderr: "Authentication error" },
      "d1 list --json": { code: 1, stdout: "", stderr: "403 Forbidden" },
      "r2 bucket list": { code: 0, stdout: "", stderr: "" },
      "deployments list --json": { code: 0, stdout: "[]", stderr: "" },
      "email sending list": { code: 1, stdout: "", stderr: "lacks permission" },
      "email routing rules list mail.example.com": { code: 1, stdout: "", stderr: "unauthorized" },
      "email routing settings mail.example.com": {
        code: 0,
        stdout: "Email Routing for example.com:\n  Enabled:  false\n  Status:   unconfigured\n",
        stderr: "",
      },
      "email sending settings mail.example.com": { code: 1, stdout: "", stderr: "not found" },
    }),
  });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.token.ok, false);
  assert.equal(by["D1 Edit"].ok, false);
  assert.match(by["D1 Edit"].detail, /D1 Edit/);
  assert.equal(by["Email Sending Edit"].ok, false);
  assert.equal(by["Email Routing Rules Edit"].ok, false);
  assert.equal(by["Email Routing on apex example.com"].ok, false);
  assert.match(by["Email Routing on apex example.com"].detail, /Never onboard/);
  assert.equal(by["Email Sending"].ok, false);
  assert.match(by["Email Sending"].detail, /email sending enable/);
});
