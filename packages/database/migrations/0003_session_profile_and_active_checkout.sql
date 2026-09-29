ALTER TABLE `sessions` ADD `name` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `student_id` text;
--> statement-breakpoint
CREATE INDEX `sessions_student_id` ON `sessions` (`student_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_queue_one_active_reservation`
ON `checkout_queue` (`session_id`)
WHERE `kind` = 'reservation' AND `status` IN ('pending', 'held');
