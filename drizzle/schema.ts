import {
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const inventoryProductTypes = ["single", "sealed"] as const;
export const inventoryConditions = ["near_mint", "lightly_played", "moderately_played", "heavily_played", "damaged", "sealed"] as const;
export const stockMovementTypes = ["opening_balance", "receive", "sale", "return", "adjustment", "correction", "transfer"] as const;
export const stockAlertEventTypes = ["low_stock", "recovered"] as const;

/** Shared stock master record. onHand is the atomically maintained sum of its location balances. */
export const inventoryItems = mysqlTable(
  "inventory_items",
  {
    id: int("id").autoincrement().primaryKey(),
    productType: mysqlEnum("productType", inventoryProductTypes).notNull(),
    game: varchar("game", { length: 80 }).notNull(),
    setName: varchar("setName", { length: 160 }).notNull(),
    cardName: varchar("cardName", { length: 255 }),
    collectorNumber: varchar("collectorNumber", { length: 48 }),
    condition: mysqlEnum("condition", inventoryConditions).notNull(),
    variant: varchar("variant", { length: 160 }),
    sku: varchar("sku", { length: 96 }).notNull(),
    purchasePriceCents: int("purchasePriceCents").notNull().default(0),
    salePriceCents: int("salePriceCents").notNull().default(0),
    onHand: int("onHand").notNull().default(0),
    reorderThreshold: int("reorderThreshold").notNull().default(0),
    storageLocation: varchar("storageLocation", { length: 160 }).notNull(),
    notes: text("notes"),
    version: int("version").notNull().default(0),
    lowStockNotifiedAt: timestamp("lowStockNotifiedAt"),
    createdById: int("createdById").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("inventory_items_sku_unique").on(table.sku),
    index("inventory_items_game_idx").on(table.game),
    index("inventory_items_stock_idx").on(table.onHand, table.reorderThreshold),
    index("inventory_items_type_idx").on(table.productType),
    index("inventory_items_search_idx").on(table.game, table.setName, table.cardName, table.sku),
    index("inventory_items_low_stock_idx").on(table.onHand, table.reorderThreshold),
    index("inventory_items_created_idx").on(table.createdAt),
  ],
);

/** Immutable item-level audit ledger. There is intentionally no updatedAt field. */
export const stockMovements = mysqlTable(
  "stock_movements",
  {
    id: int("id").autoincrement().primaryKey(),
    inventoryItemId: int("inventoryItemId").notNull(),
    movementType: mysqlEnum("movementType", stockMovementTypes).notNull(),
    delta: int("delta").notNull(),
    quantityBefore: int("quantityBefore").notNull(),
    quantityAfter: int("quantityAfter").notNull(),
    reason: varchar("reason", { length: 240 }).notNull(),
    reference: varchar("reference", { length: 128 }),
    createdById: int("createdById").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("stock_movements_item_created_idx").on(table.inventoryItemId, table.createdAt),
    index("stock_movements_actor_created_idx").on(table.createdById, table.createdAt),
    index("stock_movements_type_idx").on(table.movementType, table.createdAt),
  ],
);

/** A location-level balance makes an item's on-hand total explainable across cases, backstock, and events. */
export const inventoryLocations = mysqlTable(
  "inventory_locations",
  {
    id: int("id").autoincrement().primaryKey(),
    inventoryItemId: int("inventoryItemId").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    onHand: int("onHand").notNull().default(0),
    version: int("version").notNull().default(0),
    isPrimary: int("isPrimary").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("inventory_locations_item_name_unique").on(table.inventoryItemId, table.name),
    index("inventory_locations_item_idx").on(table.inventoryItemId, table.onHand),
    index("inventory_locations_item_created_idx").on(table.inventoryItemId, table.createdAt),
  ],
);

/** Append-only location ledger preserving exact case, backstock, or event-floor balances. */
export const locationStockMovements = mysqlTable(
  "location_stock_movements",
  {
    id: int("id").autoincrement().primaryKey(),
    inventoryItemId: int("inventoryItemId").notNull(),
    inventoryLocationId: int("inventoryLocationId").notNull(),
    movementType: mysqlEnum("movementType", stockMovementTypes).notNull(),
    delta: int("delta").notNull(),
    quantityBefore: int("quantityBefore").notNull(),
    quantityAfter: int("quantityAfter").notNull(),
    reason: varchar("reason", { length: 240 }).notNull(),
    reference: varchar("reference", { length: 128 }),
    transferGroupId: varchar("transferGroupId", { length: 64 }),
    createdById: int("createdById").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("location_movements_location_created_idx").on(table.inventoryLocationId, table.createdAt),
    index("location_movements_item_created_idx").on(table.inventoryItemId, table.createdAt),
    index("location_movements_transfer_idx").on(table.transferGroupId),
    index("location_movements_type_idx").on(table.movementType, table.createdAt),
  ],
);

/** Owner-facing alert history preserves both low-stock signals and recovery events. */
export const stockAlertEvents = mysqlTable(
  "stock_alert_events",
  {
    id: int("id").autoincrement().primaryKey(),
    inventoryItemId: int("inventoryItemId").notNull(),
    eventType: mysqlEnum("eventType", stockAlertEventTypes).notNull(),
    quantity: int("quantity").notNull(),
    reorderThreshold: int("reorderThreshold").notNull(),
    reason: varchar("reason", { length: 240 }).notNull(),
    createdById: int("createdById").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("stock_alert_events_item_created_idx").on(table.inventoryItemId, table.createdAt),
    index("stock_alert_events_type_idx").on(table.eventType, table.createdAt),
  ],
);

/** Image metadata points to managed S3 storage; binary image data never enters the database. */
export const inventoryImages = mysqlTable(
  "inventory_images",
  {
    id: int("id").autoincrement().primaryKey(),
    inventoryItemId: int("inventoryItemId").notNull(),
    storageKey: varchar("storageKey", { length: 512 }).notNull(),
    url: varchar("url", { length: 768 }).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    caption: varchar("caption", { length: 255 }),
    createdById: int("createdById").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("inventory_images_item_idx").on(table.inventoryItemId, table.createdAt),
    index("inventory_images_item_created_idx").on(table.inventoryItemId, table.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InsertInventoryItem = typeof inventoryItems.$inferInsert;
export type StockMovement = typeof stockMovements.$inferSelect;
export type InventoryLocation = typeof inventoryLocations.$inferSelect;
export type LocationStockMovement = typeof locationStockMovements.$inferSelect;
export type StockAlertEvent = typeof stockAlertEvents.$inferSelect;
export type InventoryImage = typeof inventoryImages.$inferSelect;
