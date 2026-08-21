// Minimum age to use Evarna. Under-18s are additionally content-restricted in
// prompt.service.ts; this is the floor for access at all.
export const MIN_AGE_YEARS = 15;
export const MINOR_AGE_YEARS = 18;

export function ageInYears(dob: Date, now: Date = new Date()): number {
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

/**
 * Derive minor status now, rather than reading User.is_minor.
 *
 * The stored flag is computed once at onboarding and never recomputed, so a
 * seventeen-year-old stayed restricted forever and nobody ever aged out. Every
 * decision that depends on age calls this instead.
 */
export function isMinorNow(dob: Date | null | undefined, now: Date = new Date()): boolean {
  if (!dob) return false;
  return ageInYears(dob, now) < MINOR_AGE_YEARS;
}

export function isUnderMinimumAge(dob: Date, now: Date = new Date()): boolean {
  return ageInYears(dob, now) < MIN_AGE_YEARS;
}
