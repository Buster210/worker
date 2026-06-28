import { expect, test, afterEach } from "bun:test";
import { resolveGpgMode, loopbackWrapperBody } from "./runner.ts";

const orig = process.env.WORKER_GPG_MODE;
afterEach(() => {
  if (orig === undefined) delete process.env.WORKER_GPG_MODE;
  else process.env.WORKER_GPG_MODE = orig;
});

test("gpg mode defaults to loopback", () => {
  delete process.env.WORKER_GPG_MODE;
  expect(resolveGpgMode()).toBe("loopback");
});

test("gpg mode reads env, case-insensitive", () => {
  process.env.WORKER_GPG_MODE = "AGENT";
  expect(resolveGpgMode()).toBe("agent");
  process.env.WORKER_GPG_MODE = "cache";
  expect(resolveGpgMode()).toBe("cache");
});

test("invalid gpg mode falls back to loopback", () => {
  process.env.WORKER_GPG_MODE = "bogus";
  expect(resolveGpgMode()).toBe("loopback");
});

test("loopback wrapper: passphrase via fd 3 from env, never on argv or baked in", () => {
  const body = loopbackWrapperBody();
  expect(body).toContain("--pinentry-mode loopback");
  expect(body).toContain("--passphrase-fd 3");
  expect(body).toContain("$WORKER_GPG_PASSPHRASE");
  expect(body).not.toContain("--passphrase ");
});
