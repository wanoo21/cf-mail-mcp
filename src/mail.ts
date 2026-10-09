import { isAutoReplyEmail } from "agents/email";
import PostalMime from "postal-mime";
import {
  bodyText,
  canSendTo,
  dailySendCap,
  hmacHex,
  isOurAddress,
  replySubject,
  sendFrom,
  threadReferences,
} from "./util";
import { insertMessage, logSend, sentToday, type MessageRow } from "./store";

export type IngestResult = { id: string; auto_reply: boolean } | { duplicate: true } | { reject: string };

export async function ingestEmail(
  env: Env,
  input: { from: string; to: string; raw: BufferSource; authResults?: string | null },
): Promise<IngestResult> {
  if (!isOurAddress(env, input.to)) return { reject: "Unknown recipient" };
  const parsed = await PostalMime.parse(input.raw);
  const auto_reply = isAutoReplyEmail(parsed.headers ?? []);
  const id = crypto.randomUUID();
  const received_at = new Date().toISOString();
  const row: MessageRow = {
    id,
    address: input.to.trim().toLowerCase(),
    from_addr: parsed.from?.address ?? input.from,
    to_addr: input.to,
    subject: parsed.subject ?? "",
    rfc_message_id: parsed.messageId || null,
    in_reply_to: parsed.inReplyTo ?? null,
    references_header: Array.isArray(parsed.references)
      ? parsed.references.join(" ")
      : (parsed.references ?? null),
    text_body: bodyText(parsed.text, parsed.html),
    auth_results: input.authResults ?? null,
    received_at,
    read: 0,
    auto_reply: auto_reply ? 1 : 0,
    raw_r2_key: `raw/${id}.eml`,
  };
  const files = (parsed.attachments ?? [])
    .filter((a) => a.content)
    .map((a) => ({
      id: crypto.randomUUID(),
      filename: a.filename || "attachment",
      content_type: a.mimeType || "application/octet-stream",
      content: typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content,
    }));
  if (!(await insertMessage(env, row, input.raw, files))) return { duplicate: true };
  return { id, auto_reply };
}

export type WebhookEvent = {
  type: "email.received";
  address: string;
  from: string;
  subject: string;
  message_id: string;
  received_at: string;
};

export async function signWebhook(secret: string, timestamp: string, body: string) {
  return hmacHex(secret, `${timestamp}.${body}`);
}

export function webhookFresh(timestamp: string, now = Date.now(), maxAgeSec = 300) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(now / 1000 - ts) <= maxAgeSec;
}

export async function postWebhook(env: Env, event: WebhookEvent, now = Date.now()) {
  const url = env.WEBHOOK_URL?.trim();
  if (!url) return;
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(now / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-timestamp": timestamp,
  };
  const secret = env.WEBHOOK_SECRET?.trim();
  if (secret) headers["x-signature"] = await signWebhook(secret, timestamp, body);
  const bearer = env.WEBHOOK_BEARER?.trim();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

export type SendInput = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; type: string; content_base64: string }[];
};

export async function sendMail(
  env: Env,
  input: SendInput,
  now = Date.now(),
): Promise<{ messageId: string } | { error: string }> {
  const from = sendFrom(env);
  if (!from) return { error: "MAIL_ADDRESS is not set" };
  const recipients = (Array.isArray(input.to) ? input.to : [input.to]).map((t) => t.trim()).filter(Boolean);
  if (!recipients.length) return { error: "to is required" };
  if (recipients.length > 50) return { error: "max 50 recipients" };
  for (const r of recipients) {
    if (!canSendTo(env, r)) return { error: `recipient not allowed: ${r}` };
  }
  const cap = dailySendCap(env);
  if ((await sentToday(env, now)) >= cap) return { error: `daily send cap reached (${cap})` };
  let bytes = new TextEncoder().encode(input.text).length + new TextEncoder().encode(input.html ?? "").length;
  const attachments = (input.attachments ?? []).map((a) => {
    bytes += Math.floor((a.content_base64.length * 3) / 4);
    return {
      content: a.content_base64,
      filename: a.filename,
      type: a.type || "application/octet-stream",
      disposition: "attachment" as const,
    };
  });
  if (bytes > 5 * 1024 * 1024) return { error: "message exceeds 5 MiB" };
  const result = await env.EMAIL.send({
    to: recipients.length === 1 ? recipients[0] : recipients,
    from,
    subject: input.subject,
    text: input.text,
    html: input.html,
    headers: input.headers,
    attachments: attachments.length ? attachments : undefined,
  });
  await logSend(env, new Date(now).toISOString());
  return { messageId: result.messageId };
}

export async function replyTo(
  env: Env,
  original: Pick<MessageRow, "from_addr" | "subject" | "rfc_message_id" | "references_header">,
  text: string,
  html?: string,
  now = Date.now(),
) {
  const headers: Record<string, string> = {};
  if (original.rfc_message_id) {
    headers["In-Reply-To"] = original.rfc_message_id;
    const refs = threadReferences(original.references_header, original.rfc_message_id);
    if (refs) headers.References = refs;
  }
  return sendMail(
    env,
    {
      to: original.from_addr,
      subject: replySubject(original.subject),
      text,
      html,
      headers,
    },
    now,
  );
}
