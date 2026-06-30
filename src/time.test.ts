import { expect, test } from "bun:test";
import { localISO } from "./time.ts";

test("localISO round-trips to the same instant and shows local wall-clock", () => {
  const d = new Date();
  const s = localISO(d);
  // Parseable back to the same instant (second precision).
  expect(Math.abs(new Date(s).getTime() - d.getTime())).toBeLessThan(1000);
  // Local wall-clock components, not UTC.
  expect(s.startsWith(`${d.getFullYear()}-`)).toBe(true);
  expect(s.slice(11, 13)).toBe(String(d.getHours()).padStart(2, "0"));
  // Carries an offset, never the UTC "Z".
  expect(/[+-]\d{2}:\d{2}$/.test(s)).toBe(true);
  expect(s.endsWith("Z")).toBe(false);
});
