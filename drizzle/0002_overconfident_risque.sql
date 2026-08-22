CREATE TABLE `inventory_locations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryItemId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`onHand` int NOT NULL DEFAULT 0,
	`version` int NOT NULL DEFAULT 0,
	`isPrimary` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `inventory_locations_id` PRIMARY KEY(`id`),
	CONSTRAINT `inventory_locations_item_name_unique` UNIQUE(`inventoryItemId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `location_stock_movements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryItemId` int NOT NULL,
	`inventoryLocationId` int NOT NULL,
	`movementType` enum('opening_balance','receive','sale','return','adjustment','correction','transfer') NOT NULL,
	`delta` int NOT NULL,
	`quantityBefore` int NOT NULL,
	`quantityAfter` int NOT NULL,
	`reason` varchar(240) NOT NULL,
	`reference` varchar(128),
	`transferGroupId` varchar(64),
	`createdById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `location_stock_movements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stock_alert_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryItemId` int NOT NULL,
	`eventType` enum('low_stock','recovered') NOT NULL,
	`quantity` int NOT NULL,
	`reorderThreshold` int NOT NULL,
	`reason` varchar(240) NOT NULL,
	`createdById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stock_alert_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `inventory_locations_item_idx` ON `inventory_locations` (`inventoryItemId`,`onHand`);--> statement-breakpoint
CREATE INDEX `location_movements_location_created_idx` ON `location_stock_movements` (`inventoryLocationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `location_movements_item_created_idx` ON `location_stock_movements` (`inventoryItemId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `location_movements_transfer_idx` ON `location_stock_movements` (`transferGroupId`);--> statement-breakpoint
CREATE INDEX `stock_alert_events_item_created_idx` ON `stock_alert_events` (`inventoryItemId`,`createdAt`);