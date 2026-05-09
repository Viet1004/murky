import { UserProfile, ScorerConfig } from "./types";

const PROFILE_KEY = "murkyProfile";
const SCORER_ID_KEY = "murkyScorerId";
const SCORER_CONFIG_KEY = "murkyScorerConfig";

export const DEFAULT_SCORER_ID = "random";

export async function getProfile(): Promise<UserProfile> {
  return new Promise((resolve) => {
    chrome.storage.local.get([PROFILE_KEY], (r) => {
      resolve((r[PROFILE_KEY] as UserProfile | undefined) ?? {});
    });
  });
}

export async function getScorerId(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get([SCORER_ID_KEY], (r) => {
      resolve((r[SCORER_ID_KEY] as string | undefined) ?? DEFAULT_SCORER_ID);
    });
  });
}

export async function getScorerConfig(scorerId: string): Promise<ScorerConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get([SCORER_CONFIG_KEY], (r) => {
      const all = (r[SCORER_CONFIG_KEY] as Record<string, ScorerConfig> | undefined) ?? {};
      resolve(all[scorerId] ?? {});
    });
  });
}
