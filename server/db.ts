import { and, count, desc, eq, gt, like, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import {
  InsertInventoryItem,
  InsertUser,
  inventoryImages,
  inventoryItems,
  inventoryLocations,
  stockAlertEvents,
  stockMovements,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

const DB_POOL_SIZE = parseInt(process.env.DB_POOL_SIZE || "10");

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

async function createPool(): Promise<Pool> {
  if (_pool) return _pool;
  _pool = mysql.createPool({
    uri: process.env.DATABASE_URL,
    connectionLimit: DB_POOL_SIZE,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
  return _pool;
}

export async function getDb(): Promise<ReturnType<typeof drizzle> | null> {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const pool = await createPool();
      _db = drizzle(pool) as unknown as ReturnType<typeof drizzle>;
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  (["name", "email", "loginMethod"] as const).forEach(field => {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  });
  values.lastSignedIn = user.lastSignedIn ?? new Date();
  updateSet.lastSignedIn = values.lastSignedIn;
  values.role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");
  updateSet.role = values.role;
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(users).where(eq(users.openId, openId)).limit(1))[0];
}

export async function listInventory(filters: {
  query?: string;
  productType?: "single" | "sealed";
  condition?: (typeof inventoryItems.condition.enumValues)[number];
  game?: string;
  lowStockOnly?: boolean;
  page?: number;
  pageSize?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const clauses = [];
  if (filters.productType) clauses.push(eq(inventoryItems.productType, filters.productType));
  if (filters.condition) clauses.push(eq(inventoryItems.condition, filters.condition));
  if (filters.game) clauses.push(eq(inventoryItems.game, filters.game));
  if (filters.lowStockOnly) clauses.push(and(gt(inventoryItems.reorderThreshold, 0), lte(inventoryItems.onHand, inventoryItems.reorderThreshold)));
  if (filters.query?.trim()) {
    const term = `%${filters.query.trim()}%`;
    clauses.push(or(like(inventoryItems.cardName, term), like(inventoryItems.sku, term), like(inventoryItems.setName, term), like(inventoryItems.game, term)));
  }
  const offset = ((filters.page ?? 1) - 1) * (filters.pageSize ?? 50);
  return db.select()
    .from(inventoryItems)
    .where(and(...clauses))
    .orderBy(desc(inventoryItems.updatedAt), desc(inventoryItems.id))
    .limit(filters.pageSize ?? 50)
    .offset(offset);
}

export async function getInventoryItem(itemId: number) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(inventoryItems).where(eq(inventoryItems.id, itemId)).limit(1))[0];
}

export async function listInventoryLocations(itemId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inventoryLocations).where(eq(inventoryLocations.inventoryItemId, itemId)).orderBy(desc(inventoryLocations.isPrimary), inventoryLocations.name);
}

export async function listInventoryImages(itemId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inventoryImages).where(eq(inventoryImages.inventoryItemId, itemId)).orderBy(desc(inventoryImages.createdAt));
}

export async function listStockAlertHistory(itemId?: number) {
  const db = await getDb();
  if (!db) return [];
  const base = db
    .select({
      id: stockAlertEvents.id,
      eventType: stockAlertEvents.eventType,
      quantity: stockAlertEvents.quantity,
      reorderThreshold: stockAlertEvents.reorderThreshold,
      reason: stockAlertEvents.reason,
      createdAt: stockAlertEvents.createdAt,
      itemId: inventoryItems.id,
      itemName: inventoryItems.cardName,
      sku: inventoryItems.sku,
      actorName: users.name,
    })
    .from(stockAlertEvents)
    .leftJoin(inventoryItems, eq(stockAlertEvents.inventoryItemId, inventoryItems.id))
    .leftJoin(users, eq(stockAlertEvents.createdById, users.id));
  return itemId
    ? base.where(eq(stockAlertEvents.inventoryItemId, itemId)).orderBy(desc(stockAlertEvents.createdAt), desc(stockAlertEvents.id))
    : base.orderBy(desc(stockAlertEvents.createdAt), desc(stockAlertEvents.id)).limit(12);
}

export async function getInventoryDashboard() {
  const db = await getDb();
  if (!db) return { metrics: { skuCount: 0, totalUnits: 0, inventoryValueCents: 0, lowStockCount: 0, locationCount: 0 }, lowStock: [], recentActivity: [], alertHistory: [] };

  const [totals] = await db
    .select({
      skuCount: count(),
      totalUnits: sql<number>`coalesce(sum(${inventoryItems.onHand}), 0)`,
      inventoryValueCents: sql<number>`coalesce(sum(${inventoryItems.onHand} * ${inventoryItems.salePriceCents}), 0)`,
      lowStockCount: sql<number>`coalesce(sum(case when ${inventoryItems.reorderThreshold} > 0 and ${inventoryItems.onHand} <= ${inventoryItems.reorderThreshold} then 1 else 0 end), 0)`,
    })
    .from(inventoryItems);
  const [locationTotals] = await db.select({ locationCount: count() }).from(inventoryLocations);
  const lowStock = await db
    .select()
    .from(inventoryItems)
    .where(and(gt(inventoryItems.reorderThreshold, 0), lte(inventoryItems.onHand, inventoryItems.reorderThreshold)))
    .orderBy(inventoryItems.onHand, inventoryItems.updatedAt)
    .limit(6);
  const recentActivity = await db
    .select({
      id: stockMovements.id,
      movementType: stockMovements.movementType,
      delta: stockMovements.delta,
      quantityAfter: stockMovements.quantityAfter,
      reason: stockMovements.reason,
      createdAt: stockMovements.createdAt,
      itemId: inventoryItems.id,
      itemName: inventoryItems.cardName,
      sku: inventoryItems.sku,
      actorName: users.name,
    })
    .from(stockMovements)
    .leftJoin(inventoryItems, eq(stockMovements.inventoryItemId, inventoryItems.id))
    .leftJoin(users, eq(stockMovements.createdById, users.id))
    .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(8);

  return {
    metrics: {
      skuCount: Number(totals?.skuCount ?? 0),
      totalUnits: Number(totals?.totalUnits ?? 0),
      inventoryValueCents: Number(totals?.inventoryValueCents ?? 0),
      lowStockCount: Number(totals?.lowStockCount ?? 0),
      locationCount: Number(locationTotals?.locationCount ?? 0),
    },
    lowStock,
    recentActivity,
    alertHistory: await listStockAlertHistory(),
  };
}

export async function listStockMovements(itemId?: number, page?: number, pageSize?: number) {
  const db = await getDb();
  if (!db) return [];
  const base = db
    .select({
      id: stockMovements.id,
      inventoryItemId: stockMovements.inventoryItemId,
      movementType: stockMovements.movementType,
      delta: stockMovements.delta,
      quantityBefore: stockMovements.quantityBefore,
      quantityAfter: stockMovements.quantityAfter,
      reason: stockMovements.reason,
      reference: stockMovements.reference,
      createdAt: stockMovements.createdAt,
      itemName: inventoryItems.cardName,
      sku: inventoryItems.sku,
      actorName: users.name,
    })
    .from(stockMovements)
    .leftJoin(inventoryItems, eq(stockMovements.inventoryItemId, inventoryItems.id))
    .leftJoin(users, eq(stockMovements.createdById, users.id));
  const query = itemId
    ? base.where(eq(stockMovements.inventoryItemId, itemId))
    : base;
  const offset = ((page ?? 1) - 1) * (pageSize ?? 100);
  return query
    .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(pageSize ?? 100)
    .offset(offset);
}
