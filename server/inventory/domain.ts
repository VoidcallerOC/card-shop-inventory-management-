export type StockAdjustmentPlan = {
  nextQuantity: number;
  crossesBelowThreshold: boolean;
  recoversAboveThreshold: boolean;
};

/**
 * Keeps the business invariants independent from transport or persistence.
 * The caller is still responsible for applying the matching versioned database update in a transaction.
 */
export function planStockAdjustment({
  onHand,
  reorderThreshold,
  delta,
}: {
  onHand: number;
  reorderThreshold: number;
  delta: number;
}): StockAdjustmentPlan {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error("A stock adjustment must be a non-zero whole number.");
  }

  const nextQuantity = onHand + delta;
  if (nextQuantity < 0) {
    throw new Error("This adjustment would make stock negative.");
  }

  const tracked = reorderThreshold > 0;
  return {
    nextQuantity,
    crossesBelowThreshold: tracked && onHand > reorderThreshold && nextQuantity <= reorderThreshold,
    recoversAboveThreshold: tracked && onHand <= reorderThreshold && nextQuantity > reorderThreshold,
  };
}
