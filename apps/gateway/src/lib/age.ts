// Age is DERIVED from birth month/year at request time (Blueprint §4.2). Never stored.
export function deriveAgeYears(birthMonth: number, birthYear: number, now = new Date()): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12
  let age = y - birthYear;
  if (m < birthMonth) age -= 1; // birthday (month granularity) not yet reached this year
  return age;
}
