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
  // Penalty for wrong picks (negative value)
  penalty: number;
}

// ─── Normalized 0-100 Credibility Score ──────────────────────────────────────

export interface NormalizedPickResult {
  pickValue: number;       // the weighted contribution of this pick (-1.0 to +1.5)
  maxPossible: number;     // max possible value for this pick (always positive)
  oddsWeight: number;      // 1 / implied_probability
  correct: boolean;
}

/**
 * Calculate the normalized 0-100 credibility score for a user from all their resolved picks.
 * Rewards upset picks, penalizes wrong picks (especially wrong chalk picks).
 */
export function calcNormalizedCredScore(
  picks: Array<{
    correct: boolean;
    pickedFinishType?: FinishType | null;
    pickedMethod?: "tko_ko" | "submission" | null;
    resultFinishType?: FinishType | null;
    resultMethod?: MethodType | null;
    pickedFighterOdds: number | null;
  }>
): number {
  if (picks.length === 0) return 0;

  let totalValue = 0;
  let totalMaxPossible = 0;

  for (const pick of picks) {
    const impliedProb = pick.pickedFighterOdds != null
      ? getImpliedProbability(pick.pickedFighterOdds)
      : 0.5;
    const oddsWeight = 1 / impliedProb; // higher for underdogs

    if (pick.correct) {
      // Base: correct winner
      let value = 1.0 * oddsWeight;

      // Bonus for correct finish type
      const correctFinish = pick.pickedFinishType != null && pick.pickedFinishType === pick.resultFinishType;
      if (correctFinish) {
        value += 0.25 * oddsWeight;
      }

      // Bonus for correct method (TKO/KO or SUB)
      const correctMethod =
        pick.pickedFinishType === "finish" &&
        pick.resultFinishType === "finish" &&
        pick.pickedMethod != null &&
        pick.resultMethod != null &&
        ((pick.resultMethod === "tko_ko" && pick.pickedMethod === "tko_ko") ||
          (pick.resultMethod === "submission" && pick.pickedMethod === "submission"));
      if (correctMethod) {
        value += 0.25 * oddsWeight;
      }

      totalValue += value;
    } else {
      // Penalty for wrong pick — scaled by how much of a favourite they picked
      // Picking a heavy favourite wrong hurts more than picking an underdog wrong
      let penalty: number;
      if (pick.pickedFighterOdds == null) {
        penalty = -0.5; // unknown odds — moderate penalty
      } else if (pick.pickedFighterOdds <= -300) {
        penalty = -1.0; // picked a massive favourite, they lost — big penalty
      } else if (pick.pickedFighterOdds <= -150) {
        penalty = -0.75; // clear favourite
      } else if (pick.pickedFighterOdds <= -110) {
        penalty = -0.5; // slight favourite
      } else if (pick.pickedFighterOdds <= 110) {
        penalty = -0.35; // pick'em / coin flip
      } else {
        penalty = -0.2; // picked an underdog and they lost — least penalised
      }
      totalValue += penalty;
    }

    // Max possible for this pick = 1.5 × oddsWeight (correct + finish + method bonus)
    totalMaxPossible += 1.5 * oddsWeight;
  }

  // Volume confidence multiplier — prevents 1 lucky pick = 100 score
  const n = picks.length;
  let volumeMultiplier: number;
  if (n >= 50)      volumeMultiplier = 1.00;
  else if (n >= 20) volumeMultiplier = 0.92;
  else if (n >= 10) volumeMultiplier = 0.80;
  else if (n >= 5)  volumeMultiplier = 0.65;
  else              volumeMultiplier = 0.40;

  // Normalize: totalValue / totalMaxPossible gives a ratio in roughly (-1, 1)
  // Map to 0-100 scale: 0 = all wrong, 50 = break even, 100 = perfect
  // Use (ratio + 1) / 2 to shift from (-1,1) to (0,1), then × 100
  const ratio = totalMaxPossible > 0 ? totalValue / totalMaxPossible : 0;
  const raw = ((ratio + 1) / 2) * 100 * volumeMultiplier;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

// Tier thresholds on the normalized 0-100 scale
export const TIER_THRESHOLDS: Record<CredibilityTier, number> = {
  rookie: 0,
  contender: 40,
  champion: 60,
  goat: 80,
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
  if (score >= 80) return "goat";
  if (score >= 60) return "champion";
  if (score >= 40) return "contender";
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

  // Penalty for wrong winner pick (negative, used for normalized score)
  let penalty = 0;
  if (!correctWinner) {
    if (pickedFighterOdds == null) {
      penalty = -50;
    } else if (pickedFighterOdds <= -300) {
      penalty = -100; // picked a massive favourite who lost
    } else if (pickedFighterOdds <= -150) {
      penalty = -75;
    } else if (pickedFighterOdds <= -110) {
      penalty = -50;
    } else if (pickedFighterOdds <= 110) {
      penalty = -35;
    } else {
      penalty = -20; // underdog pick that lost
    }
  }

  const totalPoints = correctWinner
    ? winnerPoints + finishTypePoints + methodPoints + underdogBonus + perfectPickBonus
    : penalty; // wrong picks contribute negative points

  return {
    winnerPoints,
    finishTypePoints,
    methodPoints,
    underdogBonus,
    perfectPickBonus,
    totalPoints,
    penalty,
    multiplier: Math.round(multiplier * 100) / 100,
    impliedProbability: Math.round(impliedProb * 100),
  };
}
