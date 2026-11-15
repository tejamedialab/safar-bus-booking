import { z } from 'zod';

/**
 * Configurable cancellation rule set.
 * Each tier says: "if the passenger cancels at least N hours before their boarding time,
 * refund P% of the fare". The highest tier that applies wins. If no tier applies,
 * cancellation is not allowed (the window has closed).
 */
export const CancellationRuleSchema = z.object({
  minHoursBeforeDeparture: z.number().int().min(0).max(24 * 30),
  refundPercent: z.number().int().min(0).max(100),
});
export type CancellationRule = z.infer<typeof CancellationRuleSchema>;

export const CancellationRulesSchema = z
  .array(CancellationRuleSchema)
  .min(1)
  .max(10)
  .superRefine((rules, ctx) => {
    const hours = rules.map((r) => r.minHoursBeforeDeparture);
    if (new Set(hours).size !== hours.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each tier needs a distinct hour threshold' });
    }
    // Refunds must never increase as departure approaches.
    const sorted = [...rules].sort((a, b) => b.minHoursBeforeDeparture - a.minHoursBeforeDeparture);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].refundPercent > sorted[i - 1].refundPercent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Refund percent must not increase as departure gets closer',
        });
        break;
      }
    }
  });

export interface CancellationDecision {
  allowed: boolean;
  refundPercent: number;
  appliedRule: CancellationRule | null;
  hoursBeforeDeparture: number;
}

export function evaluateCancellation(
  rules: CancellationRule[],
  boardingAt: Date,
  now: Date,
): CancellationDecision {
  const hoursBeforeDeparture = (boardingAt.getTime() - now.getTime()) / 3_600_000;
  const sorted = [...rules].sort((a, b) => b.minHoursBeforeDeparture - a.minHoursBeforeDeparture);
  const rule = hoursBeforeDeparture >= 0 ? sorted.find((r) => hoursBeforeDeparture >= r.minHoursBeforeDeparture) : undefined;
  return {
    allowed: Boolean(rule),
    refundPercent: rule?.refundPercent ?? 0,
    appliedRule: rule ?? null,
    hoursBeforeDeparture: Math.round(hoursBeforeDeparture * 100) / 100,
  };
}

/** Refunds are rounded down to the paisa so we never refund more than the rule allows. */
export function refundAmountPaise(farePaise: number, refundPercent: number): number {
  return Math.floor((farePaise * refundPercent) / 100);
}

export const DEFAULT_CANCELLATION_RULES: CancellationRule[] = [
  { minHoursBeforeDeparture: 48, refundPercent: 90 },
  { minHoursBeforeDeparture: 24, refundPercent: 75 },
  { minHoursBeforeDeparture: 12, refundPercent: 50 },
  { minHoursBeforeDeparture: 3, refundPercent: 25 },
];
