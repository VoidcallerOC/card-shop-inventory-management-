import { describe, expect, it } from "vitest";
import { planStockAdjustment } from "./domain";

describe("planStockAdjustment", () => {
  it("records threshold crossing and recovery without permitting negative stock", () => {
    expect(planStockAdjustment({ onHand: 4, reorderThreshold: 3, delta: -1 })).toEqual({
      nextQuantity: 3,
      crossesBelowThreshold: true,
      recoversAboveThreshold: false,
    });
    expect(planStockAdjustment({ onHand: 3, reorderThreshold: 3, delta: 2 })).toEqual({
      nextQuantity: 5,
      crossesBelowThreshold: false,
      recoversAboveThreshold: true,
    });
    expect(() => planStockAdjustment({ onHand: 1, reorderThreshold: 0, delta: -2 })).toThrow("negative");
  });

  it("does not create duplicate threshold events while stock remains low", () => {
    expect(planStockAdjustment({ onHand: 2, reorderThreshold: 3, delta: -1 })).toEqual({
      nextQuantity: 1,
      crossesBelowThreshold: false,
      recoversAboveThreshold: false,
    });
  });
});

