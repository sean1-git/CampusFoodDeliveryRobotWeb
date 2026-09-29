-- Release unconfirmed holds whose meeting areas were superseded; preserve orders.
UPDATE checkout_queue SET status = 'cancelled'
WHERE status IN ('pending', 'held')
AND (delivery_route IS NULL OR json_extract(delivery_route, '$.version') != 'ucm-simulation-v3');
