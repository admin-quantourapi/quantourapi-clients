CREATE TABLE `pnl_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`type` text NOT NULL,
	`pnl_amount` text NOT NULL,
	`pnl_percent` text NOT NULL,
	`timestamp` integer
);
--> statement-breakpoint
CREATE TABLE `portfolio_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`initial_capital` text DEFAULT '50000' NOT NULL,
	`current_capital` text DEFAULT '50000' NOT NULL,
	`daily_starting_capital` text,
	`weekly_starting_capital` text,
	`monthly_starting_capital` text,
	`is_margin_called` integer DEFAULT false NOT NULL,
	`updated_at` integer,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `trade_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`ticker` text NOT NULL,
	`strategy_name` text NOT NULL,
	`entry_date` integer,
	`exit_date` integer,
	`entry_price` text NOT NULL,
	`exit_price` text NOT NULL,
	`pnl_usd` text NOT NULL,
	`pnl_percent` text NOT NULL,
	`exit_reason` text NOT NULL,
	`thesis` text,
	`days_held` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`ticker` text NOT NULL,
	`entry_price` text NOT NULL,
	`stop_loss` text NOT NULL,
	`target` text NOT NULL,
	`risk_per_share` text NOT NULL,
	`risk_amount_usd` text NOT NULL,
	`capital_deployed` text NOT NULL,
	`entry_date` integer,
	`stage` integer DEFAULT 0 NOT NULL,
	`days_held` integer DEFAULT 0 NOT NULL,
	`in_resistance_zone` integer DEFAULT false NOT NULL,
	`highest_high` text,
	`atr` text,
	`strategy_name` text,
	`partial_target` text,
	`is_partial_taken` integer DEFAULT false NOT NULL,
	`thesis` text,
	`confirmation_signals` text,
	`reversal_signals` text,
	`risk` text,
	`ttl` integer
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `user_name` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `total_capital` text DEFAULT '30000' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `max_risk_per_trade` text DEFAULT '300' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `is_budget_aware` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `portfolio_strategy` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `signal_mode` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `language` text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `risk_profile` text DEFAULT 'BALANCED' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `main_strategy_ast` text;