interface SendEmail {
  send(message: {
    to: string | string[];
    from: string;
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
    attachments?: {
      content: string;
      filename: string;
      type: string;
      disposition: "attachment" | "inline";
    }[];
  }): Promise<{ messageId: string }>;
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    R2: R2Bucket;
    EMAIL: SendEmail;
    MAIL_ADDRESS: string;
    ALLOWED_RECIPIENTS: string;
    RETENTION_DAYS?: string;
    DAILY_SEND_CAP?: string;
    MCP_TOKEN: string;
    WEBHOOK_URL?: string;
    WEBHOOK_SECRET?: string;
  }
}

type Env = Cloudflare.Env;
