import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  inventoryConditions,
  inventoryImages,
  inventoryItems,
  inventoryLocations,
  inventoryProductTypes,
  locationStockMovements,
  stockAlertEvents,
  stockMovementTypes,
  stockMovements,
} from "../../drizzle/schema";
import {
  getDb,
  getInventoryDashboard,
  getInventoryItem,
  listInventory,
  listInventoryImages,
  listInventoryLocations,
  listStockAlertHistory,
  listStockMovements,
} from "../db";
import { Errors, assertEntityExists, assertVersionMatches } from "../_core/errors";
import { notifyOwner } from "../_core/notification";
import { protectedProcedure, router } from "../_core/trpc";
import { planStockAdjustment } from "../inventory/domain";
import { storagePut } from "../storage";
import { Config } from "../_core/config";

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

const paginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(Config.pagination.maxPageSize).default(Config.pagination.defaultPageSize),
});

const listInventoryInput = z.object({
  query: z.string().max(120).optional(),
  productType: z.enum(inventoryProductTypes).optional(),
  condition: z.enum(inventoryConditions).optional(),
  game: z.string().max(80).optional(),
  lowStockOnly: z.boolean().optional(),
}).merge(paginationSchema);

function asNullable(value: string | null | undefined) {
  return value?.trim() ? value.trim() : null;
}

function getInsertId(result: unknown) {
  const header = (Array.isArray(result) ? result[0] : result) as { insertId?: number | string } | undefined;
  const id = Number(header?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw Errors.internal("The database did not return an inserted record id.");
  return id;
}

function isSuccessfulWrite(result: unknown) {
  const header = (Array.isArray(result) ? result[0] : result) as { affectedRows?: number } | undefined;
  return Number(header?.affectedRows ?? 0) === 1;
}

function parseImageData(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Errors.badRequest("Upload a PNG, JPEG, WebP, or GIF image.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > Config.storage.maxFileSize) {
    throw Errors.payloadTooLarge(`Images must be no larger than ${Config.storage.maxFileSize / 1024 / 1024} MB.`);
  }
  return { contentType: match[1], bytes };
}

function itemLabel(item: { cardName: string | null; setName: string; sku: string }) {
  return item.cardName?.trim() || item.setName || item.sku;
}

async function writeAlertEvent({
  tx,
  itemId,
  eventType,
  quantity,
  reorderThreshold,
  reason,
  userId,
}: {
  tx: any;
  itemId: number;
  eventType: "low_stock" | "recovered";
  quantity: number;
  reorderThreshold: number;
  reason: string;
  userId: number;
}) {
  await tx.insert(stockAlertEvents).values({
    inventoryItemId: itemId,
    eventType,
    quantity,
    reorderThreshold,
    reason,
    createdById: userId,
  });
}

export const inventoryRouter = router({
  dashboard: protectedProcedure.query(() => getInventoryDashboard()),
  
  list: protectedProcedure
    .input(listInventoryInput)
    .query(({ input }) => listInventory({
      query: input.query,
      productType: input.productType,
      condition: input.condition,
      game: input.game,
      lowStockOnly: input.lowStockOnly,
      page: input.page,
      pageSize: input.pageSize,
    })),
  
  get: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) => {
      const item = getInventoryItem(input.id);
      if (!item) throw Errors.notFound("Inventory item", input.id);
      return item;
    }),
  
  images: protectedProcedure
    .input(z.object({ inventoryItemId: z.number().int().positive() }))
    .query(({ input }) => listInventoryImages(input.inventoryItemId)),
  
  locations: protectedProcedure
    .input(z.object({ inventoryItemId: z.number().int().positive() }))
    .query(({ input }) => listInventoryLocations(input.inventoryItemId)),
  
  alertHistory: protectedProcedure
    .input(z.object({ inventoryItemId: z.number().int().positive() }).optional())
    .query(({ input }) => listStockAlertHistory(input?.inventoryItemId)),
  
  movementHistory: protectedProcedure
    .input(
      z.object({
        inventoryItemId: z.number().int().positive().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(100),
      })
    )
    .query(({ input }) => listStockMovements(input.inventoryItemId, input.page, input.pageSize)),

  create: protectedProcedure.input(itemInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw Errors.serviceUnavailable("Inventory storage is not available.");

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
        throw Errors.duplicate("SKU", input.sku);
      }

      const id = getInsertId(insertResult);
      const locationResult = await tx.insert(inventoryLocations).values({
        inventoryItemId: id,
        name: input.storageLocation.trim(),
        onHand: input.onHand,
        isPrimary: 1,
      });
      const locationId = getInsertId(locationResult);

      if (input.onHand > 0) {
        const movement = {
          inventoryItemId: id,
          movementType: "opening_balance" as const,
          delta: input.onHand,
          quantityBefore: 0,
          quantityAfter: input.onHand,
          reason: "Opening inventory balance",
          createdById: ctx.user.id,
        };
        await tx.insert(stockMovements).values(movement);
        await tx.insert(locationStockMovements).values({ ...movement, inventoryLocationId: locationId });
      }

      if (isInitiallyLow) {
        await writeAlertEvent({
          tx,
          itemId: id,
          eventType: "low_stock",
          quantity: input.onHand,
          reorderThreshold: input.reorderThreshold,
          reason: "Item opened at or below its reorder threshold",
          userId: ctx.user.id,
        });
      }

      return (await tx.select().from(inventoryItems).where(eq(inventoryItems.id, id)).limit(1))[0];
    });

    if (!created) throw Errors.internal("The inventory record could not be created.");

    if (isInitiallyLow && created) {
      await notifyOwner({
        title: `Low stock: ${itemLabel(created)}`,
        content: `${created.sku} opened at ${created.onHand} on hand, at or below its reorder threshold of ${created.reorderThreshold}.`,
      });
    }

    return created;
  }),

  addLocation: protectedProcedure
    .input(z.object({ inventoryItemId: z.number().int().positive(), name: z.string().trim().min(2).max(160) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw Errors.serviceUnavailable("Inventory storage is not available.");

      const item = await getInventoryItem(input.inventoryItemId);
      if (!item) throw Errors.notFound("Inventory record", input.inventoryItemId);

      try {
        const result = await db.insert(inventoryLocations).values({
          inventoryItemId: item.id,
          name: input.name,
          onHand: 0,
          isPrimary: 0,
        });
        return { id: getInsertId(result), inventoryItemId: item.id, name: input.name, onHand: 0, version: 0 };
      } catch (error) {
        throw Errors.duplicate("Location", input.name);
      }
    }),

  updateMetadata: protectedProcedure.input(metadataInput).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw Errors.serviceUnavailable("Inventory storage is not available.");

    const current = await getInventoryItem(input.id);
    if (!current) throw Errors.notFound("Inventory record", input.id);

    assertVersionMatches(current.version, input.expectedVersion, "Inventory record");

    const fields: Record<string, unknown> = {};
    if (input.productType !== undefined) fields.productType = input.productType;
    if (input.game !== undefined) fields.game = input.game;
    if (input.setName !== undefined) fields.setName = input.setName;
    if (input.cardName !== undefined) fields.cardName = asNullable(input.cardName);
    if (input.collectorNumber !== undefined) fields.collectorNumber = asNullable(input.collectorNumber);
    if (input.condition !== undefined) fields.condition = input.condition;
    if (input.variant !== undefined) fields.variant = asNullable(input.variant);
    if (input.sku !== undefined) fields.sku = input.sku;
    if (input.purchasePriceCents !== undefined) fields.purchasePriceCents = input.purchasePriceCents;
    if (input.salePriceCents !== undefined) fields.salePriceCents = input.salePriceCents;
    if (input.reorderThreshold !== undefined) fields.reorderThreshold = input.reorderThreshold;
    if (input.storageLocation !== undefined) fields.storageLocation = input.storageLocation;
    if (input.notes !== undefined) fields.notes = asNullable(input.notes);

    const nextThreshold = input.reorderThreshold ?? current.reorderThreshold;
    const newlyLow = nextThreshold > 0 && current.onHand <= nextThreshold && current.onHand > current.reorderThreshold;
    const recovered = current.reorderThreshold > 0 && current.onHand <= current.reorderThreshold && (nextThreshold === 0 || current.onHand > nextThreshold);

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
      throw Errors.duplicate("SKU", input.sku || current.sku);
    }

    if (!isSuccessfulWrite(writeResult)) {
      throw Errors.staleVersion("Inventory record");
    }

    if (newlyLow || recovered) {
      await db.insert(stockAlertEvents).values({
        inventoryItemId: current.id,
        eventType: newlyLow ? "low_stock" : "recovered",
        quantity: current.onHand,
        reorderThreshold: nextThreshold,
        reason: newlyLow
          ? "Reorder threshold was raised above available stock"
          : "Reorder threshold update cleared the low-stock alert",
        createdById: ctx.user.id,
      });
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
        inventoryLocationId: z.number().int().positive(),
        expectedVersion: z.number().int().min(0),
        expectedLocationVersion: z.number().int().min(0),
        delta: z.number().int().refine(value => value !== 0, "Enter a non-zero quantity."),
        movementType: z.enum(stockMovementTypes).exclude(["opening_balance", "transfer"]),
        reason: z.string().trim().min(2).max(240),
        reference: z.string().trim().max(128).nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw Errors.serviceUnavailable("Inventory storage is not available.");

      const result = await db.transaction(async tx => {
        const [current] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, input.inventoryItemId)).limit(1);
        const [location] = await tx.select()
          .from(inventoryLocations)
          .where(and(eq(inventoryLocations.id, input.inventoryLocationId), eq(inventoryLocations.inventoryItemId, input.inventoryItemId)))
          .limit(1);

        if (!current) throw Errors.notFound("Inventory record", input.inventoryItemId);
        if (!location) throw Errors.notFound("Inventory location", input.inventoryLocationId);

        assertVersionMatches(current.version, input.expectedVersion, "Inventory item");
        assertVersionMatches(location.version, input.expectedLocationVersion, "Inventory location");

        let itemPlan, locationPlan;
        try {
          itemPlan = planStockAdjustment({ onHand: current.onHand, reorderThreshold: current.reorderThreshold, delta: input.delta });
          locationPlan = planStockAdjustment({ onHand: location.onHand, reorderThreshold: 0, delta: input.delta });
        } catch (error) {
          throw Errors.badRequest(error instanceof Error ? error.message : "Invalid stock adjustment.");
        }

        const itemWrite = await tx
          .update(inventoryItems)
          .set({
            onHand: itemPlan.nextQuantity,
            version: current.version + 1,
            lowStockNotifiedAt: itemPlan.crossesBelowThreshold
              ? new Date()
              : itemPlan.recoversAboveThreshold
              ? null
              : current.lowStockNotifiedAt,
          })
          .where(and(eq(inventoryItems.id, current.id), eq(inventoryItems.version, input.expectedVersion)));

        const locationWrite = await tx
          .update(inventoryLocations)
          .set({ onHand: locationPlan.nextQuantity, version: location.version + 1 })
          .where(and(eq(inventoryLocations.id, location.id), eq(inventoryLocations.version, input.expectedLocationVersion)));

        if (!isSuccessfulWrite(itemWrite) || !isSuccessfulWrite(locationWrite)) {
          throw Errors.staleVersion("Stock");
        }

        const movement = {
          inventoryItemId: current.id,
          movementType: input.movementType,
          delta: input.delta,
          quantityBefore: current.onHand,
          quantityAfter: itemPlan.nextQuantity,
          reason: input.reason,
          reference: asNullable(input.reference),
          createdById: ctx.user.id,
        };

        await tx.insert(stockMovements).values(movement);
        await tx.insert(locationStockMovements).values({
          ...movement,
          inventoryLocationId: location.id,
          quantityBefore: location.onHand,
          quantityAfter: locationPlan.nextQuantity,
        });

        if (itemPlan.crossesBelowThreshold || itemPlan.recoversAboveThreshold) {
          await writeAlertEvent({
            tx,
            itemId: current.id,
            eventType: itemPlan.crossesBelowThreshold ? "low_stock" : "recovered",
            quantity: itemPlan.nextQuantity,
            reorderThreshold: current.reorderThreshold,
            reason: itemPlan.crossesBelowThreshold
              ? input.reason
              : "Stock level recovered above its reorder threshold",
            userId: ctx.user.id,
          });
        }

        return {
          item: { ...current, onHand: itemPlan.nextQuantity, version: current.version + 1 },
          location: { ...location, onHand: locationPlan.nextQuantity, version: location.version + 1 },
          crossedLowStock: itemPlan.crossesBelowThreshold,
        };
      });

      if (result.crossedLowStock) {
        await notifyOwner({
          title: `Low stock: ${itemLabel(result.item)}`,
          content: `${result.item.sku} reached ${result.item.onHand} on hand, at or below its reorder threshold of ${result.item.reorderThreshold}.`,
        });
      }

      return result;
    }),

  transferStock: protectedProcedure
    .input(
      z.object({
        inventoryItemId: z.number().int().positive(),
        expectedVersion: z.number().int().min(0),
        sourceLocationId: z.number().int().positive(),
        expectedSourceVersion: z.number().int().min(0),
        destinationLocationId: z.number().int().positive(),
        expectedDestinationVersion: z.number().int().min(0),
        quantity: z.number().int().positive(),
        reason: z.string().trim().min(2).max(240),
        reference: z.string().trim().max(128).nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.sourceLocationId === input.destinationLocationId) {
        throw Errors.badRequest("Choose two different locations for a transfer.");
      }

      const db = await getDb();
      if (!db) throw Errors.serviceUnavailable("Inventory storage is not available.");

      return db.transaction(async tx => {
        const [current] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, input.inventoryItemId)).limit(1);
        const [source] = await tx
          .select()
          .from(inventoryLocations)
          .where(and(eq(inventoryLocations.id, input.sourceLocationId), eq(inventoryLocations.inventoryItemId, input.inventoryItemId)))
          .limit(1);
        const [destination] = await tx
          .select()
          .from(inventoryLocations)
          .where(and(eq(inventoryLocations.id, input.destinationLocationId), eq(inventoryLocations.inventoryItemId, input.inventoryItemId)))
          .limit(1);

        if (!current) throw Errors.notFound("Inventory item", input.inventoryItemId);
        if (!source) throw Errors.notFound("Source location", input.sourceLocationId);
        if (!destination) throw Errors.notFound("Destination location", input.destinationLocationId);

        assertVersionMatches(current.version, input.expectedVersion, "Inventory item");
        assertVersionMatches(source.version, input.expectedSourceVersion, "Source location");
        assertVersionMatches(destination.version, input.expectedDestinationVersion, "Destination location");

        if (source.onHand < input.quantity) {
          throw Errors.badRequest(`${source.name} only has ${source.onHand} units available to transfer.`);
        }

        const itemWrite = await tx
          .update(inventoryItems)
          .set({ version: current.version + 1 })
          .where(and(eq(inventoryItems.id, current.id), eq(inventoryItems.version, input.expectedVersion)));

        const sourceWrite = await tx
          .update(inventoryLocations)
          .set({ onHand: source.onHand - input.quantity, version: source.version + 1 })
          .where(and(eq(inventoryLocations.id, source.id), eq(inventoryLocations.version, input.expectedSourceVersion)));

        const destinationWrite = await tx
          .update(inventoryLocations)
          .set({ onHand: destination.onHand + input.quantity, version: destination.version + 1 })
          .where(and(eq(inventoryLocations.id, destination.id), eq(inventoryLocations.version, input.expectedDestinationVersion)));

        if (!isSuccessfulWrite(itemWrite) || !isSuccessfulWrite(sourceWrite) || !isSuccessfulWrite(destinationWrite)) {
          throw Errors.staleVersion("Location stock");
        }

        const transferGroupId = nanoid(16);
        const reference = asNullable(input.reference);

        await tx.insert(stockMovements).values({
          inventoryItemId: current.id,
          movementType: "transfer",
          delta: 0,
          quantityBefore: current.onHand,
          quantityAfter: current.onHand,
          reason: `${input.reason}: ${source.name} -> ${destination.name}`,
          reference,
          createdById: ctx.user.id,
        });

        await tx.insert(locationStockMovements).values([
          {
            inventoryItemId: current.id,
            inventoryLocationId: source.id,
            movementType: "transfer",
            delta: -input.quantity,
            quantityBefore: source.onHand,
            quantityAfter: source.onHand - input.quantity,
            reason: input.reason,
            reference,
            transferGroupId,
            createdById: ctx.user.id,
          },
          {
            inventoryItemId: current.id,
            inventoryLocationId: destination.id,
            movementType: "transfer",
            delta: input.quantity,
            quantityBefore: destination.onHand,
            quantityAfter: destination.onHand + input.quantity,
            reason: input.reason,
            reference,
            transferGroupId,
            createdById: ctx.user.id,
          },
        ]);

        return {
          item: { ...current, version: current.version + 1 },
          source: { ...source, onHand: source.onHand - input.quantity, version: source.version + 1 },
          destination: { ...destination, onHand: destination.onHand + input.quantity, version: destination.version + 1 },
          transferGroupId,
        };
      });
    }),

  attachImage: protectedProcedure
    .input(z.object({
      inventoryItemId: z.number().int().positive(),
      fileName: z.string().trim().min(1).max(255),
      caption: z.string().trim().max(255).nullish(),
      dataUrl: z.string().max(7_000_000),
    }))
    .mutation(async ({ ctx, input }) => {
      const item = await getInventoryItem(input.inventoryItemId);
      if (!item) throw Errors.notFound("Inventory record", input.inventoryItemId);

      const { bytes, contentType } = parseImageData(input.dataUrl);
      const extension = contentType.split("/")[1] ?? "img";
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");

      const { key, url } = await storagePut(
        `inventory/${item.id}/${Date.now()}-${safeName || `reference.${extension}`}`,
        bytes,
        contentType
      );

      const db = await getDb();
      if (!db) throw Errors.serviceUnavailable("Inventory storage is not available.");

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
