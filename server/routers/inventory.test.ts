import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  notifyOwner: vi.fn(),
}));

vi.mock("../db", () => ({
  getDb: mocks.getDb,
  getInventoryDashboard: vi.fn(),
  getInventoryItem: vi.fn(),
  listInventory: vi.fn(),
  listInventoryImages: vi.fn(),
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

function record(overrides: Partial<{ onHand: number; reorderThreshold: number; version: number }> = {}) {
  return {
    id: 7,
    productType: "single" as const,
    game: "Magic: The Gathering",
    setName: "Wilds of Eldraine",
    cardName: "Beseech the Mirror",
    collectorNumber: "82",
    condition: "near_mint" as const,
    variant: null,
    sku: "MTG-WOE-082-NM",
    purchasePriceCents: 1200,
    salePriceCents: 2100,
    onHand: 4,
    reorderThreshold: 3,
    storageLocation: "Case A · Slot 12",
    notes: null,
    version: 2,
    lowStockNotifiedAt: null,
    createdById: 21,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("inventory.adjustStock", () => {
  it("uses a versioned write, inserts an immutable movement line, and signals a low-stock threshold crossing", async () => {
    const current = record();
    let updatedValues: Record<string, unknown> | undefined;
    let movementValues: Record<string, unknown> | undefined;
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [current] }) }) }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updatedValues = values;
          return { where: async () => [{ affectedRows: 1 }] };
        },
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          movementValues = values;
          return [{ insertId: 1 }];
        },
      }),
    };
    mocks.getDb.mockResolvedValue({ transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) });
    mocks.notifyOwner.mockResolvedValue(true);

    const result = await inventoryRouter.createCaller(makeContext()).adjustStock({
      inventoryItemId: 7,
      expectedVersion: 2,
      delta: -1,
      movementType: "sale",
      reason: "Point-of-sale transaction",
      reference: "POS-1042",
    });

    expect(result.item).toMatchObject({ id: 7, onHand: 3, version: 3 });
    expect(updatedValues).toMatchObject({ onHand: 3, version: 3 });
    expect(movementValues).toMatchObject({
      inventoryItemId: 7,
      movementType: "sale",
      delta: -1,
      quantityBefore: 4,
      quantityAfter: 3,
      reason: "Point-of-sale transaction",
      reference: "POS-1042",
      createdById: 21,
    });
    expect(mocks.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ title: "Low stock: Beseech the Mirror" }));
  });

  it("rejects a stale staff edit before it can write a movement record", async () => {
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [record({ version: 3 })] }) }) }),
      update: vi.fn(),
      insert: vi.fn(),
    };
    mocks.getDb.mockResolvedValue({ transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) });

    await expect(
      inventoryRouter.createCaller(makeContext()).adjustStock({
        inventoryItemId: 7,
        expectedVersion: 2,
        delta: 1,
        movementType: "receive",
        reason: "Distributor delivery",
        reference: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
