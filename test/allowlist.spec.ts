import { beforeEach, describe, expect, it } from "vitest";
import { ingestEmail, replyTo, sendMail } from "../src/mail";
import { canSendTo, isOurAddress } from "../src/util";
import { getMessage, logSend } from "../src/store";
import { rawEml, reset, testEnv } from "./helpers";

describe("allowlist and cap", () => {
  beforeEach(reset);

  it("accepts only the configured address", () => {
    const env = testEnv();
    expect(isOurAddress(env, "agent@mail.example.com")).toBe(true);
    expect(isOurAddress(env, "AGENT@mail.example.com")).toBe(true);
    expect(isOurAddress(env, "other@mail.example.com")).toBe(false);
  });

  it("rejects inbound for an unknown recipient", async () => {
    const r = await ingestEmail(testEnv(), {
      from: "alice@example.com",
      to: "other@mail.example.com",
      raw: rawEml(),
    });
    expect(r).toEqual({ reject: "Unknown recipient" });
  });

  it("only sends to allowlisted recipients", async () => {
    const env = testEnv();
    expect(canSendTo(env, "owner@example.com")).toBe(true);
    expect(canSendTo(env, "stranger@example.com")).toBe(false);
    const denied = await sendMail(env, { to: "stranger@example.com", subject: "x", text: "hi" });
    expect(denied).toEqual({ error: "recipient not allowed: stranger@example.com" });
    const ok = await sendMail(env, { to: "owner@example.com", subject: "x", text: "hi" });
    expect("messageId" in ok).toBe(true);
  });

  it("enforces the daily send cap", async () => {
    const env = testEnv({ DAILY_SEND_CAP: "2" });
    const now = Date.parse("2026-10-08T15:00:00.000Z");
    await logSend(env, "2026-10-08T01:00:00.000Z");
    await logSend(env, "2026-10-08T02:00:00.000Z");
    const r = await sendMail(env, { to: "owner@example.com", subject: "x", text: "hi" }, now);
    expect(r).toEqual({ error: "daily send cap reached (2)" });
  });

  it("threads replies with In-Reply-To and References", async () => {
    const env = testEnv({ ALLOWED_RECIPIENTS: "alice@example.com" });
    const sent: unknown[] = [];
    env.EMAIL = {
      async send(msg) {
        sent.push(msg);
        return { messageId: "out-1" };
      },
    };
    const r = await ingestEmail(env, { from: "alice@example.com", to: "agent@mail.example.com", raw: rawEml() });
    if (!("id" in r)) throw new Error("ingest");
    const row = await getMessage(env, r.id);
    const out = await replyTo(env, row!.message, "thanks");
    expect(out).toEqual({ messageId: "out-1" });
    expect(sent[0]).toMatchObject({
      to: "alice@example.com",
      from: "agent@mail.example.com",
      subject: "Re: Hello there",
      text: "thanks",
      headers: {
        "In-Reply-To": "<abc@example.com>",
        References: "<root@example.com> <prev@example.com> <abc@example.com>",
      },
    });
  });
});
