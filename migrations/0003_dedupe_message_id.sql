DELETE FROM attachments
WHERE message_id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY address, rfc_message_id
             ORDER BY received_at ASC, id ASC
           ) AS n
    FROM messages
    WHERE rfc_message_id IS NOT NULL
  )
  WHERE n > 1
);

DELETE FROM messages
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY address, rfc_message_id
             ORDER BY received_at ASC, id ASC
           ) AS n
    FROM messages
    WHERE rfc_message_id IS NOT NULL
  )
  WHERE n > 1
);

CREATE UNIQUE INDEX messages_address_rfc_message_id
ON messages (address, rfc_message_id)
WHERE rfc_message_id IS NOT NULL;
