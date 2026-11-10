// Local "daily at HH:MM" or "weekly on <day> at HH:MM" to a UTC cron (agent spec §9.2).
// Pure, with no imports, so the control service's tests can import it too.

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface LocalTime {
  /** null for daily; 0 (Sunday) to 6 (Saturday) for weekly. */
  day: number | null;
  hour: number;
  minute: number;
}

/**
 * `offsetMinutes` is minutes to add to local time to get UTC, as Date.getTimezoneOffset
 * gives it (300 at UTC-5, -120 at UTC+2).
 */
export function toUtcCron(t: LocalTime, offsetMinutes: number): string {
  let total = t.hour * 60 + t.minute + offsetMinutes;
  let dayShift = 0;
  while (total < 0) {
    total += 1440;
    dayShift -= 1;
  }
  while (total >= 1440) {
    total -= 1440;
    dayShift += 1;
  }
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (t.day === null) return `${mm} ${hh} * * *`;
  return `${mm} ${hh} * * ${(((t.day + dayShift) % 7) + 7) % 7}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function describe(t: LocalTime): string {
  const at = `${pad(t.hour)}:${pad(t.minute)}`;
  return t.day === null ? `Every day at ${at} (your time)` : `Every ${DAYS[t.day]} at ${at} (your time)`;
}
