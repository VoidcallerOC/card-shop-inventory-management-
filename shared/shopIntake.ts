import { z } from "zod";

export const SHOP_INTAKE_SCHEMA = "tcg-buy-calculator.shop-intake.v1" as const;

export const intakeInventoryConditions = [
  "near_mint",
  "lightly_played",
  "moderately_played",
  "heavily_played",
  "damaged",
  "sealed",
] as const;

export const shopIntakeItemSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  condition: z.string(),
  offerCents: z.number().int().nullable().optional(),
  referenceCents: z.number().int().nullable().optional(),
  sourceUpdatedAt: z.string().nullable().optional(),
  unavailable: z.string().nullable().optional(),
});

export const shopIntakePayloadSchema = z.object({
  schema: z.literal(SHOP_INTAKE_SCHEMA),
  exportedAt: z.string().min(1),
  client: z
    .object({
      clientId: z.string().nullable().optional(),
      businessName: z.string().nullable().optional(),
      currency: z.string().nullable().optional(),
      buyRate: z.string().nullable().optional(),
    })
    .passthrough(),
  summary: z
    .object({
      count: z.number().int(),
      priced: z.number().int(),
      unpriced: z.number().int(),
      offerCents: z.number().int(),
      referenceCents: z.number().int(),
    })
    .passthrough(),
  items: z.array(shopIntakeItemSchema).min(1),
});

export type ShopIntakePayload = z.infer<typeof shopIntakePayloadSchema>;
export type ShopIntakeItem = z.infer<typeof shopIntakeItemSchema>;
export type InventoryCondition = (typeof intakeInventoryConditions)[number];

const CONDITION_ALIASES: Record<string, InventoryCondition> = {
  "near mint": "near_mint",
  nm: "near_mint",
  near_mint: "near_mint",
  "lightly played": "lightly_played",
  lp: "lightly_played",
  lightly_played: "lightly_played",
  "moderately played": "moderately_played",
  mp: "moderately_played",
  moderately_played: "moderately_played",
  "heavily played": "heavily_played",
  hp: "heavily_played",
  heavily_played: "heavily_played",
  damaged: "damaged",
  dmg: "damaged",
  sealed: "sealed",
};

const COLLECTOR_NUMBER = /^[A-Za-z0-9][A-Za-z0-9./-]{0,47}$/;

export type ParsedLabel = {
  cardName: string;
  collectorNumber: string | null;
  variant: string | null;
};

export function parseShopIntakeJson(raw: string):
  | { ok: true; payload: ShopIntakePayload }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "File is not valid JSON." };
  }
  const result = shopIntakePayloadSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.length ? issue.path.join(".") : "payload";
    return {
      ok: false,
      error: `Invalid shop intake export (${path}): ${issue?.message ?? "schema mismatch"}. Expected schema ${SHOP_INTAKE_SCHEMA}.`,
    };
  }
  return { ok: true, payload: result.data };
}

export function mapScannerCondition(raw: string): InventoryCondition | null {
  const key = raw.trim().toLowerCase();
  return CONDITION_ALIASES[key] ?? null;
}

export function parseIntakeLabel(label: string): ParsedLabel {
  const parts = label
    .split("·")
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { cardName: "", collectorNumber: null, variant: null };
  }
  if (parts.length === 1) {
    return { cardName: parts[0], collectorNumber: null, variant: null };
  }
  const cardName = parts[0];
  const maybeNumber = parts[1];
  if (COLLECTOR_NUMBER.test(maybeNumber) && !/\s/.test(maybeNumber)) {
    const rest = parts.slice(2).join(" · ");
    return {
      cardName,
      collectorNumber: maybeNumber,
      variant: rest || null,
    };
  }
  return {
    cardName,
    collectorNumber: null,
    variant: parts.slice(1).join(" · ") || null,
  };
}

export function buildIntakeIdempotencyKey(exportedAt: string, itemKey: string) {
  const raw = `intake:${exportedAt}:${itemKey}`;
  return raw.length <= 128 ? raw : raw.slice(0, 128);
}

export function slugPart(value: string, max = 12) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "X";
}

export function suggestSku({
  game,
  setName,
  collectorNumber,
  condition,
}: {
  game: string;
  setName: string;
  collectorNumber: string | null;
  condition: InventoryCondition | null;
}) {
  const cond =
    condition === "near_mint"
      ? "NM"
      : condition === "lightly_played"
        ? "LP"
        : condition === "moderately_played"
          ? "MP"
          : condition === "heavily_played"
            ? "HP"
            : condition === "damaged"
              ? "DMG"
              : condition === "sealed"
                ? "SLD"
                : "XX";
  return [
    slugPart(game, 8),
    slugPart(setName, 10),
    slugPart(collectorNumber || "000", 16),
    cond,
  ].join("-");
}

export type IntakeDraftLine = {
  lineId: string;
  sourceKey: string;
  label: string;
  sourceCondition: string;
  condition: InventoryCondition | null;
  cardName: string;
  collectorNumber: string | null;
  variant: string | null;
  offerCents: number;
  referenceCents: number;
  unavailable: string | null;
  quantity: number;
  productType: "single" | "sealed";
  game: string;
  setName: string;
  sku: string;
  storageLocation: string;
  reorderThreshold: number;
  notes: string;
  included: boolean;
  matchMode: "create" | "receive";
  matchedInventoryItemId: number | null;
  issues: string[];
};

export function buildIntakeDraftLines(
  payload: ShopIntakePayload,
  defaults?: { game?: string; setName?: string; storageLocation?: string },
): IntakeDraftLine[] {
  const game = defaults?.game?.trim() ?? "";
  const setName = defaults?.setName?.trim() ?? "";
  const storageLocation = defaults?.storageLocation?.trim() ?? "";
  const business = payload.client.businessName?.trim();

  return payload.items.map(item => {
    const parsed = parseIntakeLabel(item.label);
    const condition = mapScannerCondition(item.condition);
    const offerCents =
      typeof item.offerCents === "number" && Number.isInteger(item.offerCents) && item.offerCents >= 0
        ? item.offerCents
        : 0;
    const referenceCents =
      typeof item.referenceCents === "number" &&
      Number.isInteger(item.referenceCents) &&
      item.referenceCents >= 0
        ? item.referenceCents
        : 0;
    const sku =
      game && setName
        ? suggestSku({
            game,
            setName,
            collectorNumber: parsed.collectorNumber,
            condition,
          })
        : "";
    const issues: string[] = [];
    if (!condition) issues.push("Condition needs staff mapping.");
    if (!parsed.cardName.trim()) issues.push("Card name is empty.");
    if (!game) issues.push("Game is required.");
    if (!setName) issues.push("Set is required.");
    if (!storageLocation) issues.push("Storage location is required.");
    if (!sku) issues.push("SKU is required.");
    if (item.unavailable) issues.push(`Unpriced at export: ${item.unavailable}`);

    const noteParts = [
      business ? `Shop intake from ${business}` : "Shop intake import",
      `export ${payload.exportedAt}`,
      `key ${item.key}`,
    ];

    return {
      lineId: buildIntakeIdempotencyKey(payload.exportedAt, item.key),
      sourceKey: item.key,
      label: item.label,
      sourceCondition: item.condition,
      condition,
      cardName: parsed.cardName,
      collectorNumber: parsed.collectorNumber,
      variant: parsed.variant,
      offerCents,
      referenceCents,
      unavailable: item.unavailable ?? null,
      quantity: 1,
      productType: "single" as const,
      game,
      setName,
      sku,
      storageLocation,
      reorderThreshold: 0,
      notes: noteParts.join(" · "),
      included: true,
      matchMode: "create" as const,
      matchedInventoryItemId: null,
      issues,
    };
  });
}

export function validateConfirmLine(line: {
  included: boolean;
  condition: InventoryCondition | null;
  cardName: string;
  game: string;
  setName: string;
  sku: string;
  storageLocation: string;
  quantity: number;
  matchMode: "create" | "receive";
  matchedInventoryItemId: number | null;
  purchasePriceCents: number;
  salePriceCents: number;
}) {
  if (!line.included) return [] as string[];
  const issues: string[] = [];
  if (!line.condition) issues.push("Condition is required.");
  if (!line.cardName.trim()) issues.push("Card name is required.");
  if (!line.game.trim()) issues.push("Game is required.");
  if (!line.setName.trim()) issues.push("Set is required.");
  if (!line.sku.trim() || line.sku.trim().length < 2) issues.push("SKU is required.");
  if (!line.storageLocation.trim()) issues.push("Storage location is required.");
  if (!Number.isInteger(line.quantity) || line.quantity < 1) issues.push("Quantity must be a positive whole number.");
  if (!Number.isInteger(line.purchasePriceCents) || line.purchasePriceCents < 0) {
    issues.push("Purchase price must be a non-negative integer (cents).");
  }
  if (!Number.isInteger(line.salePriceCents) || line.salePriceCents < 0) {
    issues.push("Sale price must be a non-negative integer (cents).");
  }
  if (line.matchMode === "receive" && (!line.matchedInventoryItemId || line.matchedInventoryItemId < 1)) {
    issues.push("Receive mode requires a matched inventory item.");
  }
  return issues;
}
