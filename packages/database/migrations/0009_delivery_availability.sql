-- Preserve the account-level, transactional lock, but end it at simulated
-- delivery rather than one hour after purchase. Historical routes stay frozen.
DROP TRIGGER order_advances_cooldown;
UPDATE accounts SET cooldown_until = COALESCE((
  SELECT MAX(created_at + CASE WHEN delivery_route IS NOT NULL
    THEN 20000 + CAST(json_extract(delivery_route, '$.seconds') AS INTEGER) * 1000
    ELSE CASE location WHEN 'Library entrance' THEN 51000
      WHEN 'Student center' THEN 75000 WHEN 'Residence hall courtyard' THEN 38000
      ELSE 65000 END END)
  FROM orders WHERE account_id = accounts.id
), 0);
CREATE TRIGGER order_advances_cooldown AFTER INSERT ON orders
BEGIN
  UPDATE accounts SET cooldown_until = MAX(cooldown_until, NEW.created_at +
    CASE WHEN NEW.delivery_route IS NOT NULL
      THEN 20000 + CAST(json_extract(NEW.delivery_route, '$.seconds') AS INTEGER) * 1000
      ELSE CASE NEW.location WHEN 'Library entrance' THEN 51000
        WHEN 'Student center' THEN 75000 WHEN 'Residence hall courtyard' THEN 38000
        ELSE 65000 END END)
  WHERE id = NEW.account_id;
END;
