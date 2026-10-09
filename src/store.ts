export type MessageRow = {
  id: string;
  address: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  text_body: string;
  auth_results: string | null;
  received_at: string;
  read: number;
  auto_reply: number;
  raw_r2_key: string | null;
};

export type AttachmentRow = {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
};

export type ListFilter = {
  unread?: boolean;
  since?: string;
  from?: string;
  address?: string;
  limit?: number;
  cursor?: string;
};

export async function insertMessage(
  env: Env,
  row: MessageRow,
  raw: BufferSource,
  files: { id: string; filename: string; content_type: string; content: BufferSource }[],
) {
  const inserted = await env.DB.prepare(
    `INSERT INTO messages (id, address, from_addr, to_addr, subject, rfc_message_id, in_reply_to, references_header, text_body, auth_results, received_at, read, auto_reply, raw_r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(address, rfc_message_id) WHERE rfc_message_id IS NOT NULL DO NOTHING`,
  )
    .bind(
      row.id,
      row.address,
      row.from_addr,
      row.to_addr,
      row.subject,
      row.rfc_message_id,
      row.in_reply_to,
      row.references_header,
      row.text_body,
      row.auth_results,
      row.received_at,
      row.auto_reply,
      row.raw_r2_key,
    )
    .run();
  if (!inserted.meta.changes) return false;
  if (row.raw_r2_key) await env.R2.put(row.raw_r2_key, raw);
  for (const f of files) {
    const r2_key = `att/${row.id}/${f.id}/${f.filename}`;
    await env.R2.put(r2_key, f.content);
    await env.DB.prepare(
      `INSERT INTO attachments (id, message_id, filename, content_type, size, r2_key) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(f.id, row.id, f.filename, f.content_type, f.content.byteLength, r2_key)
      .run();
  }
  return true;
}

export function parseCursor(cursor?: string) {
  if (!cursor) return null;
  const i = cursor.indexOf("|");
  if (i < 0) return null;
  return { received_at: cursor.slice(0, i), id: cursor.slice(i + 1) };
}

export async function listMessages(env: Env, f: ListFilter) {
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 100);
  const cur = parseCursor(f.cursor);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.unread) where.push("read = 0");
  if (f.since) {
    where.push("received_at >= ?");
    binds.push(f.since);
  }
  if (f.from) {
    where.push("from_addr = ?");
    binds.push(f.from);
  }
  if (f.address) {
    where.push("address = ?");
    binds.push(f.address);
  }
  if (cur) {
    where.push("(received_at < ? OR (received_at = ? AND id < ?))");
    binds.push(cur.received_at, cur.received_at, cur.id);
  }
  const sql = `SELECT id, address, from_addr, to_addr, subject, rfc_message_id, received_at, read, auto_reply
    FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY received_at DESC, id DESC LIMIT ?`;
  const rows = await env.DB.prepare(sql)
    .bind(...binds, limit + 1)
    .all<Pick<MessageRow, "id" | "address" | "from_addr" | "to_addr" | "subject" | "rfc_message_id" | "received_at" | "read" | "auto_reply">>();
  const extra = rows.results.length > limit;
  const page = extra ? rows.results.slice(0, limit) : rows.results;
  const last = page[page.length - 1];
  return {
    messages: page,
    cursor: extra && last ? `${last.received_at}|${last.id}` : null,
  };
}

export async function getMessage(env: Env, id: string) {
  const msg = await env.DB.prepare("SELECT * FROM messages WHERE id = ?")
    .bind(id)
    .first<MessageRow>();
  if (!msg) return null;
  const atts = await env.DB.prepare("SELECT * FROM attachments WHERE message_id = ?")
    .bind(id)
    .all<AttachmentRow>();
  return { message: msg, attachments: atts.results };
}

export async function getAttachment(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first<AttachmentRow>();
}

export async function markRead(env: Env, id: string, read = true) {
  const r = await env.DB.prepare("UPDATE messages SET read = ? WHERE id = ?").bind(read ? 1 : 0, id).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function deleteMessage(env: Env, id: string) {
  const row = await getMessage(env, id);
  if (!row) return false;
  if (row.message.raw_r2_key) await env.R2.delete(row.message.raw_r2_key);
  for (const a of row.attachments) await env.R2.delete(a.r2_key);
  await env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
  return true;
}

export async function purgeOld(env: Env, days: number, now = Date.now()) {
  const cutoff = new Date(now - days * 86400000).toISOString();
  const rows = await env.DB.prepare("SELECT id FROM messages WHERE received_at < ?")
    .bind(cutoff)
    .all<{ id: string }>();
  for (const r of rows.results) await deleteMessage(env, r.id);
  await env.DB.prepare("DELETE FROM send_log WHERE sent_at < ?").bind(cutoff).run();
  return rows.results.length;
}

export async function sentToday(env: Env, now = Date.now()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM send_log WHERE sent_at >= ?")
    .bind(start.toISOString())
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function logSend(env: Env, at = new Date().toISOString()) {
  await env.DB.prepare("INSERT INTO send_log (id, sent_at) VALUES (?, ?)").bind(crypto.randomUUID(), at).run();
}
