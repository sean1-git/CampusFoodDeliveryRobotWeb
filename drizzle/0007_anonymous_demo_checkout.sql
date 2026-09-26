-- Allow new server-issued anonymous demo accounts while preserving old history
-- and the account/session relationship, inventory, idempotency and cooldowns.
DROP TRIGGER checkout_account_required;
CREATE TRIGGER checkout_account_required BEFORE INSERT ON checkout_queue
WHEN NOT EXISTS (
  SELECT 1 FROM sessions s JOIN accounts a ON a.id = s.account_id
  WHERE s.id = NEW.session_id AND a.id = NEW.account_id
    AND (a.kind = 'student' OR (a.kind = 'legacy' AND a.issuer = 'campus-demo-v1'))
)
BEGIN SELECT RAISE(ABORT, 'authenticated_account_required'); END;

DROP TRIGGER order_account_required;
CREATE TRIGGER order_account_required BEFORE INSERT ON orders
WHEN NOT EXISTS (
  SELECT 1 FROM sessions s JOIN accounts a ON a.id = s.account_id
  WHERE s.id = NEW.session_id AND a.id = NEW.account_id
    AND (a.kind = 'student' OR (a.kind = 'legacy' AND a.issuer = 'campus-demo-v1'))
)
BEGIN SELECT RAISE(ABORT, 'authenticated_account_required'); END;
