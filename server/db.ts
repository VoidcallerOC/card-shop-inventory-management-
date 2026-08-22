import { and, count, desc, eq, gt, like, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertInventoryItem,
  InsertUser,
  inventoryImages,
  inventoryItems,
  stockMovements,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  textFields.forEach(field => {
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
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function listInventory(filters: {
  query?: string;
  productType?: "single" | "sealed";
  condition?: (typeof inventoryItems.condition.enumValues)[number];
  game?: string;
  lowStockOnly?: boolean;
}) {
  const db = await getDb();
  if (!db) return [];

  const clauses = [];
  if (filters.productType) clauses.push(eq(inventoryItems.productType, filters.productType));
  if (filters.condition) clauses.push(eq(inventoryItems.condition, filters.condition));
  if (filters.game) clauses.push(eq(inventoryItems.game, filters.game));
  if (filters.lowStockOnly) {
    clauses.push(and(gt(inventoryItems.reorderThreshold, 0), lte(inventoryItems.onHand, inventoryItems.reorderThreshold)));
  }
  if (filters.query?.trim()) {
    const term = `%${filters.query.trim()}%`;
    clauses.push(
      or(
        like(inventoryItems.cardName, term),
        like(inventoryItems.sku, term),
        like(inventoryItems.setName, term),
        like(inventoryItems.game, term),
      ),
    );
  }

  return db
    .select()
    .from(inventoryItems)
    .where(and(...clauses))
    .orderBy(desc(inventoryItems.updatedAt), desc(inventoryItems.id));
}

export async function getInventoryItem(itemId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.id, itemId)).limit(1);
  return rows[0];
}

export async function listInventoryImages(itemId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(inventoryImages)
    .where(eq(inventoryImages.inventoryItemId, itemId))
    .orderBy(desc(inventoryImages.createdAt));
}

export async function getInventoryDashboard() {
  const db = await getDb();
  if (!db) {
    return { metrics: { skuCount: 0, totalUnits: 0, inventoryValueCents: 0, lowStockCount: 0 }, lowStock: [], recentActivity: [] };
  }

  const [totals] = await db
    .select({
      skuCount: count(),
      totalUnits: sql<number>`coalesce(sum(${inventoryItems.onHand}), 0)`,
      inventoryValueCents: sql<number>`coalesce(sum(${inventoryItems.onHand} * ${inventoryItems.salePriceCents}), 0)`,
      lowStockCount: sql<number>`coalesce(sum(case when ${inventoryItems.reorderThreshold} > 0 and ${inventoryItems.onHand} <= ${inventoryItems.reorderThreshold} then 1 else 0 end), 0)`,
    })
    .from(inventoryItems);

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
    },
    lowStock,
    recentActivity,
  };
}

export async function listStockMovements(itemId?: number) {
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

  return itemId
    ? base.where(eq(stockMovements.inventoryItemId, itemId)).orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    : base.orderBy(desc(stockMovements.createdAt), desc(stockMovements.id)).limit(100);
}
