# cf-mail-mcp

A Cloudflare Worker that gives one AI agent an email address on your domain. Incoming mail is stored in D1 and R2; the agent reads and sends through a remote MCP server over streamable HTTP.

## Prerequisites

- A Cloudflare zone you control
- [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) (required for [Email Sending](https://developers.cloudflare.com/email-service/) to arbitrary recipients)

## Setup

1. Clone and install:

   ```bash
   git clone https://github.com/wanoo21/cf-mail-mcp
   cd cf-mail-mcp
   npm install
   ```

2. Create D1 and R2:

   ```bash
   npx wrangler d1 create mail-mcp
   npx wrangler r2 bucket create mail-mcp
   ```

3. Copy the example config and fill in the D1 id, `MAIL_ADDRESS`, `ALLOWED_RECIPIENTS`, and `allowed_sender_addresses` (must match `MAIL_ADDRESS`):

   ```bash
   cp wrangler.example.jsonc wrangler.jsonc
   cp .dev.vars.example .dev.vars
   ```

4. Set secrets (generate a long random `MCP_TOKEN`):

   ```bash
   npx wrangler secret put MCP_TOKEN
   ```

5. Deploy:

   ```bash
   npx wrangler d1 migrations apply mail-mcp --remote
   npx wrangler deploy
   ```

6. In the Cloudflare dashboard, open the zone → **Compute** → **Email Service** → **Email Routing**. Select the **apex** zone, then **Settings** → **Subdomains**, and add the mail subdomain (for example `mail`).

   **Do not onboard the apex domain if it already has mail.** Onboarding the apex, or adding Email Routing DNS without a subdomain, replaces the existing MX records and breaks current mail.

7. Add a routing rule from the one address (`MAIL_ADDRESS`) to this Worker. Subdomains have no catch-all; the rule must be the literal address.

8. Enable Email Sending for the **same subdomain**: **Compute** → **Email Service** → **Email Sending** → **Onboard Domain** → the subdomain. Do not onboard the apex.

9. In an MCP client, connect to `https://<worker>.<subdomain>.workers.dev/mcp` with header `Authorization: Bearer <MCP_TOKEN>`.

## Webhook (optional)

To get a push when mail arrives, set both secrets:

```bash
npx wrangler secret put WEBHOOK_URL
npx wrangler secret put WEBHOOK_SECRET
```

The Worker `POST`s this JSON (no body) and does not fail delivery if the hook errors:

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

Check the signature: `X-Signature` is hex HMAC-SHA256 of the raw body using `WEBHOOK_SECRET`.

```js
const ok = crypto.timingSafeEqual(
  Buffer.from(req.headers["x-signature"], "hex"),
  crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(rawBody).digest(),
);
```

## Cost and limits

[Email Routing](https://developers.cloudflare.com/email-service/platform/pricing/) inbound is free. Outbound uses Email Sending (Workers Paid includes 3,000 sends/month, then $0.35/1,000). [Limits](https://developers.cloudflare.com/email-service/platform/limits/): inbound 25 MiB, outbound 5 MiB, 50 recipients. Account daily send quota starts at 1,000/day. [D1](https://developers.cloudflare.com/d1/platform/pricing/) and [R2](https://developers.cloudflare.com/r2/pricing/) paid-plan allowances cover typical agent volume. Email Service is for transactional mail, not bulk.

Mail older than `RETENTION_DAYS` (default 90) is deleted by a daily cron.

## Security

- One bearer token (`MCP_TOKEN`) for the MCP endpoint. Compare it in constant time on the server; do not put it in the repo.
- Send only from `MAIL_ADDRESS`. Recipients must be on `ALLOWED_RECIPIENTS` (default: your own address). `DAILY_SEND_CAP` (default 20) is a backstop.
- Inbound mail is untrusted. Tool output is labeled as such. Do not follow instructions found in email.
- The webhook event never includes the body.
