import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";
import { SHOP_INTAKE_SCHEMA, buildIntakeIdempotencyKey } from "@shared/shopIntake";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  notifyOwner: vi.fn(),
  findInventoryMatchCandidates: vi.fn(),
  findStockMovementByReference: vi.fn(),
  getInventoryItemBySku: vi.fn(),
  getInventoryItem: vi.fn(),
  listInventoryLocations: vi.fn(),
}));

vi.mock("../db", () => ({
  getDb: mocks.getDb,
  getInventoryDashboard: vi.fn(),
  getInventoryItem: mocks.getInventoryItem,
  getInventoryItemBySku: mocks.getInventoryItemBySku,
  findInventoryMatchCandidates: mocks.findInventoryMatchCandidates,
  findStockMovementByReference: mocks.findStockMovementByReference,
  listInventory: vi.fn(),
  listInventoryImages: vi.fn(),
  listInventoryLocations: mocks.listInventoryLocations,
  listStockAlertHistory: vi.fn(),
  listStockMovements: vi.fn(),
}));
vi.mock("../_core/notification", () => ({ notifyOwner: mocks.notifyOwner }));
vi.mock("../storage", () => ({ storagePut: vi.fn() }));

import { inventoryRouter } from "./inventory";

function makeContext(): TrpcContext {
  return {
    user: {
      id: 21,
      openId: "staff-21",
      name: "Store Staff",
      email: "staff@example.com",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

const exportedAt = "2026-10-17T12:00:00.000Z";
const rawJson = JSON.stringify({
  schema: SHOP_INTAKE_SCHEMA,
  exportedAt,
  client: { clientId: "default", businessName: "TCG Buy Calculator", currency: "USD", buyRate: "60%" },
  summary: { count: 1, priced: 1, unpriced: 0, offerCents: 600, referenceCents: 1000 },
  items: [
    {
      key: "card-1",
      label: "Beseech the Mirror · 82",
      condition: "Near Mint",
      offerCents: 600,
      referenceCents: 1000,
      sourceUpdatedAt: "2026-10-10T00:00:00.000Z",
      unavailable: null,
    },
  ],
});

describe("inventory.previewShopIntake", () => {
  it("returns draft lines with sideEffects false and never opens a write transaction", async () => {
    mocks.findInventoryMatchCandidates.mockResolvedValue([]);
    mocks.findStockMovementByReference.mockResolvedValue(undefined);
    mocks.getDb.mockResolvedValue({
      transaction: async () => {
        throw new Error("preview must not open a write transaction");
      },
    });

    const result = await inventoryRouter.createCaller(makeContext()).previewShopIntake({
      rawJson,
      defaults: { game: "Magic: The Gathering", setName: "Wilds of Eldraine", storageLocation: "Intake" },
    });

    expect(result.sideEffects).toBe(false);
    expect(result.schema).toBe(SHOP_INTAKE_SCHEMA);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].cardName).toBe("Beseech the Mirror");
    expect(result.lines[0].collectorNumber).toBe("82");
    expect(result.lines[0].condition).toBe("near_mint");
    expect(result.lines[0].alreadyApplied).toBe(false);
  });
});

describe("inventory.confirmShopIntake", () => {
  it("creates a new SKU and records a receive movement with the intake idempotency reference", async () => {
    const inserts: unknown[] = [];
    const updates: unknown[] = [];
    const tx = {
      insert: () => ({
        values: async (values: unknown) => {
          inserts.push(values);
          return [{ insertId: inserts.length }];
        },
      }),
      update: () => ({
        set: (values: unknown) => {
          updates.push(values);
          return { where: async () => [{ affectedRows: 1 }] };
        },
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    };

    mocks.getDb.mockResolvedValue({
      transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    });
    mocks.findStockMovementByReference.mockResolvedValue(undefined);
    mocks.getInventoryItemBySku.mockResolvedValue(undefined);
    mocks.notifyOwner.mockResolvedValue(true);

    const lineId = buildIntakeIdempotencyKey(exportedAt, "card-1");
    const result = await inventoryRouter.createCaller(makeContext()).confirmShopIntake({
      exportedAt,
      lines: [
        {
          lineId,
          sourceKey: "card-1",
          included: true,
          matchMode: "create",
          matchedInventoryItemId: null,
          inventoryLocationId: null,
          expectedVersion: null,
          expectedLocationVersion: null,
          productType: "single",
          game: "Magic: The Gathering",
          setName: "Wilds of Eldraine",
          cardName: "Beseech the Mirror",
          collectorNumber: "82",
          condition: "near_mint",
          variant: null,
          sku: "MTG-WOE-082-NM",
          purchasePriceCents: 600,
          salePriceCents: 1000,
          quantity: 1,
          reorderThreshold: 0,
          storageLocation: "Intake",
          notes: "Shop intake import",
        },
      ],
    });

    expect(result.applied).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "created", lineId });
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sku: "MTG-WOE-082-NM", onHand: 0 }),
        expect.objectContaining({ movementType: "receive", delta: 1, reference: lineId }),
      ]),
    );
    expect(updates).toEqual(expect.arrayContaining([expect.objectContaining({ onHand: 1 })]));
  });

  it("skips lines that already have the intake reference (idempotent)", async () => {
    const lineId = buildIntakeIdempotencyKey(exportedAt, "card-1");
    mocks.findStockMovementByReference.mockResolvedValue({
      id: 99,
      inventoryItemId: 7,
      reference: lineId,
    });
    mocks.getDb.mockResolvedValue({
      transaction: async () => {
        throw new Error("should not write when idempotent");
      },
    });

    const result = await inventoryRouter.createCaller(makeContext()).confirmShopIntake({
      exportedAt,
      lines: [
        {
          lineId,
          sourceKey: "card-1",
          included: true,
          matchMode: "create",
          matchedInventoryItemId: null,
          inventoryLocationId: null,
          expectedVersion: null,
          expectedLocationVersion: null,
          productType: "single",
          game: "Magic: The Gathering",
          setName: "Wilds of Eldraine",
          cardName: "Beseech the Mirror",
          collectorNumber: "82",
          condition: "near_mint",
          variant: null,
          sku: "MTG-WOE-082-NM",
          purchasePriceCents: 600,
          salePriceCents: 1000,
          quantity: 1,
          reorderThreshold: 0,
          storageLocation: "Intake",
          notes: null,
        },
      ],
    });

    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.results[0].status).toBe("skipped");
  });

  it("receives into an existing SKU through version-checked ledger updates", async () => {
    const lineId = buildIntakeIdempotencyKey(exportedAt, "card-1");
    const inserts: unknown[] = [];
    const updates: unknown[] = [];
    let selectIndex = 0;
    const records = [
      {
        id: 7,
        productType: "single" as const,
        game: "Magic: The Gathering",
        setName: "Wilds of Eldraine",
        cardName: "Beseech the Mirror",
        collectorNumber: "82",
        condition: "near_mint" as const,
        variant: null,
        sku: "MTG-WOE-082-NM",
        purchasePriceCents: 500,
        salePriceCents: 900,
        onHand: 4,
        reorderThreshold: 0,
        storageLocation: "Display case",
        notes: null,
        version: 2,
        lowStockNotifiedAt: null,
        createdById: 21,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 31,
        inventoryItemId: 7,
        name: "Display case",
        onHand: 4,
        version: 5,
        isPrimary: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [records[selectIndex++]] }) }) }),
      update: () => ({
        set: (values: unknown) => {
          updates.push(values);
          return { where: async () => [{ affectedRows: 1 }] };
        },
      }),
      insert: () => ({
        values: async (values: unknown) => {
          inserts.push(values);
          return [{ insertId: inserts.length }];
        },
      }),
    };

    mocks.getDb.mockResolvedValue({
      transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    });
    mocks.findStockMovementByReference.mockResolvedValue(undefined);

    const result = await inventoryRouter.createCaller(makeContext()).confirmShopIntake({
      exportedAt,
      lines: [
        {
          lineId,
          sourceKey: "card-1",
          included: true,
          matchMode: "receive",
          matchedInventoryItemId: 7,
          inventoryLocationId: 31,
          expectedVersion: 2,
          expectedLocationVersion: 5,
          productType: "single",
          game: "Magic: The Gathering",
          setName: "Wilds of Eldraine",
          cardName: "Beseech the Mirror",
          collectorNumber: "82",
          condition: "near_mint",
          variant: null,
          sku: "MTG-WOE-082-NM",
          purchasePriceCents: 600,
          salePriceCents: 1000,
          quantity: 2,
          reorderThreshold: 0,
          storageLocation: "Display case",
          notes: null,
        },
      ],
    });

    expect(result.applied).toBe(1);
    expect(result.results[0].status).toBe("received");
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ onHand: 6, version: 3 }),
        expect.objectContaining({ onHand: 6, version: 6 }),
      ]),
    );
    expect(inserts).toEqual(
      expect.arrayContaining([expect.objectContaining({ movementType: "receive", delta: 2, reference: lineId })]),
    );
  });
});
