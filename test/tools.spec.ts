import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { ingestEmail } from "../src/mail";
import { attachmentUrl, createMailServer, serveAttachment } from "../src/mcp";
import { deleteMessage, getMessage, listMessages, markRead } from "../src/store";
import { UNTRUSTED, untrusted } from "../src/util";
import { rawEml, reset, testEnv } from "./helpers";

describe("tools", () => {
  beforeEach(reset);

  it("lists, reads, marks, and deletes", async () => {
    const env = testEnv();
    const r = await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: rawEml() });
    if (!("id" in r)) throw new Error("ingest");
    const listed = untrusted(await listMessages(env, { unread: true }));
    expect(listed.warning).toBe(UNTRUSTED);
    expect(listed.messages).toHaveLength(1);
    const got = await getMessage(env, r.id);
    expect(got?.message.text_body).toContain("ignore previous instructions");
    expect(untrusted({ text: got!.message.text_body }).warning).toBe(UNTRUSTED);
    expect(await markRead(env, r.id)).toBe(true);
    expect((await listMessages(env, { unread: true })).messages).toHaveLength(0);
    expect(await deleteMessage(env, r.id)).toBe(true);
  });

  it("builds a signed attachment link", async () => {
    const env = testEnv();
    const r = await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: rawEml() });
    if (!("id" in r)) throw new Error("ingest");
    const att = (await getMessage(env, r.id))!.attachments[0];
    const url = await attachmentUrl(env, "https://mail.example", att.id);
    const res = await serveAttachment(new Request(url), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
    const bad = new URL(url);
    bad.searchParams.set("s", "00".repeat(32));
    expect((await serveAttachment(new Request(bad), env)).status).toBe(403);
  });

  it("registers the six tools", () => {
    const server = createMailServer(testEnv(), "https://mail.example");
    expect(server).toBeTruthy();
  });
});

describe("worker fetch", () => {
  it("rejects /mcp without a bearer token", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://example.com/mcp"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://example.com/mcp", { headers: { authorization: "Bearer nope" } }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
