/**
 * Fighter Data Service
 * Fetches fighter images, profiles, and recent results from public UFC/MMA sources.
 */
import axios from "axios";

export interface FighterProfile {
  name: string;
  imageUrl: string | null;
  nickname: string | null;
  nationality: string | null;
  record: string | null;
  ranking: string | null;
  recentResults: RecentResult[];
}

export interface RecentResult {
  opponent: string;
  result: "W" | "L" | "D" | "NC";
  method: string;
  event: string;
  date: string;
}

// UFC API base (unofficial but publicly accessible)
const UFC_API_BASE = "https://d29dxerjsp82wz.cloudfront.net/api/v3";
const UFC_ATHLETE_BASE = "https://www.ufc.com/athlete";

// MMA Stats (for historical data)
const MMA_STATS_BASE = "http://ufcstats.com/statistics/fighters";

/**
 * Fetch fighter profile from UFC's public CDN API.
 * Falls back to a placeholder if not found.
 */
export async function fetchFighterProfile(fighterName: string): Promise<FighterProfile> {
  const defaultProfile: FighterProfile = {
    name: fighterName,
    imageUrl: null,
    nickname: null,
    nationality: null,
    record: null,
    ranking: null,
    recentResults: [],
  };

  try {
    // Normalize name for URL slug (e.g. "Jon Jones" -> "jon-jones")
    const slug = fighterName
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, "-");

    // Try UFC athlete API
    const res = await axios.get(
      `${UFC_API_BASE}/athlete/${slug}/bio.json`,
      { timeout: 5000 }
    );

    const data = res.data;
    if (!data) return defaultProfile;

    // Parse recent results
    const recentResults: RecentResult[] = [];
    if (data.FightHistory && Array.isArray(data.FightHistory)) {
      for (const fight of data.FightHistory.slice(0, 5)) {
        recentResults.push({
          opponent: fight.Opponent?.Name ?? "Unknown",
          result: fight.Result?.Outcome === "W" ? "W"
            : fight.Result?.Outcome === "L" ? "L"
            : fight.Result?.Outcome === "D" ? "D"
            : "NC",
          method: fight.Result?.Method ?? "",
          event: fight.Event?.Name ?? "",
          date: fight.Event?.Date ?? "",
        });
      }
    }

    return {
      name: fighterName,
      imageUrl: data.ProfileMainImage ?? data.Image ?? null,
      nickname: data.Nickname ?? null,
      nationality: data.Nationality ?? data.Country ?? null,
      record: data.Record
        ? `${data.Record.Wins}-${data.Record.Losses}-${data.Record.Draws}`
        : null,
      ranking: data.Rankings?.[0]?.Rank != null
        ? data.Rankings[0].Rank === 0 ? "C" : `#${data.Rankings[0].Rank}`
        : null,
      recentResults,
    };
  } catch (e) {
    // Silently fall back
    return defaultProfile;
  }
}

/**
 * Build UFC fighter image URL from name.
 * UFC uses a predictable CDN pattern for headshots.
 */
export function buildUFCImageUrl(fighterName: string): string {
  const slug = fighterName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `https://dmxg5wxfqgde4.cloudfront.net/styles/athlete_bio_full_body/s3/2024-01/athlete_${slug}_full_body.png`;
}

/**
 * Get fighter image URL — tries UFC CDN first, falls back to a silhouette placeholder.
 */
export function getFighterImageUrl(name: string, storedUrl?: string | null): string {
  if (storedUrl) return storedUrl;
  return buildUFCImageUrl(name);
}

/**
 * Nationality to flag emoji mapping
 */
const COUNTRY_FLAGS: Record<string, string> = {
  "United States": "🇺🇸",
  "USA": "🇺🇸",
  "Brazil": "🇧🇷",
  "Russia": "🇷🇺",
  "Ireland": "🇮🇪",
  "United Kingdom": "🇬🇧",
  "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "Canada": "🇨🇦",
  "Mexico": "🇲🇽",
  "Australia": "🇦🇺",
  "Nigeria": "🇳🇬",
  "Cameroon": "🇨🇲",
  "Netherlands": "🇳🇱",
  "Poland": "🇵🇱",
  "Georgia": "🇬🇪",
  "Kazakhstan": "🇰🇿",
  "China": "🇨🇳",
  "Japan": "🇯🇵",
  "South Korea": "🇰🇷",
  "New Zealand": "🇳🇿",
  "France": "🇫🇷",
  "Germany": "🇩🇪",
  "Sweden": "🇸🇪",
  "Norway": "🇳🇴",
  "Czech Republic": "🇨🇿",
  "Serbia": "🇷🇸",
  "Ukraine": "🇺🇦",
  "Jamaica": "🇯🇲",
  "Puerto Rico": "🇵🇷",
  "Dominican Republic": "🇩🇴",
  "Cuba": "🇨🇺",
  "Argentina": "🇦🇷",
  "Colombia": "🇨🇴",
  "Peru": "🇵🇪",
  "Venezuela": "🇻🇪",
  "Ecuador": "🇪🇨",
  "Bolivia": "🇧🇴",
  "Chile": "🇨🇱",
  "Mongolia": "🇲🇳",
  "Philippines": "🇵🇭",
  "Thailand": "🇹🇭",
  "Indonesia": "🇮🇩",
  "India": "🇮🇳",
  "Iran": "🇮🇷",
  "Turkey": "🇹🇷",
  "Morocco": "🇲🇦",
  "Egypt": "🇪🇬",
  "South Africa": "🇿🇦",
  "Kyrgyzstan": "🇰🇬",
  "Tajikistan": "🇹🇯",
  "Uzbekistan": "🇺🇿",
  "Azerbaijan": "🇦🇿",
  "Armenia": "🇦🇲",
  "Lithuania": "🇱🇹",
  "Latvia": "🇱🇻",
  "Estonia": "🇪🇪",
};

export function getFlagEmoji(nationality: string | null | undefined): string {
  if (!nationality) return "";
  return COUNTRY_FLAGS[nationality] ?? "";
}
