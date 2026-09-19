CREATE TABLE `custom_strategies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`ast_json` text NOT NULL,
	`created_at` integer
);
