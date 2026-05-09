import { Scorer } from "./types";

const scorers = new Map<string, Scorer>();

export function register(scorer: Scorer): void {
  scorers.set(scorer.id, scorer);
}

export function get(id: string): Scorer | undefined {
  return scorers.get(id);
}

export function list(): Scorer[] {
  return Array.from(scorers.values());
}
