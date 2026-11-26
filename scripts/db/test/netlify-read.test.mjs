import { test } from "node:test";
import assert from "node:assert/strict";
import { checkArgs, netlify } from "../netlify-read.mjs";

test("only the two read commands get through", async () => {
  for (const ok of ["blobs:list", "blobs:get"]) assert.doesNotThrow(() => checkArgs([ok, "s"]));
  for (const bad of ["blobs:set", "blobs:delete", "deploy", "build", "link", "env:set", "status", "login"]) {
    assert.throws(() => checkArgs([bad]), /refusing/);
    await assert.rejects(netlify([bad]), /refusing/);
  }
  for (const flag of ["--debug", "--auth", "-p"]) assert.throws(() => checkArgs(["blobs:list", "s", flag]), /refusing/);
});
