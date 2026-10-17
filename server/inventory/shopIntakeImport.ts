import {
  buildIntakeDraftLines,
  buildIntakeIdempotencyKey,
  parseShopIntakeJson,
  suggestSku,
  validateConfirmLine,
  type IntakeDraftLine,
  type InventoryCondition,
  type ShopIntakePayload,
} from "@shared/shopIntake";
import type { InventoryItem } from "../../drizzle/schema";

export type IntakeMatchSuggestion = {
  id: number;
  sku: string;
  cardName: string | null;
  setName: string;
  game: string;
  condition: string;
  onHand: number;
  version: number;
};

export type IntakePreviewLine = IntakeDraftLine & {
  matchSuggestions: IntakeMatchSuggestion[];
};

export type IntakeConfirmLineInput = {
  lineId: string;
  sourceKey: string;
  included: boolean;
  matchMode: "create" | "receive";
  matchedInventoryItemId: number | null;
  inventoryLocationId: number | null;
  expectedVersion: number | null;
  expectedLocationVersion: number | null;
  productType: "single" | "sealed";
  game: string;
  setName: string;
  cardName: string;
  collectorNumber: string | null;
  condition: InventoryCondition | null;
  variant: string | null;
  sku: string;
  purchasePriceCents: number;
  salePriceCents: number;
  quantity: number;
  reorderThreshold: number;
  storageLocation: string;
  notes: string | null;
};

export function parseAndDraftIntake(
  rawJson: string,
  defaults?: { game?: string; setName?: string; storageLocation?: string },
): { ok: true; payload: ShopIntakePayload; lines: IntakeDraftLine[] } | { ok: false; error: string } {
  const parsed = parseShopIntakeJson(rawJson);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    payload: parsed.payload,
    lines: buildIntakeDraftLines(parsed.payload, defaults),
  };
}

export function attachMatchSuggestions(
  lines: IntakeDraftLine[],
  lookup: (line: IntakeDraftLine) => InventoryItem[],
): IntakePreviewLine[] {
  return lines.map(line => {
    const matches = lookup(line);
    const suggestions: IntakeMatchSuggestion[] = matches.map(item => ({
      id: item.id,
      sku: item.sku,
      cardName: item.cardName,
      setName: item.setName,
      game: item.game,
      condition: item.condition,
      onHand: item.onHand,
      version: item.version,
    }));

    let next: IntakePreviewLine = { ...line, matchSuggestions: suggestions };

    if (suggestions.length === 1 && line.sku && suggestions[0].sku === line.sku) {
      next = {
        ...next,
        matchMode: "receive",
        matchedInventoryItemId: suggestions[0].id,
        issues: next.issues.filter(issue => issue !== "SKU is required."),
      };
    } else if (!line.sku && line.game && line.setName && line.condition) {
      next = {
        ...next,
        sku: suggestSku({
          game: line.game,
          setName: line.setName,
          collectorNumber: line.collectorNumber,
          condition: line.condition,
        }),
        issues: next.issues.filter(issue => issue !== "SKU is required."),
      };
    }

    return next;
  });
}

export function validateConfirmBatch(
  exportedAt: string,
  lines: IntakeConfirmLineInput[],
): { ok: true; included: IntakeConfirmLineInput[] } | { ok: false; error: string; lineErrors: Record<string, string[]> } {
  const included = lines.filter(line => line.included);
  if (included.length === 0) {
    return { ok: false, error: "Select at least one line to confirm.", lineErrors: {} };
  }

  const lineErrors: Record<string, string[]> = {};
  for (const line of included) {
    const expectedId = buildIntakeIdempotencyKey(exportedAt, line.sourceKey);
    const issues = validateConfirmLine(line);
    if (line.lineId !== expectedId) {
      issues.push("Idempotency line id does not match export key.");
    }
    if (issues.length) lineErrors[line.lineId] = issues;
  }

  if (Object.keys(lineErrors).length) {
    return { ok: false, error: "Fix review issues before confirming.", lineErrors };
  }

  return { ok: true, included };
}
