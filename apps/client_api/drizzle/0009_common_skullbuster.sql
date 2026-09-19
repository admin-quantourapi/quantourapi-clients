CREATE TABLE `user_budgets` (
	`user_id` text PRIMARY KEY NOT NULL,
	`total_capital` text,
	`max_risk_per_trade` text,
	`available_cash` text,
	`updated_at` integer
);
