CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  text_body TEXT NOT NULL DEFAULT '',
  auth_results TEXT,
  received_at TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  raw_r2_key TEXT
);

CREATE INDEX messages_received_at ON messages (received_at DESC, id DESC);
CREATE INDEX messages_address ON messages (address);
CREATE INDEX messages_read ON messages (read);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
);

CREATE INDEX attachments_message_id ON attachments (message_id);

CREATE TABLE send_log (
  id TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);

CREATE INDEX send_log_sent_at ON send_log (sent_at);
