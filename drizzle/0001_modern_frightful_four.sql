CREATE TABLE `checkout_queue` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`order_id` text NOT NULL,
	`items` text NOT NULL,
	`subtotal` integer NOT NULL,
	`total` integer NOT NULL,
	`location` text NOT NULL,
	`ready_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_queue_session_request` ON `checkout_queue` (`session_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `checkout_queue_status_sequence` ON `checkout_queue` (`status`,`sequence`);--> statement-breakpoint
CREATE TABLE `inventory` (
	`product_id` text PRIMARY KEY NOT NULL,
	`quantity` integer NOT NULL,
	CONSTRAINT "inventory_nonnegative" CHECK("inventory"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `inventory`(`product_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_items_positive" CHECK("order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_items_order_product` ON `order_items` (`order_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `order_items_product` ON `order_items` (`product_id`);