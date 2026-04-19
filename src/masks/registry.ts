import { MaskFactory, MaskContext } from "./types";

/**
 * Picks which MaskFactory to use for a given card. Strategies:
 *  - "fixed": always the first factory
 *  - "random": pick uniformly at random per card
 *  - "by-price": expensive products get harder masks (demo of context use)
 */
export type PickStrategy = "fixed" | "random" | "by-price";

export class MaskRegistry {
  private factories: MaskFactory[] = [];

  constructor(private strategy: PickStrategy = "random") {}

  get size(): number {
    return this.factories.length;
  }

  register(factory: MaskFactory): this {
    this.factories.push(factory);
    return this;
  }

  setStrategy(strategy: PickStrategy): void {
    this.strategy = strategy;
  }

  pick(ctx: MaskContext): MaskFactory {
    if (this.factories.length === 0) {
      throw new Error("MaskRegistry has no factories registered");
    }
    if (this.factories.length === 1) return this.factories[0];

    switch (this.strategy) {
      case "fixed":
        return this.factories[0];

      case "random": {
        const idx = Math.floor(Math.random() * this.factories.length);
        return this.factories[idx];
      }

      case "by-price": {
        // Tries to extract a numeric price from the features.
        const priceText = ctx.features.price ?? "";
        const numeric = parseInt(priceText.replace(/[^\d]/g, ""), 10);
        // Heuristic: pricier products get the later (harder) factories
        if (Number.isFinite(numeric) && numeric > 500_000) {
          return this.factories[this.factories.length - 1];
        }
        return this.factories[0];
      }
    }
  }
}
