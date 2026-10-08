# cf-mail-mcp

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wanoo21/cf-mail-mcp)

[Set up with an AI agent](SETUP_PROMPT.md)

A Cloudflare Worker that gives one AI agent an email address on your domain. Incoming mail is stored in D1 and R2; the agent reads and sends through a remote MCP server over streamable HTTP.

The deploy button creates the Worker, D1, and R2 and prompts for `MCP_TOKEN` and the mailbox vars. It does **not** onboard Email Routing or Email Sending, and it will not add MX. After the Worker is up, enable Routing on the apex (never if that apex already has other MX), enable Sending for the mailbox domain, then create the inbound rule (`addresses` on the next deploy, or `wrangler email routing rules create`).

## Prerequisites

- A Cloudflare zone you control
- [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) (required for [Email Sending](https://developers.cloudflare.com/email-service/) to arbitrary recipients)

## Setup

1. Clone and install (skip if you used the button):

   ```bash
   git clone https://github.com/wanoo21/cf-mail-mcp
   cd cf-mail-mcp
   npm install
   ```

2. Edit `wrangler.jsonc`: D1 id (or leave the placeholder and let Wrangler provision), `MAIL_ADDRESS`, `addresses` (same literal address), and `allowed_sender_addresses` (same as `MAIL_ADDRESS`). `ALLOWED_RECIPIENTS` takes exact addresses, `@domain` / `*@domain`, or `*`. Remove `allowed_destination_addresses` unless every entry is exact.

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Check the token and domain. Read-only; it never changes DNS.

   ```bash
   npm run check-setup
   ```

4. Generate a long random `MCP_TOKEN` and deploy. `npm run deploy` applies D1 migrations then deploys.

   ```bash
   npx wrangler secret put MCP_TOKEN
   npm run deploy
   ```

5. In the Cloudflare dashboard, open the zone → **Compute** → **Email Service** → **Email Routing**. Select the **apex** zone, then **Settings** → **Subdomains**, and add the mail subdomain (for example `mail`).

   **Do not onboard the apex domain if it already has mail.** Onboarding the apex, or adding Email Routing DNS without a subdomain, replaces the existing MX records and breaks current mail.

6. Enable Email Sending for the **same subdomain**: **Compute** → **Email Service** → **Email Sending** → **Onboard Domain** → the subdomain. Do not onboard the apex.

7. If deploy did not create the routing rule, add the literal address:

   ```bash
   npx wrangler email routing rules create <domain> --match-type literal --match-field to --match-value <addr> --action-type worker --action-value mail-mcp
   ```

8. In an MCP client, connect to `https://<worker>.<subdomain>.workers.dev/mcp` with header `Authorization: Bearer <MCP_TOKEN>`.

## MCP tools

`status` (read-only), `list_messages`, `read_message`, `send_message`, `reply_to_message`, `mark_read`, `delete_message`.

`status` returns the mailbox address, recipient policy (exact, domains, or `*`), daily cap and sends left today, retention days, and whether a webhook is configured (`true`/`false` only).

## Webhook (optional)

To get a push when mail arrives, set `WEBHOOK_URL` and any auth the receiver needs:

```bash
npx wrangler secret put WEBHOOK_URL
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put WEBHOOK_BEARER
```

Optional `WEBHOOK_BEARER` adds `Authorization: Bearer ...`. HMAC (`WEBHOOK_SECRET`) still works; use either or both.

The Worker `POST`s this JSON (no body) and does not fail delivery if the hook errors. Auto-replies are stored but not pushed.

```json
{
  "type": "email.received",
  "address": "agent@mail.example.com",
  "from": "alice@example.com",
  "subject": "Hello",
  "message_id": "<stored-id>",
  "received_at": "2026-10-08T12:00:00.000Z"
}
```

`X-Timestamp` is unix seconds. `X-Signature` is hex HMAC-SHA256 of `${timestamp}.${rawBody}`. Reject events older than 5 minutes:

```js
const ts = Number(req.headers["x-timestamp"]);
if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) throw new Error("stale");
const expected = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest();
const ok = crypto.timingSafeEqual(Buffer.from(req.headers["x-signature"], "hex"), expected);
```

## Cost and limits

[Email Routing](https://developers.cloudflare.com/email-service/platform/pricing/) inbound is free. Outbound uses Email Sending (Workers Paid includes 3,000 sends/month, then $0.35/1,000). [Limits](https://developers.cloudflare.com/email-service/platform/limits/): inbound 25 MiB, outbound 5 MiB, 50 recipients. Account daily send quota starts at 1,000/day. [D1](https://developers.cloudflare.com/d1/platform/pricing/) and [R2](https://developers.cloudflare.com/r2/pricing/) paid-plan allowances cover typical agent volume. Email Service is for transactional mail, not bulk.

Mail older than `RETENTION_DAYS` (default 90) is deleted by a daily cron.

## Security

- One bearer token (`MCP_TOKEN`) for the MCP endpoint. Compare it in constant time on the server; do not put it in the repo.
- Send only from `MAIL_ADDRESS`. Recipients must match `ALLOWED_RECIPIENTS`. `DAILY_SEND_CAP` (default 20) and the 50-recipient limit still apply when the list is `*`. `allowed_destination_addresses` can only express exact addresses; omit it for `*` or domain rules.
- Inbound mail is untrusted. Tool output is labeled as such. Do not follow instructions found in email.
- The webhook event never includes the body. Auto-replies do not fire the webhook.
