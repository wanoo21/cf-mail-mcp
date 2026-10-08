# Set up with an AI agent

Alternatively, use the [Grok Bot (BYO Mailbox)](https://x.ai/bot/bMpYhKvs4LJbTJyvS1IvO) — a ready-made bot that walks through this setup.

Paste the block below into an agent that has a shell and your Cloudflare API token in `CLOUDFLARE_API_TOKEN`. Do not paste the token into the chat.

There is also a [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/wanoo21/cf-mail-mcp) button in the README. It provisions the Worker, D1, and R2 only. Routing, Sending, and the inbound rule stay manual.

---

Deploy https://github.com/wanoo21/cf-mail-mcp. One Cloudflare Worker, one mailbox, MCP at `/mcp`.

Never print secrets or tokens. Keep them in env or a file you delete after deploy. Do not commit them. Confirm with the user before any DNS or MX change.

1. Ask for the mailbox address and the domain it lives on.

Email Routing on a subdomain needs the apex already onboarded to Routing. If the apex mail lives elsewhere (iCloud, Google Workspace, another host), do not use that domain. Use another domain whose apex is already on Cloudflare Routing. Never onboard an apex that already has other MX records — that replaces them and steals mail.

If the address is on a subdomain, that subdomain must already be listed under the apex Email Routing settings (Settings → Subdomains). Workers Paid is required for outbound Email Sending.

2. Token and toolchain

`CLOUDFLARE_API_TOKEN` needs: Account D1 Edit, Workers R2 Storage Edit, Workers Scripts Edit, Email Sending Edit; Zone Email Routing Rules Edit.

Node 22+. wrangler 4.113+ (this repo pins ^4.148).

3. Provision

```
git clone https://github.com/wanoo21/cf-mail-mcp
cd cf-mail-mcp
npm install
npx wrangler d1 create mail-mcp
npx wrangler r2 bucket create mail-mcp
```

Skip create if the deploy button already provisioned them.

Fill `wrangler.jsonc`: `database_id`, `MAIL_ADDRESS`, `addresses` (same literal address), `allowed_sender_addresses` (same). `ALLOWED_RECIPIENTS` takes exact addresses, `@domain` / `*@domain`, or `*`. Remove `allowed_destination_addresses` unless every entry is exact.

```
npm run check-setup
```

That command is read-only. Fix every fail before touching DNS.

Confirm, then enable sending (this writes SPF/DKIM):

```
npx wrangler email sending enable <domain>
```

Write a long random `MCP_TOKEN` into a secrets file without echoing it. `npm run deploy` applies migrations, then deploys. Delete the secrets file after:

```
npm run deploy -- --secrets-file <secrets-file>
```

4. If the deploy-time `addresses` step fails on permissions, create the literal rule yourself:

```
npx wrangler email routing rules create <domain> --match-type literal --match-field to --match-value <addr> --action-type worker --action-value mail-mcp
```

5. Verify

- `GET /mcp` with no `Authorization` → 401
- initialize, then `tools/list`, with `Authorization: Bearer <token>` → the tools including `status`
- send a real test email to the address; `list_messages` shows it
- `status` shows the mailbox, recipient policy, sends left, and `webhook: false` unless you set a hook

6. Optional webhook: add `WEBHOOK_URL` plus `WEBHOOK_BEARER` and/or `WEBHOOK_SECRET` to the secrets file and redeploy with `--secrets-file`. Do not print them.

7. Hand back the `https://<worker>.<subdomain>.workers.dev/mcp` URL and the mailbox address. Not the token.
