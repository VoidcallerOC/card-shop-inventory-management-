import { describe, expect, it } from "vitest";
import {
  SHOP_INTAKE_SCHEMA,
  buildIntakeDraftLines,
  buildIntakeIdempotencyKey,
  mapScannerCondition,
  parseIntakeLabel,
  parseShopIntakeJson,
  suggestSku,
  validateConfirmLine,
} from "./shopIntake";

const samplePayload = {
  schema: SHOP_INTAKE_SCHEMA,
  exportedAt: "2026-10-17T12:00:00.000Z",
  client: {
    clientId: "default",
    businessName: "TCG Buy Calculator",
    currency: "USD",
    buyRate: "60%",
  },
  summary: {
    count: 2,
    priced: 1,
    unpriced: 1,
    offerCents: 600,
    referenceCents: 1000,
  },
  items: [
    {
      key: "card-1",
      label: "Monkey D. Luffy · OP01-001 · Parallel",
      condition: "Near Mint",
      offerCents: 600,
      referenceCents: 1000,
      sourceUpdatedAt: "2026-10-10T00:00:00.000Z",
      unavailable: null,
    },
    {
      key: "card-2",
      label: "Stale card",
      condition: "Lightly Played",
      offerCents: null,
      referenceCents: null,
      sourceUpdatedAt: null,
      unavailable: "price out of date",
    },
  ],
};

describe("parseShopIntakeJson", () => {
  it("accepts the verified v1 schema", () => {
    const result = parseShopIntakeJson(JSON.stringify(samplePayload));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.schema).toBe(SHOP_INTAKE_SCHEMA);
      expect(result.payload.items).toHaveLength(2);
    }
  });

  it("rejects wrong schema ids and empty items", () => {
    expect(parseShopIntakeJson('{"schema":"other","exportedAt":"x","client":{},"summary":{},"items":[]}')).toMatchObject({
      ok: false,
    });
    expect(parseShopIntakeJson("not-json")).toMatchObject({ ok: false });
  });
});

describe("label and condition mapping", () => {
  it("parses scanner cardLabel parts", () => {
    expect(parseIntakeLabel("Monkey D. Luffy · OP01-001 · Parallel")).toEqual({
      cardName: "Monkey D. Luffy",
      collectorNumber: "OP01-001",
      variant: "Parallel",
    });
    expect(parseIntakeLabel("Solo Name")).toEqual({
      cardName: "Solo Name",
      collectorNumber: null,
      variant: null,
    });
  });

  it("maps scanner condition names and codes", () => {
    expect(mapScannerCondition("Near Mint")).toBe("near_mint");
    expect(mapScannerCondition("LP")).toBe("lightly_played");
    expect(mapScannerCondition("unknown")).toBeNull();
  });
});

describe("draft lines and confirm validation", () => {
  it("builds review drafts with staff-required gaps flagged and no auto-merge", () => {
    const lines = buildIntakeDraftLines(samplePayload as never, {
      game: "One Piece",
      setName: "Romance Dawn",
      storageLocation: "Intake",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0].cardName).toBe("Monkey D. Luffy");
    expect(lines[0].collectorNumber).toBe("OP01-001");
    expect(lines[0].condition).toBe("near_mint");
    expect(lines[0].matchMode).toBe("create");
    expect(lines[0].matchedInventoryItemId).toBeNull();
    expect(lines[0].sku).toContain("NM");
    expect(lines[0].lineId).toBe(buildIntakeIdempotencyKey(samplePayload.exportedAt, "card-1"));
    expect(lines[1].issues.some(issue => /Unpriced/i.test(issue))).toBe(true);
  });

  it("requires receive matches and positive quantities before confirm", () => {
    expect(
      validateConfirmLine({
        included: true,
        condition: "near_mint",
        cardName: "Luffy",
        game: "One Piece",
        setName: "OP01",
        sku: "OP-OP01-001-NM",
        storageLocation: "Intake",
        quantity: 1,
        matchMode: "receive",
        matchedInventoryItemId: null,
        purchasePriceCents: 100,
        salePriceCents: 200,
      }),
    ).toContain("Receive mode requires a matched inventory item.");

    expect(
      validateConfirmLine({
        included: true,
        condition: "near_mint",
        cardName: "Luffy",
        game: "One Piece",
        setName: "OP01",
        sku: "OP-OP01-001-NM",
        storageLocation: "Intake",
        quantity: 0,
        matchMode: "create",
        matchedInventoryItemId: null,
        purchasePriceCents: 100,
        salePriceCents: 200,
      }),
    ).toContain("Quantity must be a positive whole number.");
  });

  it("suggests deterministic SKUs", () => {
    expect(
      suggestSku({
        game: "One Piece",
        setName: "Romance Dawn",
        collectorNumber: "OP01-001",
        condition: "near_mint",
      }),
    ).toBe("ONE-PIEC-ROMANCE-DA-OP01-001-NM");
  });
});
