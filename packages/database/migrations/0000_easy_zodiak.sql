CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`items` text NOT NULL,
	`subtotal` integer NOT NULL,
	`total` integer NOT NULL,
	`location` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_session_request` ON `orders` (`session_id`,`request_key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`csrf` text NOT NULL,
	`created_at` integer NOT NULL
);
