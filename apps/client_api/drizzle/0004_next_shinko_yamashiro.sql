PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contour_api_key` text,
	`telegram_bot_token` text,
	`telegram_chat_id` text,
	`user_name` text,
	`total_capital` text DEFAULT '30000' NOT NULL,
	`max_risk_per_trade` text DEFAULT '300' NOT NULL,
	`is_budget_aware` integer DEFAULT false NOT NULL,
	`portfolio_strategy` text DEFAULT 'ai_combined' NOT NULL,
	`signal_mode` text DEFAULT 'all' NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`risk_profile` text DEFAULT 'CONSERVATIVE' NOT NULL,
	`main_strategy_ast` text,
	`updated_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "contour_api_key", "telegram_bot_token", "telegram_chat_id", "user_name", "total_capital", "max_risk_per_trade", "is_budget_aware", "portfolio_strategy", "signal_mode", "language", "status", "risk_profile", "main_strategy_ast", "updated_at") SELECT "id", "contour_api_key", "telegram_bot_token", "telegram_chat_id", "user_name", "total_capital", "max_risk_per_trade", "is_budget_aware", "portfolio_strategy", "signal_mode", "language", "status", "risk_profile", "main_strategy_ast", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
UPDATE `settings` SET `risk_profile` = 'CONSERVATIVE';