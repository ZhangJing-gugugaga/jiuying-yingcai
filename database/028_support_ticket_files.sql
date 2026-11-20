CREATE TABLE support_ticket_files (
  file_id TEXT PRIMARY KEY REFERENCES files(id),
  ticket_id TEXT REFERENCES supportTickets(id)
);

CREATE INDEX support_ticket_files_ticket
  ON support_ticket_files(ticket_id)
  WHERE ticket_id IS NOT NULL;
