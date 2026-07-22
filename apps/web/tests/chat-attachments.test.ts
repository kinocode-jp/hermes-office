import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendAttachments,
  buildPromptWithAttachments,
  isImageMime,
  summarizePromptForEvidence,
  type ChatAttachment,
} from "../src/chat-attachments";

test("image mime falls back to extension when type is empty or generic", () => {
  assert.equal(isImageMime("", "photo.PNG"), true);
  assert.equal(isImageMime("application/octet-stream", "shot.webp"), true);
  assert.equal(isImageMime("application/pdf", "doc.pdf"), false);
});

test("appendAttachments reports truncation", () => {
  const current = Array.from({ length: 3 }, (_, index) => ({
    id: `a${index}`, name: `a${index}.txt`, mime: "text/plain", size: 1, kind: "file" as const, textContent: "x",
  }));
  const next = Array.from({ length: 3 }, (_, index) => ({
    id: `b${index}`, name: `b${index}.txt`, mime: "text/plain", size: 1, kind: "file" as const, textContent: "y",
  }));
  const result = appendAttachments(current, next);
  assert.equal(result.attachments.length, 4);
  assert.equal(result.truncated, 2);
});

test("buildPromptWithAttachments uses a unique fence for nested backticks", () => {
  const attachment: ChatAttachment = {
    id: "1",
    name: "note.md",
    mime: "text/markdown",
    size: 10,
    kind: "file",
    textContent: "code:\n```\nhello\n```",
  };
  const prompt = buildPromptWithAttachments("see file", [attachment]);
  assert.equal(typeof prompt, "string");
  if (typeof prompt === "string") {
    assert.match(prompt, /````markdown/);
    assert.ok(prompt.includes("hello"));
  }
});

test("summarizePromptForEvidence redacts data URLs", () => {
  const raw = "hi\n![x](data:image/png;base64,AAAA)\nend";
  const summary = summarizePromptForEvidence(raw);
  assert.ok(!summary.includes("AAAA"));
  assert.ok(summary.includes("data:…"));
});
