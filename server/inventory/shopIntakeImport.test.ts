import { describe, expect, it } from "vitest";
import { SHOP_INTAKE_SCHEMA, buildIntakeIdempotencyKey } from "@shared/shopIntake";
import {
  attachMatchSuggestions,
  parseAndDraftIntake,
  validateConfirmBatch,
} from "./shopIntakeImport";

const raw = JSON.stringify({
  schema: SHOP_INTAKE_SCHEMA,
  exportedAt: "2026-10-17T12:00:00.000Z",
  client: { clientId: "default", businessName: "TCG Buy Calculator", currency: "USD", buyRate: "60%" },
  summary: { count: 1, priced: 1, unpriced: 0, offerCents: 600, referenceCents: 1000 },
  items: [
    {
      key: "card-1",
      label: "Example · 001",
      condition: "Near Mint",
      offerCents: 600,
      referenceCents: 1000,
      sourceUpdatedAt: "2026-10-10T00:00:00.000Z",
      unavailable: null,
    },
  ],
});

describe("parseAndDraftIntake", () => {
  it("parses export and drafts review lines without mutating callers", () => {
    const first = parseAndDraftIntake(raw, {
      game: "Magic: The Gathering",
      setName: "Demo Set",
      storageLocation: "Intake",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.lines[0].cardName).toBe("Example");
    expect(first.lines[0].collectorNumber).toBe("001");
    expect(first.lines[0].offerCents).toBe(600);
  });

  it("rejects invalid files before any draft is built", () => {
    expect(parseAndDraftIntake("{}")).toMatchObject({ ok: false });
  });
});

describe("attachMatchSuggestions", () => {
  it("suggests receive when an exact SKU match exists but does not auto-apply writes", () => {
    const drafted = parseAndDraftIntake(raw, {
      game: "Magic: The Gathering",
      setName: "Demo Set",
      storageLocation: "Intake",
    });
    if (!drafted.ok) throw new Error("expected draft");
    const sku = drafted.lines[0].sku;
    const enriched = attachMatchSuggestions(drafted.lines, () => [
      {
        id: 9,
        productType: "single",
        game: "Magic: The Gathering",
        setName: "Demo Set",
        cardName: "Example",
        collectorNumber: "001",
        condition: "near_mint",
        variant: null,
        sku,
        purchasePriceCents: 600,
        salePriceCents: 1000,
        onHand: 2,
        reorderThreshold: 0,
        storageLocation: "Intake",
        notes: null,
        version: 1,
        lowStockNotifiedAt: null,
        createdById: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    expect(enriched[0].matchMode).toBe("receive");
    expect(enriched[0].matchedInventoryItemId).toBe(9);
    expect(enriched[0].matchSuggestions).toHaveLength(1);
  });
});

describe("validateConfirmBatch", () => {
  it("blocks confirm when required fields are missing", () => {
    const lineId = buildIntakeIdempotencyKey("2026-10-17T12:00:00.000Z", "card-1");
    const result = validateConfirmBatch("2026-10-17T12:00:00.000Z", [
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
        game: "",
        setName: "Set",
        cardName: "Example",
        collectorNumber: "001",
        condition: "near_mint",
        variant: null,
        sku: "AB",
        purchasePriceCents: 0,
        salePriceCents: 0,
        quantity: 1,
        reorderThreshold: 0,
        storageLocation: "Intake",
        notes: null,
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lineErrors[lineId].some(msg => /Game/i.test(msg))).toBe(true);
    }
  });
});
