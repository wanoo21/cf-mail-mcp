import { beforeEach, describe, expect, it } from "vitest";
import { ingestEmail, replyTo, sendMail } from "../src/mail";
import { canSendTo, isOurAddress, recipientPolicy } from "../src/util";
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

  it("classifies recipient policy", () => {
    expect(recipientPolicy(testEnv()).mode).toBe("exact");
    expect(recipientPolicy(testEnv({ ALLOWED_RECIPIENTS: "*" })).mode).toBe("*");
    expect(recipientPolicy(testEnv({ ALLOWED_RECIPIENTS: "@example.com" })).mode).toBe("domains");
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

  it("opens sending when ALLOWED_RECIPIENTS is *", async () => {
    const env = testEnv({ ALLOWED_RECIPIENTS: "*" });
    env.EMAIL = { async send() { return { messageId: "cf-test" }; } };
    expect(canSendTo(env, "stranger@elsewhere.com")).toBe(true);
    const ok = await sendMail(env, { to: "stranger@elsewhere.com", subject: "x", text: "hi" });
    expect("messageId" in ok).toBe(true);
  });

  it("matches @domain and *@domain exactly, mixed with addresses", () => {
    const env = testEnv({ ALLOWED_RECIPIENTS: "alice@x.com,@example.com,*@other.com" });
    expect(canSendTo(env, "alice@x.com")).toBe(true);
    expect(canSendTo(env, "ALICE@x.com")).toBe(true);
    expect(canSendTo(env, "bob@x.com")).toBe(false);
    expect(canSendTo(env, "anyone@example.com")).toBe(true);
    expect(canSendTo(env, "anyone@sub.example.com")).toBe(false);
    expect(canSendTo(env, "anyone@other.com")).toBe(true);
    expect(canSendTo(env, "anyone@sub.other.com")).toBe(false);
    expect(canSendTo(env, "nobody@nope.com")).toBe(false);
  });

  it("still caps and limits recipients in open mode", async () => {
    const env = testEnv({ ALLOWED_RECIPIENTS: "*", DAILY_SEND_CAP: "1" });
    env.EMAIL = { async send() { return { messageId: "cf-test" }; } };
    const now = Date.parse("2026-10-08T15:00:00.000Z");
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
    expect(await sendMail(env, { to: many, subject: "x", text: "hi" }, now)).toEqual({
      error: "max 50 recipients",
    });
    expect("messageId" in (await sendMail(env, { to: "a@b.com", subject: "x", text: "hi" }, now))).toBe(true);
    expect(await sendMail(env, { to: "c@d.com", subject: "x", text: "hi" }, now)).toEqual({
      error: "daily send cap reached (1)",
    });
  });

  it("enforces the daily send cap", async () => {
    const env = testEnv({ DAILY_SEND_CAP: "2" });
    const now = Date.parse("2026-10-08T15:00:00.000Z");
    await logSend(env, "2026-10-08T01:00:00.000Z");
    await logSend(env, "2026-10-08T02:00:00.000Z");
    const r = await sendMail(env, { to: "owner@example.com", subject: "x", text: "hi" }, now);
    expect(r).toEqual({ error: "daily send cap reached (2)" });
  });

  it("sends from a chosen mailbox address", async () => {
    const env = testEnv({ MAIL_ADDRESS: "agent@mail.example.com,other@mail.example.com" });
    const sent: { from?: string }[] = [];
    env.EMAIL = {
      async send(msg) {
        sent.push(msg);
        return { messageId: "out-from" };
      },
    };
    expect(await sendMail(env, { to: "owner@example.com", from: "Other@mail.example.com", subject: "x", text: "hi" })).toEqual({
      messageId: "out-from",
    });
    expect(sent[0]?.from).toBe("other@mail.example.com");
    expect(await sendMail(env, { to: "owner@example.com", from: "nope@mail.example.com", subject: "x", text: "hi" })).toEqual({
      error: "from is not a mailbox address",
    });
    expect("messageId" in (await sendMail(env, { to: "owner@example.com", subject: "x", text: "hi" }))).toBe(true);
    expect(sent[1]?.from).toBe("agent@mail.example.com");
  });

  it("replies from the address the message was delivered to", async () => {
    const env = testEnv({
      MAIL_ADDRESS: "agent@mail.example.com,other@mail.example.com",
      ALLOWED_RECIPIENTS: "alice@example.com",
    });
    const sent: { from?: string }[] = [];
    env.EMAIL = {
      async send(msg) {
        sent.push(msg);
        return { messageId: "out-reply" };
      },
    };
    const r = await ingestEmail(env, { from: "alice@example.com", to: "Other@mail.example.com", raw: rawEml() });
    if (!("id" in r)) throw new Error("ingest");
    const out = await replyTo(env, (await getMessage(env, r.id))!.message, "thanks");
    expect(out).toEqual({ messageId: "out-reply" });
    expect(sent[0]?.from).toBe("other@mail.example.com");
  });

  it("replies from the default when the stored address is not ours", async () => {
    const env = testEnv({
      MAIL_ADDRESS: "agent@mail.example.com,other@mail.example.com",
      ALLOWED_RECIPIENTS: "alice@example.com",
    });
    const sent: { from?: string }[] = [];
    env.EMAIL = {
      async send(msg) {
        sent.push(msg);
        return { messageId: "out-default" };
      },
    };
    await replyTo(
      env,
      {
        address: "gone@mail.example.com",
        to_addr: "gone@mail.example.com",
        from_addr: "alice@example.com",
        subject: "Hello",
        rfc_message_id: null,
        references_header: null,
      },
      "thanks",
    );
    expect(sent[0]?.from).toBe("agent@mail.example.com");
    await replyTo(
      env,
      {
        address: "gone@mail.example.com",
        to_addr: "other@mail.example.com",
        from_addr: "alice@example.com",
        subject: "Hello",
        rfc_message_id: null,
        references_header: null,
      },
      "thanks",
    );
    expect(sent[1]?.from).toBe("other@mail.example.com");
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
