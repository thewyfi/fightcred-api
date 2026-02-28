/**
 * Unified type exports
 * Import shared types from this single entry point.
 */

export type * from "../drizzle/schema";
export * from "./_core/errors";

// ─── FightCred Domain Types ───────────────────────────────────────────────────

export type FinishType = "finish" | "decision";
export type MethodType = "tko_ko" | "submission" | "decision" | "draw" | "nc";
export type PredictionStatus = "pending" | "correct" | "wrong" | "partial";
export type EventStatus = "upcoming" | "live" | "completed";
export type FightStatus = "upcoming" | "live" | "completed" | "cancelled";
export type CardSection = "main" | "prelim" | "early_prelim";
export type CredibilityTier = "rookie" | "contender" | "champion" | "goat";

export interface CredibilityBreakdown {
  winnerPoints: number;
  finishTypePoints: number;
  methodPoints: number;
  underdogBonus: number;
  perfectPickBonus: number;
  totalPoints: number;
  multiplier: number;
  impliedProbability: number;
}

export const TIER_THRESHOLDS: Record<CredibilityTier, number> = {
  rookie: 0,
  contender: 1000,
  champion: 5000,
  goat: 15000,
};

export const TIER_LABELS: Record<CredibilityTier, string> = {
  rookie: "ROOKIE",
  contender: "CONTENDER",
  champion: "CHAMPION",
  goat: "G.O.A.T.",
};

export const TIER_COLORS: Record<CredibilityTier, string> = {
  rookie: "#9A9A9A",
  contender: "#C0C0C0",
  champion: "#C9A84C",
  goat: "#D20A0A",
};

export function getTierFromScore(score: number): CredibilityTier {
  if (score >= 15000) return "goat";
  if (score >= 5000) return "champion";
  if (score >= 1000) return "contender";
  return "rookie";
}

export function formatOdds(odds: number | null | undefined): string {
  if (odds == null) return "N/A";
  return odds > 0 ? `+${odds}` : `${odds}`;
}

export function getImpliedProbability(americanOdds: number): number {
  if (americanOdds > 0) {
    return 100 / (americanOdds + 100);
  } else {
    const abs = Math.abs(americanOdds);
    return abs / (abs + 100);
  }
}

export function calculateCredibility(
  prediction: {
    pickedWinner: string;
    pickedFinishType?: FinishType | null;
    pickedMethod?: "tko_ko" | "submission" | null;
  },
  result: {
    winner: string;
    finishType: FinishType;
    method: MethodType;
  },
  pickedFighterOdds: number | null,
): CredibilityBreakdown {
  const BASE_WINNER = 100;
  const BASE_FINISH = 50;
  const BASE_METHOD = 75;

  const correctWinner = prediction.pickedWinner === result.winner;

  const impliedProb = pickedFighterOdds != null ? getImpliedProbability(pickedFighterOdds) : 0.5;
  const multiplier = 1 / impliedProb;

  const winnerPoints = correctWinner ? Math.round(BASE_WINNER * multiplier) : 0;

  let finishTypePoints = 0;
  const correctFinish = prediction.pickedFinishType === result.finishType;
  // Only award finish/method bonuses if the winner was also correct
  if (correctWinner && correctFinish) {
    finishTypePoints = result.finishType === "finish"
      ? Math.round(BASE_FINISH * 1.5)
      : BASE_FINISH;
  }

  let methodPoints = 0;
  if (
    correctWinner &&
    prediction.pickedFinishType === "finish" &&
    result.finishType === "finish" &&
    prediction.pickedMethod != null
  ) {
    const resultMethod = result.method === "tko_ko" ? "tko_ko" : result.method === "submission" ? "submission" : null;
    if (resultMethod && prediction.pickedMethod === resultMethod) {
      methodPoints = BASE_METHOD;
    }
  }

  let underdogBonus = 0;
  if (correctWinner && pickedFighterOdds != null && pickedFighterOdds >= 150) {
    underdogBonus = Math.round(25 * (pickedFighterOdds / 100));
  }

  const isPerfect =
    correctWinner &&
    correctFinish &&
    (result.finishType === "decision" || methodPoints > 0);
  const perfectPickBonus = isPerfect ? 50 : 0;

  const totalPoints = winnerPoints + finishTypePoints + methodPoints + underdogBonus + perfectPickBonus;

  return {
    winnerPoints,
    finishTypePoints,
    methodPoints,
    underdogBonus,
    perfectPickBonus,
    totalPoints,
    multiplier: Math.round(multiplier * 100) / 100,
    impliedProbability: Math.round(impliedProb * 100),
  };
}
