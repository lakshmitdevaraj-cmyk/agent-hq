// R8: the app's database client must refuse a bad certificate even when the string says sslmode=require.
// A fake Postgres server answers the TLS request with certificates made here by openssl (in a temp folder), then
// records whether the client went on to send its start-up message (user name, database). A refused client never does.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import postgres from "postgres";
import { localVar } from "../env.mjs"; // also loads the scripts' DNS workaround for *.neon.tech
import { clientOptions, db, withTx, timed, closeDb, TLS_OPTIONS } from "../../../netlify/functions/lib/db/client.ts";

const SSL_REQUEST = 80877103;

function makeCerts(dir) {
  const run = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  // 1. Self-signed for localhost.
  run("req", "-x509", ...ec, "-keyout", "self.key", "-out", "self.pem", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost");
  // 2. A test CA and two certificates it signs: one for localhost, one for another name.
  run("req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Test CA");
  for (const [name, dns] of [["good", "localhost"], ["wrong", "wrong.example"]]) {
    run("req", "-new", ...ec, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${dns}`, "-addext", `subjectAltName=DNS:${dns}`);
    run("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "1", "-copy_extensions", "copyall");
  }
  const read = (f) => readFileSync(join(dir, f), "utf8");
  return { self: { key: read("self.key"), cert: read("self.pem") }, good: { key: read("good.key"), cert: read("good.pem") }, wrong: { key: read("wrong.key"), cert: read("wrong.pem") }, ca: read("ca.pem") };
}

/** A server that speaks just enough Postgres to start TLS. `startups` counts clients that got past TLS. */
function fakePostgres({ key, cert }) {
  const state = { startups: 0, port: 0 };
  const server = net.createServer((socket) => {
    socket.once("data", (buf) => {
      if (buf.length < 8 || buf.readInt32BE(4) !== SSL_REQUEST) return socket.destroy();
      socket.write("S");
      const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
      secure.on("error", () => {});
      secure.once("data", () => {
        state.startups++;
        // ErrorResponse: severity FATAL, code 28000, message, so the client stops at once.
        const fields = Buffer.from("SFATAL\0C28000\0Mfake server\0\0");
        const head = Buffer.alloc(5); head.write("E"); head.writeInt32BE(fields.length + 4, 1);
        secure.end(Buffer.concat([head, fields]));
      });
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, () => { state.port = server.address().port; resolve({ state, close: () => new Promise((r) => server.close(r)) }); }));
}

/** Tries to connect with these options; returns the error (or null if a query somehow succeeded). */
async function tryConnect(port, options) {
  const sql = postgres(`postgres://someone:not-a-real-password@localhost:${port}/app?sslmode=require`, { ...options, max: 1, connect_timeout: 5 });
  try { await sql`select 1`; return null; } catch (e) { return e; } finally { await sql.end({ timeout: 1 }).catch(() => {}); }
}

let dir, certs;
before(() => { dir = mkdtempSync(join(tmpdir(), "p2-tls-")); certs = makeCerts(dir); });
after(() => rmSync(dir, { recursive: true, force: true }));

describe("R8: certificate checking is forced", () => {
  test("the app client refuses a self-signed certificate, though the string says sslmode=require", async () => {
    const fake = await fakePostgres(certs.self);
    try {
      const err = await tryConnect(fake.state.port, clientOptions());
      assert.ok(err, "the connection must fail");
      assert.match(String(err.code), /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/, `refused for a certificate reason, got ${err.code}: ${err.message}`);
      assert.equal(fake.state.startups, 0, "the client must not send its start-up message to that server");
    } finally { await fake.close(); }
  });

  test("the app client refuses a trusted certificate for another host name", async () => {
    const fake = await fakePostgres(certs.wrong);
    try {
      const opts = clientOptions();
      // Only the module's own ssl settings, plus the test CA. Without them the driver would skip the check.
      const err = await tryConnect(fake.state.port, { ...opts, ssl: opts.ssl && { ...opts.ssl, ca: certs.ca } });
      assert.ok(err, "the connection must fail");
      assert.equal(err.code, "ERR_TLS_CERT_ALTNAME_INVALID", `${err.code}: ${err.message}`);
      assert.equal(fake.state.startups, 0);
    } finally { await fake.close(); }
  });

  test("control: a trusted certificate for the right name gets through TLS (so the refusals above are about the certificate)", async () => {
    const fake = await fakePostgres(certs.good);
    try {
      const opts = clientOptions();
      const err = await tryConnect(fake.state.port, { ...opts, ssl: { ...opts.ssl, ca: certs.ca } });
      assert.equal(fake.state.startups, 1, `expected the start-up message after TLS, got error ${err?.code}`);
      assert.equal(err?.code, "28000", "the fake server's own refusal");
    } finally { await fake.close(); }
  });

  test("why this module exists: the driver alone, given sslmode=require, accepts the self-signed certificate", async () => {
    const fake = await fakePostgres(certs.self);
    try {
      await tryConnect(fake.state.port, {});
      assert.equal(fake.state.startups, 1, "postgres.js with only the string's sslmode=require skips certificate checking");
    } finally { await fake.close(); }
  });

  test("the TLS settings can't be changed at run time", () => {
    assert.equal(TLS_OPTIONS.rejectUnauthorized, true);
    assert.throws(() => { "use strict"; TLS_OPTIONS.rejectUnauthorized = false; });
  });
});

describe("R8: the client on Neon dev", () => {
  before(() => { process.env.DATABASE_URL = localVar("DEV_DATABASE_URL"); });
  after(async () => { await closeDb(); delete process.env.DATABASE_URL; });

  test("connects with certificate checking on, and reuses one client", async () => {
    assert.equal(db(), db());
    const [row] = await db()`select 1 as ok, current_setting('ssl', true) as server_ssl`;
    assert.equal(row.ok, 1);
  });

  test("withTx rolls back when the function throws", async () => {
    const id = "t-p2-withtx";
    await assert.rejects(withTx(async (tx) => {
      await tx`insert into activity (id, category, summary) values (${id}, 'test', 'rolled back')`;
      throw new Error("stop");
    }), /stop/);
    const rows = await db()`select 1 from activity where id = ${id}`;
    assert.equal(rows.length, 0);
  });

  test("withTx stops a statement that runs past its time limit", async () => {
    await assert.rejects(withTx((tx) => tx`select pg_sleep(3)`, { timeoutMs: 500 }), (e) => e.code === "57014");
  });

  test("timed cancels a single query that runs past its time limit", async () => {
    await assert.rejects(timed(db()`select pg_sleep(3)`, 500), (e) => e.code === "57014");
    assert.equal((await db()`select 1 as ok`)[0].ok, 1, "the client still works after a cancel");
  });

  test("a missing or malformed DATABASE_URL fails without echoing it", async () => {
    await closeDb();
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "not-a-url-secret-value";
    assert.throws(() => db(), (e) => /does not look like/.test(e.message) && !e.message.includes("secret"));
    delete process.env.DATABASE_URL;
    assert.throws(() => db(), /not set/);
    process.env.DATABASE_URL = saved;
  });
});
