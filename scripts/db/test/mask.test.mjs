import { test } from "node:test";
import assert from "node:assert/strict";
import { maskEmails } from "../mask.mjs";

test("report text never keeps a full email address", () => {
  assert.equal(maskEmails("To jo.smith+x@example.com, <bounce=abc@mail.example.co.uk> o'neil@x.com a@b.com"), "To j***@example.com, <b***@mail.example.co.uk> o***@x.com a***@b.com");
});
