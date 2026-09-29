ALTER TABLE `checkout_queue` ADD `kind` text DEFAULT 'purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE `checkout_queue` ADD `expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `checkout_queue_status_expiry` ON `checkout_queue` (`status`,`expires_at`);