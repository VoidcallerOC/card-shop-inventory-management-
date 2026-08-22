export const PRODUCT_TYPES = ["single", "sealed"] as const;
export const CONDITIONS = [
  "near_mint",
  "lightly_played",
  "moderately_played",
  "heavily_played",
  "damaged",
  "sealed",
] as const;

export const MOVEMENT_TYPES = ["receive", "sale", "return", "adjustment", "correction"] as const;

export function titleCase(value: string | null | undefined) {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, character => character.toUpperCase());
}

export function formatMoney(cents: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100);
}

export function formatDate(date: Date | string | null | undefined, includeTime = false) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(new Date(date));
}

export function dollarsToCents(value: string | number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

export function centsToDollars(value: number) {
  return (value / 100).toFixed(2);
}

export function itemName(item: { cardName: string | null; setName: string; productType: string }) {
  return item.cardName || (item.productType === "sealed" ? item.setName : "Untitled single");
}

export function isLowStock(item: { onHand: number; reorderThreshold: number }) {
  return item.reorderThreshold > 0 && item.onHand <= item.reorderThreshold;
}
