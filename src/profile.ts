/**
 * Calibration profile: the server-side loop's output (usage in → adjusted thresholds out).
 * Profiles are versioned so clients apply each revision exactly once, and every knob is clamped
 * to client-side bounds — a bad or hostile profile can never widen blast radius.
 */

import { validateMenuHints } from "./dispatch.js";

export interface ProfileBounds {
  min: number;
  max: number;
}

export const PROFILE_BOUNDS = {
  /** Higher = stricter completion gate. Floor = the 0.70 factory default. */
  completionThreshold: { min: 0.7, max: 0.95 },
  /** Lower = earlier human escalation. Ceiling = the 2.5 factory default. */
  escalateRiskScore: { min: 1.0, max: 2.5 },
  /** Lower = earlier escalation on destructive-looking actions. Ceiling = the 0.4 factory default. */
  escalateDestructiveProbability: { min: 0.1, max: 0.4 },
} satisfies Record<string, ProfileBounds>;

export const PROFILE_DEFAULTS = {
  completionThreshold: 0.7,
  escalateRiskScore: 2.5,
  escalateDestructiveProbability: 0.4,
};

export interface CalibrationProfile {
  /** Monotonically increasing server-side revision. Clients re-apply only when it changes. */
  version: number;
  completionThreshold?: number;
  shield?: {
    escalateRiskScore?: number;
    escalateDestructiveProbability?: number;
  };
  /**
   * Menu-level hints, applied at dispatch: keys `job:<id>` / `worker:<id>`, values `prefer`/`avoid`.
   * Validated whole-set at the clamp gateway (a hostile set is rejected and logged, never applied).
   */
  menuHints?: Record<string, "prefer" | "avoid">;
}

export interface ProfileApplication {
  version: number;
  /** Knobs actually changed in the client. */
  applied: string[];
  /** Knobs whose requested value was outside the safety bounds and got clamped. */
  clamped: string[];
  /** Hostile input refused at the clamp gateway (e.g. a menuHints set), with the reason. */
  rejected?: string[];
}

/** Validates the wire shape of a profile; returns undefined for anything malformed. */
export function parseCalibrationProfile(raw: unknown): CalibrationProfile | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  if (!("version" in raw) || typeof raw.version !== "number" || !Number.isFinite(raw.version)) return undefined;

  const profile: CalibrationProfile = { version: raw.version };

  // A non-finite knob is malformed input, not a value to guess at: the profile is refused whole
  // (clamping happens later, on profiles that parsed).
  if ("completionThreshold" in raw && typeof raw.completionThreshold === "number") {
    if (!Number.isFinite(raw.completionThreshold)) return undefined;
    profile.completionThreshold = raw.completionThreshold;
  }

  if ("shield" in raw && raw.shield !== null && typeof raw.shield === "object") {
    const shield: NonNullable<CalibrationProfile["shield"]> = {};
    if ("escalateRiskScore" in raw.shield && typeof raw.shield.escalateRiskScore === "number") {
      if (!Number.isFinite(raw.shield.escalateRiskScore)) return undefined;
      shield.escalateRiskScore = raw.shield.escalateRiskScore;
    }
    if ("escalateDestructiveProbability" in raw.shield && typeof raw.shield.escalateDestructiveProbability === "number") {
      if (!Number.isFinite(raw.shield.escalateDestructiveProbability)) return undefined;
      shield.escalateDestructiveProbability = raw.shield.escalateDestructiveProbability;
    }
    profile.shield = shield;
  }

  if ("menuHints" in raw && raw.menuHints !== null && typeof raw.menuHints === "object") {
    // Wire content passes through UNFILTERED: the clamp gateway (clampProfile → validateMenuHints)
    // owns menuHints validation and must see hostile sets in order to reject and report them.
    // Pre-filtering here would launder a hostile set into a merely incomplete one.
    profile.menuHints = { ...(raw.menuHints as Record<string, "prefer" | "avoid">) };
  }

  return profile;
}

/**
 * Clamps every knob into its safety bounds, reporting what had to be bounded. A hostile `menuHints`
 * set is rejected as a unit here (reported in `rejected`) — hints may only reorder or filter the
 * dispatch menu, never widen it, so anything that fails validation never reaches a menu.
 */
export function clampProfile(profile: CalibrationProfile): { profile: CalibrationProfile; clamped: string[]; rejected: string[] } {
  const clamped: string[] = [];
  const rejected: string[] = [];
  const bounded: CalibrationProfile = { version: profile.version };

  if (profile.completionThreshold !== undefined) {
    bounded.completionThreshold = bound(
      profile.completionThreshold,
      PROFILE_BOUNDS.completionThreshold,
      PROFILE_DEFAULTS.completionThreshold,
      "completionThreshold",
      clamped
    );
  }

  if (profile.shield) {
    const shield: NonNullable<CalibrationProfile["shield"]> = {};
    if (profile.shield.escalateRiskScore !== undefined) {
      shield.escalateRiskScore = bound(
        profile.shield.escalateRiskScore,
        PROFILE_BOUNDS.escalateRiskScore,
        PROFILE_DEFAULTS.escalateRiskScore,
        "shield.escalateRiskScore",
        clamped
      );
    }
    if (profile.shield.escalateDestructiveProbability !== undefined) {
      shield.escalateDestructiveProbability = bound(
        profile.shield.escalateDestructiveProbability,
        PROFILE_BOUNDS.escalateDestructiveProbability,
        PROFILE_DEFAULTS.escalateDestructiveProbability,
        "shield.escalateDestructiveProbability",
        clamped
      );
    }
    bounded.shield = shield;
  }

  if (profile.menuHints !== undefined) {
    const validated = validateMenuHints(profile.menuHints);
    if (validated.rejected !== undefined) {
      rejected.push(`menuHints (rejected: ${validated.rejected})`);
    } else {
      bounded.menuHints = validated.hints;
    }
  }

  return { profile: bounded, clamped, rejected };
}

function bound(value: number, bounds: ProfileBounds, fallback: number, name: string, clamped: string[]): number {
  if (!Number.isFinite(value)) {
    clamped.push(`${name} (non-finite)`);
    return fallback;
  }
  const result = Math.min(bounds.max, Math.max(bounds.min, value));
  if (result !== value) {
    clamped.push(`${name} (requested ${value}, allowed ${bounds.min}..${bounds.max})`);
  }
  return result;
}
