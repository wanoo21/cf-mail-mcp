import { ingestEmail, postWebhook } from "./mail";
import { mcpFetch, serveAttachment } from "./mcp";
import { purgeOld } from "./store";
import { equalSecret, retentionDays } from "./util";

async function authorized(request: Request, env: Env) {
  const token = env.MCP_TOKEN;
  if (!token) return false;
  const hdr = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  return !!m && (await equalSecret(m[1], token));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/a/")) return serveAttachment(request, env);
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    if (!(await authorized(request, env))) return new Response("unauthorized", { status: 401 });
    return mcpFetch(request, env, ctx);
  },

  async email(message, env, ctx) {
    if (message.rawSize > 25 * 1024 * 1024) {
      message.setReject("Message too large");
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    const result = await ingestEmail(env, {
      from: message.from,
      to: message.to,
      raw,
      authResults: message.headers.get("authentication-results"),
    });
    if ("reject" in result) {
      message.setReject(result.reject);
      return;
    }
    const stored = await env.DB.prepare("SELECT address, from_addr, subject, received_at FROM messages WHERE id = ?")
      .bind(result.id)
      .first<{ address: string; from_addr: string; subject: string; received_at: string }>();
    if (stored && !result.auto_reply) {
      ctx.waitUntil(
        postWebhook(env, {
          type: "email.received",
          address: stored.address,
          from: stored.from_addr,
          subject: stored.subject,
          message_id: result.id,
          received_at: stored.received_at,
        }).catch((err) => console.error("webhook", err)),
      );
    }
  },

  async scheduled(_event, env, _ctx) {
    await purgeOld(env, retentionDays(env));
  },
} satisfies ExportedHandler<Env>;
