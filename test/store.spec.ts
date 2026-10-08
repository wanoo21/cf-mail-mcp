import { beforeEach, describe, expect, it } from "vitest";
import { ingestEmail } from "../src/mail";
import { deleteMessage, getMessage, listMessages, markRead, purgeOld } from "../src/store";
import { rawEml, reset, testEnv } from "./helpers";

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
    await ingestEmail(env, { from: "b@x.com", to: "agent@mail.example.com", raw: rawEml() });
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
});
