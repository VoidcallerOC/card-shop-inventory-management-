import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), notifyOwner: vi.fn() }));
vi.mock("../db", () => ({
  getDb: mocks.getDb,
  getInventoryDashboard: vi.fn(),
  getInventoryItem: vi.fn(),
  listInventory: vi.fn(),
  listInventoryImages: vi.fn(),
  listInventoryLocations: vi.fn(),
  listStockAlertHistory: vi.fn(),
  listStockMovements: vi.fn(),
}));
vi.mock("../_core/notification", () => ({ notifyOwner: mocks.notifyOwner }));
vi.mock("../storage", () => ({ storagePut: vi.fn() }));

import { inventoryRouter } from "./inventory";

function makeContext(): TrpcContext {
  return { user: { id: 21, openId: "staff-21", name: "Store Staff", email: "staff@example.com", loginMethod: "manus", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() }, req: {} as TrpcContext["req"], res: {} as TrpcContext["res"] };
}
function record(overrides: Partial<{ onHand: number; reorderThreshold: number; version: number }> = {}) {
  return { id: 7, productType: "single" as const, game: "Magic: The Gathering", setName: "Wilds of Eldraine", cardName: "Beseech the Mirror", collectorNumber: "82", condition: "near_mint" as const, variant: null, sku: "MTG-WOE-082-NM", purchasePriceCents: 1200, salePriceCents: 2100, onHand: 4, reorderThreshold: 3, storageLocation: "Display case", notes: null, version: 2, lowStockNotifiedAt: null, createdById: 21, createdAt: new Date(), updatedAt: new Date(), ...overrides };
}
function location(id: number, name: string, onHand: number, version: number) {
  return { id, inventoryItemId: 7, name, onHand, version, isPrimary: id === 31 ? 1 : 0, createdAt: new Date(), updatedAt: new Date() };
}
function transactionalDb(records: unknown[]) {
  let selectIndex = 0;
  const updates: Record<string, unknown>[] = [];
  const inserts: unknown[] = [];
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [records[selectIndex++]] }) }) }),
    update: () => ({ set: (values: Record<string, unknown>) => { updates.push(values); return { where: async () => [{ affectedRows: 1 }] }; } }),
    insert: () => ({ values: async (values: unknown) => { inserts.push(values); return [{ insertId: inserts.length }]; } }),
  };
  return { tx, updates, inserts };
}

describe("inventory.adjustStock", () => {
  it("updates the selected location and item total atomically, retains both movement records, and signals a threshold crossing", async () => {
    const fixture = transactionalDb([record(), location(31, "Display case", 4, 5)]);
    mocks.getDb.mockResolvedValue({ transaction: async (callback: (transaction: typeof fixture.tx) => Promise<unknown>) => callback(fixture.tx) });
    mocks.notifyOwner.mockResolvedValue(true);
    const result = await inventoryRouter.createCaller(makeContext()).adjustStock({ inventoryItemId: 7, inventoryLocationId: 31, expectedVersion: 2, expectedLocationVersion: 5, delta: -1, movementType: "sale", reason: "Point-of-sale transaction", reference: "POS-1042" });
    expect(result.item).toMatchObject({ id: 7, onHand: 3, version: 3 });
    expect(result.location).toMatchObject({ id: 31, onHand: 3, version: 6 });
    expect(fixture.updates).toEqual(expect.arrayContaining([expect.objectContaining({ onHand: 3, version: 3 }), expect.objectContaining({ onHand: 3, version: 6 })]));
    expect(fixture.inserts).toEqual(expect.arrayContaining([expect.objectContaining({ movementType: "sale", delta: -1, quantityBefore: 4, quantityAfter: 3, createdById: 21 }), expect.objectContaining({ inventoryLocationId: 31, movementType: "sale", delta: -1, quantityBefore: 4, quantityAfter: 3 })]));
    expect(mocks.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ title: "Low stock: Beseech the Mirror" }));
  });

  it("rejects a stale staff edit before it can write either ledger", async () => {
    const fixture = transactionalDb([record({ version: 3 }), location(31, "Display case", 4, 5)]);
    mocks.getDb.mockResolvedValue({ transaction: async (callback: (transaction: typeof fixture.tx) => Promise<unknown>) => callback(fixture.tx) });
    await expect(inventoryRouter.createCaller(makeContext()).adjustStock({ inventoryItemId: 7, inventoryLocationId: 31, expectedVersion: 2, expectedLocationVersion: 5, delta: 1, movementType: "receive", reason: "Distributor delivery", reference: null })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.updates).toHaveLength(0);
    expect(fixture.inserts).toHaveLength(0);
  });
});

describe("inventory.transferStock", () => {
  it("moves stock between locations without changing total availability and preserves paired transfer entries", async () => {
    const fixture = transactionalDb([record(), location(31, "Display case", 4, 5), location(32, "Backstock", 0, 2)]);
    mocks.getDb.mockResolvedValue({ transaction: async (callback: (transaction: typeof fixture.tx) => Promise<unknown>) => callback(fixture.tx) });
    const result = await inventoryRouter.createCaller(makeContext()).transferStock({ inventoryItemId: 7, expectedVersion: 2, sourceLocationId: 31, expectedSourceVersion: 5, destinationLocationId: 32, expectedDestinationVersion: 2, quantity: 2, reason: "Move to backstock", reference: "TR-22" });
    expect(result.item).toMatchObject({ id: 7, onHand: 4, version: 3 });
    expect(result.source).toMatchObject({ id: 31, onHand: 2, version: 6 });
    expect(result.destination).toMatchObject({ id: 32, onHand: 2, version: 3 });
    expect(fixture.updates).toEqual(expect.arrayContaining([expect.objectContaining({ version: 3 }), expect.objectContaining({ onHand: 2, version: 6 }), expect.objectContaining({ onHand: 2, version: 3 })]));
    expect(fixture.inserts[0]).toMatchObject({ movementType: "transfer", delta: 0, quantityBefore: 4, quantityAfter: 4, reference: "TR-22" });
    expect(fixture.inserts[1]).toEqual(expect.arrayContaining([expect.objectContaining({ inventoryLocationId: 31, delta: -2, quantityBefore: 4, quantityAfter: 2 }), expect.objectContaining({ inventoryLocationId: 32, delta: 2, quantityBefore: 0, quantityAfter: 2 })]));
  });
});
