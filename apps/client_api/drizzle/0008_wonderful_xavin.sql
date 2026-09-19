CREATE TABLE `account_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`event_type` text NOT NULL,
	`detail` text,
	`key_hash` text,
	`created_at` integer NOT NULL
);
