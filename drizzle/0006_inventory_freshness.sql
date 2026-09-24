-- Unknown source history stays unknown; migration/seed time is not POS sync time.
ALTER TABLE inventory ADD stock_updated_at INTEGER
  CHECK (stock_updated_at IS NULL OR stock_updated_at >= 0);
ALTER TABLE inventory ADD synced_at INTEGER
  CHECK (synced_at IS NULL OR synced_at >= 0);
