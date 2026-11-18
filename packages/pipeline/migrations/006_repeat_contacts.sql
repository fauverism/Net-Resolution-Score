-- Return contacts capped at passive (reason repeat_contact) by each link run.
ALTER TABLE link_runs ADD COLUMN repeat_contacts INTEGER NOT NULL DEFAULT 0;
