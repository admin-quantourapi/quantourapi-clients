CREATE TABLE `daily_metrics_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`date` text NOT NULL,
	`price` text NOT NULL,
	`volume` text,
	`market_cap` text,
	`pe_ratio` text,
	`ps_ratio` text,
	`score` text,
	`sentiment_score` text,
	`macro_score` text,
	`raw_metrics_json` text,
	`created_at` integer
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text,
	`user_id` text DEFAULT 'dashboard_user' NOT NULL,
	`summary` text NOT NULL,
	`full_text` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_notification_batches`("id", "chat_id", "user_id", "summary", "full_text", "created_at") SELECT "id", "chat_id", "user_id", "summary", "full_text", "created_at" FROM `notification_batches`;--> statement-breakpoint
DROP TABLE `notification_batches`;--> statement-breakpoint
ALTER TABLE `__new_notification_batches` RENAME TO `notification_batches`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_pnl_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text,
	`user_id` text DEFAULT 'dashboard_user' NOT NULL,
	`type` text NOT NULL,
	`pnl_amount` text NOT NULL,
	`pnl_percent` text NOT NULL,
	`timestamp` integer
);
--> statement-breakpoint
INSERT INTO `__new_pnl_history`("id", "chat_id", "user_id", "type", "pnl_amount", "pnl_percent", "timestamp") SELECT "id", "chat_id", "user_id", "type", "pnl_amount", "pnl_percent", "timestamp" FROM `pnl_history`;--> statement-breakpoint
DROP TABLE `pnl_history`;--> statement-breakpoint
ALTER TABLE `__new_pnl_history` RENAME TO `pnl_history`;--> statement-breakpoint
CREATE TABLE `__new_portfolio_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text,
	`user_id` text DEFAULT 'dashboard_user' NOT NULL,
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
INSERT INTO `__new_portfolio_stats`("id", "chat_id", "user_id", "initial_capital", "current_capital", "daily_starting_capital", "weekly_starting_capital", "monthly_starting_capital", "is_margin_called", "updated_at", "created_at") SELECT "id", "chat_id", "user_id", "initial_capital", "current_capital", "daily_starting_capital", "weekly_starting_capital", "monthly_starting_capital", "is_margin_called", "updated_at", "created_at" FROM `portfolio_stats`;--> statement-breakpoint
DROP TABLE `portfolio_stats`;--> statement-breakpoint
ALTER TABLE `__new_portfolio_stats` RENAME TO `portfolio_stats`;--> statement-breakpoint
CREATE TABLE `__new_trade_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text,
	`user_id` text DEFAULT 'dashboard_user' NOT NULL,
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
INSERT INTO `__new_trade_audit_log`("id", "chat_id", "user_id", "ticker", "strategy_name", "entry_date", "exit_date", "entry_price", "exit_price", "pnl_usd", "pnl_percent", "exit_reason", "thesis", "days_held") SELECT "id", "chat_id", "user_id", "ticker", "strategy_name", "entry_date", "exit_date", "entry_price", "exit_price", "pnl_usd", "pnl_percent", "exit_reason", "thesis", "days_held" FROM `trade_audit_log`;--> statement-breakpoint
DROP TABLE `trade_audit_log`;--> statement-breakpoint
ALTER TABLE `__new_trade_audit_log` RENAME TO `trade_audit_log`;--> statement-breakpoint
CREATE TABLE `__new_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text,
	`user_id` text DEFAULT 'dashboard_user' NOT NULL,
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
	`ttl` integer,
	`fired_branch_name` text,
	`entry_regime` text,
	`entry_sector` text
);
--> statement-breakpoint
INSERT INTO `__new_trades`("id", "chat_id", "user_id", "ticker", "entry_price", "stop_loss", "target", "risk_per_share", "risk_amount_usd", "capital_deployed", "entry_date", "stage", "days_held", "in_resistance_zone", "highest_high", "atr", "strategy_name", "partial_target", "is_partial_taken", "thesis", "confirmation_signals", "reversal_signals", "risk", "ttl", "fired_branch_name", "entry_regime", "entry_sector") SELECT "id", "chat_id", "user_id", "ticker", "entry_price", "stop_loss", "target", "risk_per_share", "risk_amount_usd", "capital_deployed", "entry_date", "stage", "days_held", "in_resistance_zone", "highest_high", "atr", "strategy_name", "partial_target", "is_partial_taken", "thesis", "confirmation_signals", "reversal_signals", "risk", "ttl", "fired_branch_name", "entry_regime", "entry_sector" FROM `trades`;--> statement-breakpoint
DROP TABLE `trades`;--> statement-breakpoint
ALTER TABLE `__new_trades` RENAME TO `trades`;--> statement-breakpoint
ALTER TABLE `settings` ADD `available_cash` text;