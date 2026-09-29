CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('student', 'legacy')),
  cooldown_until INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_until >= 0),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX accounts_identity ON accounts(issuer, subject);

ALTER TABLE sessions ADD account_id TEXT REFERENCES accounts(id);
ALTER TABLE orders ADD account_id TEXT REFERENCES accounts(id);
ALTER TABLE checkout_queue ADD account_id TEXT REFERENCES accounts(id);

-- Preserve anonymous demo history without claiming it belongs to a student.
INSERT INTO accounts (id, issuer, subject, kind, cooldown_until, created_at)
SELECT id, 'legacy-demo', id, 'legacy',
  COALESCE((SELECT MAX(created_at) + 3600000 FROM orders WHERE session_id = sessions.id), 0), created_at
FROM sessions;
UPDATE sessions SET account_id = id;
UPDATE orders SET account_id = session_id;
UPDATE checkout_queue SET account_id = session_id;
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX orders_account_created ON orders(account_id, created_at);
CREATE UNIQUE INDEX orders_account_request ON orders(account_id, request_key);
CREATE UNIQUE INDEX checkout_queue_account_request ON checkout_queue(account_id, request_key);

-- Retain the earliest legacy pending checkout; keep superseded rows for audit.
UPDATE checkout_queue SET status = 'cancelled'
WHERE status IN ('pending', 'held') AND sequence NOT IN (
  SELECT MIN(sequence) FROM checkout_queue WHERE status IN ('pending', 'held') GROUP BY account_id
);
DROP INDEX checkout_queue_one_active_reservation;
CREATE UNIQUE INDEX checkout_queue_one_active_account ON checkout_queue(account_id)
WHERE status IN ('pending', 'held');

CREATE TRIGGER checkout_account_required BEFORE INSERT ON checkout_queue
WHEN NOT EXISTS (
  SELECT 1 FROM sessions s JOIN accounts a ON a.id = s.account_id
  WHERE s.id = NEW.session_id AND a.id = NEW.account_id AND a.kind = 'student'
)
BEGIN SELECT RAISE(ABORT, 'authenticated_account_required'); END;

CREATE TRIGGER order_account_required BEFORE INSERT ON orders
WHEN NOT EXISTS (
  SELECT 1 FROM sessions s JOIN accounts a ON a.id = s.account_id
  WHERE s.id = NEW.session_id AND a.id = NEW.account_id AND a.kind = 'student'
)
BEGIN SELECT RAISE(ABORT, 'authenticated_account_required'); END;

-- Defense in depth: creation and cooldown advancement are one SQL operation,
-- inside the same transaction as inventory allocation and queue settlement.
CREATE TRIGGER order_account_cooldown BEFORE INSERT ON orders
WHEN NOT EXISTS (SELECT 1 FROM orders WHERE account_id = NEW.account_id AND request_key = NEW.request_key)
  AND (SELECT cooldown_until FROM accounts WHERE id = NEW.account_id) > NEW.created_at
BEGIN SELECT RAISE(ABORT, 'account_order_cooldown'); END;

CREATE TRIGGER order_advances_cooldown AFTER INSERT ON orders
BEGIN
  UPDATE accounts SET cooldown_until = MAX(cooldown_until, NEW.created_at + 3600000)
  WHERE id = NEW.account_id;
END;
