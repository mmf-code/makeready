import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { connectionConfig, cronOrigin, migrationStates, parseFlags, PREVIEW_ORIGIN, PROJECT_REF, validateTarget, verifiedCertificate } from "../../scripts/setup-database.mjs";

const direct = `postgresql://postgres:example-not-a-secret@db.${PROJECT_REF}.supabase.co:5432/postgres`;
const environment = (database = direct): Record<string, string | undefined> => ({
  SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`, SUPABASE_PROJECT_REF: PROJECT_REF, SUPABASE_DB_URL: database,
});

describe("dedicated database setup guards", () => {
  it("rejects foreign project identities in the API URL, database host and pooler username", () => {
    expect(() => validateTarget({ ...environment(), SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co" })).toThrow(/dedicated/);
    expect(() => validateTarget({ ...environment(), SUPABASE_PROJECT_REF: "aaaaaaaaaaaaaaaaaaaa" })).toThrow(/approved/);
    expect(() => validateTarget(environment(direct.replace(PROJECT_REF, "aaaaaaaaaaaaaaaaaaaa")))).toThrow(/approved/);
    expect(() => validateTarget(environment("postgres://postgres.aaaaaaaaaaaaaaaaaaaa:example@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"))).toThrow(/approved/);
  });

  it("accepts the explicit project's session and transaction pooler transports", () => {
    for (const port of [5432, 6543]) {
      const target = validateTarget(environment(`postgres://postgres.${PROJECT_REF}:example@aws-0-eu-central-1.pooler.supabase.com:${port}/postgres`));
      expect(target).toMatchObject({ user: `postgres.${PROJECT_REF}`, database: "postgres", port });
    }
  });

  it("rejects URL options that could override the validated destination or credentials", () => {
    for (const option of ["host=evil.example", "hostaddr=127.0.0.1", "user=postgres.other", "password=other", "port=1234", "options=-cstatement_timeout%3D0", "application_name=override"]) {
      expect(() => validateTarget(environment(`${direct}?${option}`))).toThrow(/override/);
    }
  });

  it("ignores supplied SSL disabling options and supplies verified TLS explicitly", () => {
    const target = validateTarget(environment(`${direct}?ssl=false&sslmode=disable&sslrootcert=other&uselibpqcompat=true`));
    const config = connectionConfig(target, "public-ca");
    expect(config).not.toHaveProperty("connectionString");
    expect(config.ssl).toEqual({ ca: "public-ca", rejectUnauthorized: true, servername: `db.${PROJECT_REF}.supabase.co`, minVersion: "TLSv1.2" });
    expect(config).toMatchObject({ statement_timeout: 45_000, query_timeout: 50_000, connectionTimeoutMillis: 15_000, idle_in_transaction_session_timeout: 60_000 });
  });

  it("pins the public CA and rejects expired or substituted trust anchors", async () => {
    const pem = await readFile(new URL("../../supabase/certs/supabase-root-2021.pem", import.meta.url), "utf8");
    expect(verifiedCertificate(pem, Date.parse("2026-10-12T10:00:00Z"))).toContain("BEGIN CERTIFICATE");
    expect(() => verifiedCertificate(pem, Date.parse("2032-01-01T00:00:00Z"))).toThrow(/trust anchor/);
    expect(() => verifiedCertificate("not a certificate")).toThrow(/could not be read/);
  });

  it("requires explicit apply intent and a write scope", () => {
    expect(parseFlags([])).toEqual({ apply: false, migrate: false, cron: false });
    expect(parseFlags(["--apply", "--cron"])).toEqual({ apply: true, migrate: false, cron: true });
    for (const args of [["--cron"], ["--apply"], ["--check", "--apply", "--migrate"], ["--password=example"]]) expect(() => parseFlags(args)).toThrow();
  });

  it("allows only the stable public preview origin for Vault reconciliation", () => {
    expect(cronOrigin({})).toBe(PREVIEW_ORIGIN);
    expect(cronOrigin({ PREVIEW_APP_URL: `${PREVIEW_ORIGIN}/` })).toBe(PREVIEW_ORIGIN);
    for (const url of ["http://localhost:3000", "https://evre.ai", `${PREVIEW_ORIGIN}/api`, `${PREVIEW_ORIGIN}?override=true`, "https://user:password@makeready-preview-mmf-code.vercel.app"]) {
      expect(() => cronOrigin({ RECONCILIATION_APP_URL: url })).toThrow(/preview/);
    }
  });

  it("distinguishes matching ledger checksums, missing migrations and drift", () => {
    const local = [{ name: "one.sql", sha256: "aaa" }, { name: "two.sql", sha256: "bbb" }, { name: "three.sql", sha256: "ccc" }];
    expect(migrationStates(local, [{ name: "one.sql", sha256: "aaa" }, { name: "two.sql", sha256: "changed" }]).map((state) => state.status)).toEqual(["APPLIED_MATCH", "CHECKSUM_MISMATCH", "MISSING"]);
  });
});
