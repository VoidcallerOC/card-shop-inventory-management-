CREATE TABLE `inventory_images` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryItemId` int NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`url` varchar(768) NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`caption` varchar(255),
	`createdById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventory_images_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventory_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`productType` enum('single','sealed') NOT NULL,
	`game` varchar(80) NOT NULL,
	`setName` varchar(160) NOT NULL,
	`cardName` varchar(255),
	`collectorNumber` varchar(48),
	`condition` enum('near_mint','lightly_played','moderately_played','heavily_played','damaged','sealed') NOT NULL,
	`variant` varchar(160),
	`sku` varchar(96) NOT NULL,
	`purchasePriceCents` int NOT NULL DEFAULT 0,
	`salePriceCents` int NOT NULL DEFAULT 0,
	`onHand` int NOT NULL DEFAULT 0,
	`reorderThreshold` int NOT NULL DEFAULT 0,
	`storageLocation` varchar(160) NOT NULL,
	`notes` text,
	`version` int NOT NULL DEFAULT 0,
	`lowStockNotifiedAt` timestamp,
	`createdById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `inventory_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `inventory_items_sku_unique` UNIQUE(`sku`)
);
--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryItemId` int NOT NULL,
	`movementType` enum('opening_balance','receive','sale','return','adjustment','correction','transfer') NOT NULL,
	`delta` int NOT NULL,
	`quantityBefore` int NOT NULL,
	`quantityAfter` int NOT NULL,
	`reason` varchar(240) NOT NULL,
	`reference` varchar(128),
	`createdById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stock_movements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `inventory_images_item_idx` ON `inventory_images` (`inventoryItemId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `inventory_items_game_idx` ON `inventory_items` (`game`);--> statement-breakpoint
CREATE INDEX `inventory_items_stock_idx` ON `inventory_items` (`onHand`,`reorderThreshold`);--> statement-breakpoint
CREATE INDEX `inventory_items_type_idx` ON `inventory_items` (`productType`);--> statement-breakpoint
CREATE INDEX `stock_movements_item_created_idx` ON `stock_movements` (`inventoryItemId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `stock_movements_actor_created_idx` ON `stock_movements` (`createdById`,`createdAt`);