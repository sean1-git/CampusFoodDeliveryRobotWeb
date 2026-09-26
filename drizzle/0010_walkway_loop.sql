-- A held pin from the old service area must be selected again on the new loop.
-- Completed orders retain their saved routes, ETAs, and account availability.
UPDATE checkout_queue SET status = 'cancelled'
WHERE status IN ('pending', 'held')
  AND (delivery_route IS NULL OR json_extract(delivery_route, '$.version') != 'ucm-simulation-v2');
