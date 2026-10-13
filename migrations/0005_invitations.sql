-- Private beta: five independent invitation digests; no extra account system.
CREATE TABLE IF NOT EXISTS reminder_invitations (
  id TEXT PRIMARY KEY,
  code_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('available','reserved','bound','revoked')),
  email TEXT UNIQUE,
  reservation_until TEXT,
  code_expires_at TEXT NOT NULL,
  bound_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS reminder_invitations_five_people
BEFORE INSERT ON reminder_invitations
WHEN (SELECT COUNT(*) FROM reminder_invitations) >= 5
  AND NOT EXISTS(SELECT 1 FROM reminder_invitations WHERE id=NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'INVITATION_CAPACITY');
END;
ALTER TABLE reminders ADD COLUMN invitation_id TEXT REFERENCES reminder_invitations(id);
CREATE INDEX IF NOT EXISTS reminders_invitation ON reminders(invitation_id,status);
