ALTER TABLE checkout_queue ADD COLUMN delivery_route TEXT;
ALTER TABLE orders ADD COLUMN delivery_route TEXT;
-- Old unfinished checkouts have no confirmed GPS destination. Release them instead
-- of allowing the pre-pin checkout path to process a purchase after this rollout.
UPDATE checkout_queue SET status = 'cancelled' WHERE status IN ('pending', 'held');
