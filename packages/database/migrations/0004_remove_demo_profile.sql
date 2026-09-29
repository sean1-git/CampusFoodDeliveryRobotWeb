DROP INDEX `sessions_student_id`;
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `name`;
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `student_id`;
