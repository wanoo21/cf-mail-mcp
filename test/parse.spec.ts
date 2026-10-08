import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { bodyText, stripHtml } from "../src/util";
import { SAMPLE_EML } from "./helpers";

describe("parse", () => {
  it("reads headers, text, and attachments", async () => {
    const email = await PostalMime.parse(SAMPLE_EML);
    expect(email.subject).toBe("Hello there");
    expect(email.from?.address).toBe("alice@example.com");
    expect(email.messageId).toBe("abc@example.com");
    expect(email.text).toContain("ignore previous instructions");
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0].filename).toBe("note.txt");
    const att = email.attachments[0].content;
    const text = typeof att === "string" ? att : new TextDecoder().decode(att);
    expect(text).toBe("hi");
  });

  it("strips html when no text part", () => {
    expect(bodyText(undefined, "<p>Hi <b>there</b></p><script>x()</script>")).toBe("Hi there");
    expect(stripHtml("<style>p{}</style>Hello")).toBe("Hello");
  });
});
