import { beforeEach, describe, expect, it } from "vitest";
import { ingestEmail } from "../src/mail";
import { deleteMessage, getMessage, listMessages, markRead, purgeOld } from "../src/store";
import { rawEml, reset, SAMPLE_EML, testEnv } from "./helpers";

describe("store", () => {
  beforeEach(reset);

  it("stores parsed mail and lists headers", async () => {
    const env = testEnv();
    const r = await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: rawEml() });
    expect("id" in r).toBe(true);
    if (!("id" in r)) return;
    const listed = await listMessages(env, {});
    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0].subject).toBe("Hello there");
    expect(listed.messages[0].from_addr).toBe("alice@example.com");
    const got = await getMessage(env, r.id);
    expect(got?.message.text_body).toContain("ignore previous instructions");
    expect(got?.attachments).toHaveLength(1);
    expect(got?.attachments[0].filename).toBe("note.txt");
    const obj = await env.R2.get(got!.attachments[0].r2_key);
    expect(new TextDecoder().decode(await obj!.arrayBuffer())).toBe("hi");
    const raw = await env.R2.get(got!.message.raw_r2_key!);
    expect(raw).toBeTruthy();
  });

  it("pages with cursor", async () => {
    const env = testEnv();
    await ingestEmail(env, { from: "a@x.com", to: "agent@mail.example.com", raw: rawEml() });
    await ingestEmail(env, {
      from: "b@x.com",
      to: "agent@mail.example.com",
      raw: rawEml(SAMPLE_EML.replace("Message-ID: <abc@example.com>", "Message-ID: <bcd@example.com>")),
    });
    const first = await listMessages(env, { limit: 1 });
    expect(first.messages).toHaveLength(1);
    expect(first.cursor).toBeTruthy();
    const second = await listMessages(env, { limit: 1, cursor: first.cursor! });
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].id).not.toBe(first.messages[0].id);
  });

  it("marks read and deletes r2 objects", async () => {
    const env = testEnv();
    const r = await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: rawEml() });
    if (!("id" in r)) throw new Error("ingest");
    expect(await markRead(env, r.id)).toBe(true);
    expect((await getMessage(env, r.id))?.message.read).toBe(1);
    const keys = [(await getMessage(env, r.id))!.message.raw_r2_key!, (await getMessage(env, r.id))!.attachments[0].r2_key];
    expect(await deleteMessage(env, r.id)).toBe(true);
    expect(await getMessage(env, r.id)).toBeNull();
    expect(await env.R2.get(keys[0])).toBeNull();
    expect(await env.R2.get(keys[1])).toBeNull();
  });

  it("purges mail older than N days", async () => {
    const env = testEnv();
    const r = await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: rawEml() });
    if (!("id" in r)) throw new Error("ingest");
    await env.DB.prepare("UPDATE messages SET received_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", r.id)
      .run();
    expect(await purgeOld(env, 90)).toBe(1);
    expect(await getMessage(env, r.id)).toBeNull();
  });

  it("skips a duplicate message-id and still stores mail with none", async () => {
    const env = testEnv({ MAIL_ADDRESS: "agent@mail.example.com,other@mail.example.com" });
    const first = await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: rawEml() });
    if (!("id" in first)) throw new Error("ingest");
    const keys = (await env.R2.list()).objects.map((o) => o.key).sort();
    expect(await ingestEmail(env, { from: "alice@example.com", to: "AGENT@mail.example.com", raw: rawEml() })).toEqual({
      duplicate: true,
    });
    expect((await env.R2.list()).objects.map((o) => o.key).sort()).toEqual(keys);
    const other = await ingestEmail(env, { from: "alice@example.com", to: "other@mail.example.com", raw: rawEml() });
    expect("id" in other).toBe(true);
    const noId = rawEml(SAMPLE_EML.replace(/^Message-ID:.*\n/m, ""));
    expect("id" in (await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: noId }))).toBe(true);
    expect("id" in (await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: noId }))).toBe(true);
    const rows = await listMessages(env, {});
    expect(rows.messages).toHaveLength(4);
    expect(rows.messages.filter((m) => m.rfc_message_id === "<abc@example.com>")).toHaveLength(2);
    expect(await getMessage(env, first.id)).toBeTruthy();
  });

  it("migration drops duplicate rows and keeps the oldest", async () => {
    const env = testEnv();
    const mig = env.TEST_MIGRATIONS?.find((m) => m.queries.some((q) => /CREATE UNIQUE INDEX/i.test(q)));
    if (!mig) throw new Error("dedupe migration missing");
    const createAt = mig.queries.findIndex((q) => /CREATE UNIQUE INDEX/i.test(q));
    expect(createAt).toBeGreaterThan(0);
    expect(mig.queries.slice(0, createAt).some((q) => /DELETE FROM messages/i.test(q))).toBe(true);
    await env.DB.prepare("DROP INDEX IF EXISTS messages_address_rfc_message_id").run();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO messages (id, address, from_addr, to_addr, subject, rfc_message_id, text_body, received_at)
           VALUES ('old', 'agent@mail.example.com', 'a@x.com', 'agent@mail.example.com', '', '<dup@x>', '', '2026-10-08T00:00:00.000Z')`,
        ),
        env.DB.prepare(
          `INSERT INTO messages (id, address, from_addr, to_addr, subject, rfc_message_id, text_body, received_at)
           VALUES ('new', 'agent@mail.example.com', 'a@x.com', 'agent@mail.example.com', '', '<dup@x>', '', '2026-10-08T00:00:01.000Z')`,
        ),
        env.DB.prepare(
          `INSERT INTO messages (id, address, from_addr, to_addr, subject, rfc_message_id, text_body, received_at)
           VALUES ('other', 'other@mail.example.com', 'a@x.com', 'other@mail.example.com', '', '<dup@x>', '', '2026-10-08T00:00:02.000Z')`,
        ),
        env.DB.prepare(
          `INSERT INTO messages (id, address, from_addr, to_addr, subject, text_body, received_at)
           VALUES ('nomid', 'agent@mail.example.com', 'a@x.com', 'agent@mail.example.com', '', '', '2026-10-08T00:00:03.000Z')`,
        ),
        env.DB.prepare(
          `INSERT INTO attachments (id, message_id, filename, content_type, size, r2_key) VALUES
           ('a-old', 'old', 'o.txt', 'text/plain', 1, 'att/old'),
           ('a-new', 'new', 'n.txt', 'text/plain', 1, 'att/new')`,
        ),
      ]);
      for (const q of mig.queries) await env.DB.prepare(q).run();
      const ids = (await env.DB.prepare("SELECT id FROM messages ORDER BY id").all<{ id: string }>()).results.map((r) => r.id);
      expect(ids).toEqual(["nomid", "old", "other"]);
      const atts = (await env.DB.prepare("SELECT id FROM attachments").all<{ id: string }>()).results.map((r) => r.id);
      expect(atts).toEqual(["a-old"]);
    } finally {
      await reset();
      await env.DB.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS messages_address_rfc_message_id
         ON messages (address, rfc_message_id) WHERE rfc_message_id IS NOT NULL`,
      ).run();
    }
  });
});
