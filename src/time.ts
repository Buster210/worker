// Local-time ISO 8601 with timezone offset, e.g. 2026-07-06T13:16:46+05:30.
// Shows the same wall-clock the user sees, and stays Date-parseable (unlike
// toLocaleString) so stored "started"/"finished" values still compare correctly.
export function localISO(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" + pad(d.getMonth() + 1) +
    "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) +
    ":" + pad(d.getMinutes()) +
    ":" + pad(d.getSeconds()) +
    (off >= 0 ? "+" : "-") + pad(off / 60) + ":" + pad(off % 60)
  );
}
