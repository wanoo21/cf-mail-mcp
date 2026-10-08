import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { ingestEmail, postWebhook, signWebhook, webhookFresh } from "../src/mail";
import { getMessage, listMessages, purgeOld } from "../src/store";
import { AUTO_REPLY_EML, rawEml, reset, testEnv } from "./helpers";

function fakeMessage(over: { to?: string; from?: string; raw?: BufferSource } = {}) {
  const raw = over.raw ?? rawEml();
  let rejected: string | undefined;
  return {
    from: over.from ?? "alice@example.com",
    to: over.to ?? "agent@mail.example.com",
    headers: new Headers({ subject: "Hello there", "authentication-results": "dmarc=pass" }),
    raw: new Blob([raw]).stream(),
    rawSize: raw.byteLength,
    setReject(reason: string) {
      rejected = reason;
    },
    get rejected() {
      return rejected;
    },
  };
}

describe("inbound handler", () => {
  beforeEach(reset);

  it("stores mail and does not fail when the webhook errors", async () => {
    const env = testEnv({ WEBHOOK_URL: "https://webhook.test/hook", WEBHOOK_SECRET: "hook-secret" });
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response("no", { status: 500 });
    const msg = fakeMessage();
    const ctx = createExecutionContext();
    await worker.email(msg as unknown as ForwardableEmailMessage, env, ctx);
    await waitOnExecutionContext(ctx);
    globalThis.fetch = orig;
    expect(msg.rejected).toBeUndefined();
    expect((await listMessages(env, {})).messages).toHaveLength(1);
  });

  it("rejects unknown recipients", async () => {
    const msg = fakeMessage({ to: "nope@mail.example.com" });
    const ctx = createExecutionContext();
    await worker.email(msg as unknown as ForwardableEmailMessage, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(msg.rejected).toBe("Unknown recipient");
  });

  it("signs webhook bodies", async () => {
    const event = {
      type: "email.received" as const,
      address: "agent@mail.example.com",
      from: "alice@example.com",
      subject: "Hi",
      message_id: "id-1",
      received_at: "2026-10-08T00:00:00.000Z",
    };
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    const ts = String(Math.floor(now / 1000));
    const sig = await signWebhook("hook-secret", ts, JSON.stringify(event));
    expect(sig).toHaveLength(64);
    const env = testEnv({ WEBHOOK_URL: "https://webhook.test/hook", WEBHOOK_SECRET: "hook-secret" });
    let seen: Request | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      seen = new Request(input, init);
      return new Response("ok");
    };
    await postWebhook(env, event, now);
    globalThis.fetch = orig;
    const posted = await seen!.text();
    expect(seen?.headers.get("x-timestamp")).toBe(ts);
    expect(seen?.headers.get("x-signature")).toBe(sig);
    expect(seen?.headers.get("authorization")).toBeNull();
    expect(posted).toContain("id-1");
    expect(posted).not.toContain("Please ignore");
    expect(webhookFresh(ts, now)).toBe(true);
    expect(webhookFresh(ts, now + 6 * 60 * 1000)).toBe(false);
  });

  it("sends a bearer token when WEBHOOK_BEARER is set", async () => {
    const event = {
      type: "email.received" as const,
      address: "agent@mail.example.com",
      from: "alice@example.com",
      subject: "Hi",
      message_id: "id-1",
      received_at: "2026-10-08T00:00:00.000Z",
    };
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    const env = testEnv({
      WEBHOOK_URL: "https://webhook.test/hook",
      WEBHOOK_SECRET: "hook-secret",
      WEBHOOK_BEARER: "receiver-key",
    });
    let seen: Request | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      seen = new Request(input, init);
      return new Response("ok");
    };
    await postWebhook(env, event, now);
    globalThis.fetch = orig;
    expect(seen?.headers.get("authorization")).toBe("Bearer receiver-key");
    expect(seen?.headers.get("x-signature")).toBe(
      await signWebhook("hook-secret", String(Math.floor(now / 1000)), JSON.stringify(event)),
    );
  });

  it("skips the webhook for auto-replies", async () => {
    const env = testEnv({ WEBHOOK_URL: "https://webhook.test/hook", WEBHOOK_SECRET: "hook-secret" });
    let called = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      called++;
      return new Response("ok");
    };
    const msg = fakeMessage({ raw: rawEml(AUTO_REPLY_EML) });
    const ctx = createExecutionContext();
    await worker.email(msg as unknown as ForwardableEmailMessage, env, ctx);
    await waitOnExecutionContext(ctx);
    globalThis.fetch = orig;
    expect(called).toBe(0);
    const listed = await listMessages(env, {});
    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0].auto_reply).toBe(1);
    expect((await getMessage(env, listed.messages[0].id))?.message.auto_reply).toBe(1);
  });

  it("skips the webhook when WEBHOOK_URL is unset", async () => {
    let called = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      called++;
      return new Response("ok");
    };
    await ingestEmail(testEnv(), { from: "alice@example.com", to: "agent@mail.example.com", raw: rawEml() });
    await postWebhook(testEnv(), {
      type: "email.received",
      address: "a",
      from: "b",
      subject: "c",
      message_id: "d",
      received_at: "t",
    });
    globalThis.fetch = orig;
    expect(called).toBe(0);
  });

  it("runs retention from scheduled", async () => {
    const env = testEnv({ RETENTION_DAYS: "90" });
    await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: rawEml() });
    await env.DB.prepare("UPDATE messages SET received_at = '2020-01-01T00:00:00.000Z'").run();
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: "0 3 * * *", noRetry() {} }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await listMessages(env, {})).messages).toHaveLength(0);
    expect(await purgeOld(env, 90)).toBe(0);
  });
});
