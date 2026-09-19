ALTER TABLE `pnl_history` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `portfolio_stats` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `trade_audit_log` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `user_id` text;