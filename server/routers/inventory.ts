import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  inventoryConditions,
  inventoryImages,
  inventoryItems,
  inventoryProductTypes,
  stockMovements,
  stockMovementTypes,
} from "../../drizzle/schema";
import {
  getDb,
  getInventoryDashboard,
  getInventoryItem,
  listInventory,
  listInventoryImages,
  listStockMovements,
} from "../db";
import { planStockAdjustment } from "../inventory/domain";
import { notifyOwner } from "../_core/notification";
import { protectedProcedure, router } from "../_core/trpc";
import { storagePut } from "../storage";

const itemInput = z.object({
  productType: z.enum(inventoryProductTypes),
  game: z.string().trim().min(1).max(80),
  setName: z.string().trim().min(1).max(160),
  cardName: z.string().trim().max(255).nullish(),
  collectorNumber: z.string().trim().max(48).nullish(),
  condition: z.enum(inventoryConditions),
  variant: z.string().trim().max(160).nullish(),
  sku: z.string().trim().min(2).max(96),
  purchasePriceCents: z.number().int().min(0),
  salePriceCents: z.number().int().min(0),
  onHand: z.number().int().min(0),
  reorderThreshold: z.number().int().min(0),
  storageLocation: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(2_000).nullish(),
});

const metadataInput = itemInput.omit({ onHand: true }).partial().extend({
  id: z.number().int().positive(),
  expectedVersion: z.number().int().min(0),
});

function asNullable(value: string | null | undefined) {
  return value?.trim() ? value.trim() : null;
}

function getInsertId(result: unknown) {
  const header = (Array.isArray(result) ? result[0] : result) as { insertId?: number | string } | undefined;
  const id = Number(header?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("The database did not return an inserted record id.");
  return id;
}

function isSuccessfulWrite(result: unknown) {
  const header = (Array.isArray(result) ? result[0] : result) as { affectedRows?: number } | undefined;
  return Number(header?.affectedRows ?? 0) === 1;
}

function parseImageData(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload a PNG, JPEG, WebP, or GIF image." });
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Images must be no larger than 5 MB." });
  }
  return { contentType: match[1], bytes };
}

function itemLabel(item: { cardName: string | null; setName: string; sku: string }) {
  return item.cardName?.trim() || item.setName || item.sku;
}

export const inventoryRouter = router({
  dashboard: protectedProcedure.query(() => getInventoryDashboard()),

  list: protectedProcedure
    .input(
      z
        .object({
          query: z.string().max(120).optional(),
          productType: z.enum(inventoryProductTypes).optional(),
          condition: z.enum(inventoryConditions).optional(),
          game: z.string().max(80).optional(),
          lowStockOnly: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ input }) => listInventory(input ?? {})),

  get: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getInventoryItem(input.id)),

  images: protectedProcedure
    .input(z.object({ inventoryItemId: z.number().int().positive() }))
    .query(({ input }) => listInventoryImages(input.inventoryItemId)),

  movementHistory: protectedProcedure
    .input(z.object({ inventoryItemId: z.number().int().positive() }).optional())
    .query(({ input }) => listStockMovements(input?.inventoryItemId)),

  create: protectedProcedure.input(itemInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Inventory storage is not available." });

    const isInitiallyLow = input.reorderThreshold > 0 && input.onHand <= input.reorderThreshold;
    const created = await db.transaction(async tx => {
      let insertResult: unknown;
      try {
        insertResult = await tx.insert(inventoryItems).values({
          ...input,
          cardName: asNullable(input.cardName),
          collectorNumber: asNullable(input.collectorNumber),
          variant: asNullable(input.variant),
          notes: asNullable(input.notes),
          lowStockNotifiedAt: isInitiallyLow ? new Date() : null,
          createdById: ctx.user.id,
        });
      } catch (error) {
        throw new TRPCError({ code: "CONFLICT", message: "SKU must be unique.", cause: error });
      }
      const id = getInsertId(insertResult);

      if (input.onHand > 0) {
        await tx.insert(stockMovements).values({
          inventoryItemId: id,
          movementType: "opening_balance",
          delta: input.onHand,
          quantityBefore: 0,
          quantityAfter: input.onHand,
          reason: "Opening inventory balance",
          createdById: ctx.user.id,
        });
      }

      const [record] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, id)).limit(1);
      return record;
    });

    if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The inventory record could not be created." });
    if (isInitiallyLow) {
      await notifyOwner({
        title: `Low stock: ${itemLabel(created)}`,
        content: `${created.sku} opened at ${created.onHand} on hand, at or below its reorder threshold of ${created.reorderThreshold}.`,
      });
    }
    return created;
  }),

  updateMetadata: protectedProcedure.input(metadataInput).mutation(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Inventory storage is not available." });
    const current = await getInventoryItem(input.id);
    if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Inventory record not found." });
    if (current.version !== input.expectedVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "This record changed in another session. Refresh and review the latest details." });
    }

    const fields = {
      ...(input.productType ? { productType: input.productType } : {}),
      ...(input.game ? { game: input.game } : {}),
      ...(input.setName ? { setName: input.setName } : {}),
      ...(input.cardName !== undefined ? { cardName: asNullable(input.cardName) } : {}),
      ...(input.collectorNumber !== undefined ? { collectorNumber: asNullable(input.collectorNumber) } : {}),
      ...(input.condition ? { condition: input.condition } : {}),
      ...(input.variant !== undefined ? { variant: asNullable(input.variant) } : {}),
      ...(input.sku ? { sku: input.sku } : {}),
      ...(input.purchasePriceCents !== undefined ? { purchasePriceCents: input.purchasePriceCents } : {}),
      ...(input.salePriceCents !== undefined ? { salePriceCents: input.salePriceCents } : {}),
      ...(input.reorderThreshold !== undefined ? { reorderThreshold: input.reorderThreshold } : {}),
      ...(input.storageLocation ? { storageLocation: input.storageLocation } : {}),
      ...(input.notes !== undefined ? { notes: asNullable(input.notes) } : {}),
    };
    const nextThreshold = input.reorderThreshold ?? current.reorderThreshold;
    const newlyLow = nextThreshold > 0 && current.onHand <= nextThreshold && current.onHand > current.reorderThreshold;
    const recovered = nextThreshold === 0 || current.onHand > nextThreshold;
    let writeResult: unknown;
    try {
      writeResult = await db
        .update(inventoryItems)
        .set({
          ...fields,
          version: current.version + 1,
          lowStockNotifiedAt: newlyLow ? new Date() : recovered ? null : current.lowStockNotifiedAt,
        })
        .where(and(eq(inventoryItems.id, input.id), eq(inventoryItems.version, input.expectedVersion)));
    } catch (error) {
      throw new TRPCError({ code: "CONFLICT", message: "The SKU is already in use.", cause: error });
    }
    if (!isSuccessfulWrite(writeResult)) {
      throw new TRPCError({ code: "CONFLICT", message: "This record changed in another session. Refresh and try again." });
    }
    const updated = await getInventoryItem(input.id);
    if (newlyLow && updated) {
      await notifyOwner({
        title: `Low stock: ${itemLabel(updated)}`,
        content: `${updated.sku} is at ${updated.onHand} on hand, at or below its updated reorder threshold of ${updated.reorderThreshold}.`,
      });
    }
    return updated;
  }),

  adjustStock: protectedProcedure
    .input(
      z.object({
        inventoryItemId: z.number().int().positive(),
        expectedVersion: z.number().int().min(0),
        delta: z.number().int().refine(value => value !== 0, "Enter a non-zero quantity."),
        movementType: z.enum(stockMovementTypes).exclude(["opening_balance"]),
        reason: z.string().trim().min(2).max(240),
        reference: z.string().trim().max(128).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Inventory storage is not available." });

      const result = await db.transaction(async tx => {
        const [current] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, input.inventoryItemId)).limit(1);
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Inventory record not found." });
        if (current.version !== input.expectedVersion) {
          throw new TRPCError({ code: "CONFLICT", message: "Stock changed in another session. Refresh before recording this movement." });
        }

        let plan;
        try {
          plan = planStockAdjustment({ onHand: current.onHand, reorderThreshold: current.reorderThreshold, delta: input.delta });
        } catch (error) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Invalid stock adjustment." });
        }

        const writeResult = await tx
          .update(inventoryItems)
          .set({
            onHand: plan.nextQuantity,
            version: current.version + 1,
            lowStockNotifiedAt: plan.crossesBelowThreshold ? new Date() : plan.recoversAboveThreshold ? null : current.lowStockNotifiedAt,
          })
          .where(and(eq(inventoryItems.id, current.id), eq(inventoryItems.version, input.expectedVersion)));
        if (!isSuccessfulWrite(writeResult)) {
          throw new TRPCError({ code: "CONFLICT", message: "Stock changed in another session. Refresh before recording this movement." });
        }

        await tx.insert(stockMovements).values({
          inventoryItemId: current.id,
          movementType: input.movementType,
          delta: input.delta,
          quantityBefore: current.onHand,
          quantityAfter: plan.nextQuantity,
          reason: input.reason,
          reference: asNullable(input.reference),
          createdById: ctx.user.id,
        });

        return { item: { ...current, onHand: plan.nextQuantity, version: current.version + 1 }, crossedLowStock: plan.crossesBelowThreshold };
      });

      if (result.crossedLowStock) {
        await notifyOwner({
          title: `Low stock: ${itemLabel(result.item)}`,
          content: `${result.item.sku} reached ${result.item.onHand} on hand, at or below its reorder threshold of ${result.item.reorderThreshold}.`,
        });
      }
      return result;
    }),

  attachImage: protectedProcedure
    .input(
      z.object({
        inventoryItemId: z.number().int().positive(),
        fileName: z.string().trim().min(1).max(255),
        caption: z.string().trim().max(255).nullish(),
        dataUrl: z.string().max(7_000_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await getInventoryItem(input.inventoryItemId);
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Inventory record not found." });
      const { bytes, contentType } = parseImageData(input.dataUrl);
      const extension = contentType.split("/")[1] ?? "img";
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
      const { key, url } = await storagePut(`inventory/${item.id}/${Date.now()}-${safeName || `reference.${extension}`}`, bytes, contentType);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Inventory storage is not available." });
      const insertResult = await db.insert(inventoryImages).values({
        inventoryItemId: item.id,
        storageKey: key,
        url,
        fileName: input.fileName,
        caption: asNullable(input.caption),
        createdById: ctx.user.id,
      });
      return { id: getInsertId(insertResult), key, url };
    }),
});
