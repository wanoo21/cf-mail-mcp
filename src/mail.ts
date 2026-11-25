import { isAutoReplyEmail } from "agents/email";
import PostalMime, { type Address } from "postal-mime";
import {
  bodyText,
  canSendTo,
  dailySendCap,
  hmacHex,
  isOurAddress,
  norm,
  ourAddresses,
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
    to_header: listAddrs(parsed.to).join(", "),
    cc_header: listAddrs(parsed.cc).join(", "),
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
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; type: string; content_base64: string }[];
};

function listAddrs(list?: Address[]) {
  const out: string[] = [];
  for (const a of list ?? []) {
    if (a.group) {
      for (const g of a.group) if (g.address) out.push(g.address);
    } else if (a.address) out.push(a.address);
  }
  return out;
}

function splitAddrs(s: string | null) {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function addrInput(v?: string | string[]) {
  return (v == null ? [] : Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
}

function dedupe(lists: string[][]) {
  const seen = new Set<string>();
  return lists.map((xs) => {
    const out: string[] = [];
    for (const x of xs) {
      const n = norm(x);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(x);
    }
    return out;
  });
}

function one(xs: string[]) {
  return xs.length === 1 ? xs[0] : xs;
}

export async function sendMail(
  env: Env,
  input: SendInput,
  now = Date.now(),
): Promise<{ messageId: string } | { error: string }> {
  const from = sendFrom(env);
  if (!from) return { error: "MAIL_ADDRESS is not set" };
  const [to, cc, bcc] = dedupe([addrInput(input.to), addrInput(input.cc), addrInput(input.bcc)]);
  if (!to.length) return { error: "to is required" };
  const all = [...to, ...cc, ...bcc];
  if (all.length > 50) return { error: "max 50 recipients" };
  const denied = all.filter((r) => !canSendTo(env, r));
  if (denied.length) return { error: `recipient not allowed: ${denied.join(", ")}` };
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
    to: one(to),
    cc: cc.length ? one(cc) : undefined,
    bcc: bcc.length ? one(bcc) : undefined,
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

async function threadRecipients(env: Env, original: Pick<MessageRow, "to_header" | "cc_header" | "raw_r2_key">) {
  if (original.to_header != null || original.cc_header != null) {
    return { to: splitAddrs(original.to_header), cc: splitAddrs(original.cc_header) };
  }
  if (!original.raw_r2_key) return { to: [], cc: [] };
  const obj = await env.R2.get(original.raw_r2_key);
  if (!obj) return { to: [], cc: [] };
  const parsed = await PostalMime.parse(await obj.arrayBuffer());
  return { to: listAddrs(parsed.to), cc: listAddrs(parsed.cc) };
}

export async function replyTo(
  env: Env,
  original: Pick<MessageRow, "from_addr" | "subject" | "rfc_message_id" | "references_header" | "to_header" | "cc_header" | "raw_r2_key">,
  text: string,
  html?: string,
  extra?: { cc?: string | string[]; bcc?: string | string[]; reply_all?: boolean },
  now = Date.now(),
) {
  const headers: Record<string, string> = {};
  if (original.rfc_message_id) {
    headers["In-Reply-To"] = original.rfc_message_id;
    const refs = threadReferences(original.references_header, original.rfc_message_id);
    if (refs) headers.References = refs;
  }
  let cc = extra?.cc;
  if (extra?.reply_all) {
    const orig = await threadRecipients(env, original);
    const ours = new Set(ourAddresses(env));
    const built = [...orig.to, ...orig.cc].filter((a) => !ours.has(norm(a)));
    cc = [...built, ...addrInput(extra.cc)];
  }
  return sendMail(
    env,
    {
      to: original.from_addr,
      cc,
      bcc: extra?.bcc,
      subject: replySubject(original.subject),
      text,
      html,
      headers,
    },
    now,
  );
}
