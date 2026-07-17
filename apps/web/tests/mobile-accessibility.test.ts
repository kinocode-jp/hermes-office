import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import { mobileChatTabPresentation } from "../src/components/chat-workspace.tsx";
import { locale, setLocale } from "../src/i18n.ts";
import { activeSessionId, openSession, openSessionIds, sessions } from "../src/store.ts";

test("mobile tabs distinguish two sessions from one profile and select the requested session", () => {
  const previousLocale = locale.value;
  const officeUi = session("office-ui", "Office UI");
  const pwaShell = session("pwa-shell", "A deliberately long PWA shell release conversation title");
  const japanese = session("japanese", "外出先から操作するための長い日本語会話タイトル");
  const newChat = { ...session("new-chat", ""), titlePresentation: "new-chat" as const };
  try {
    setLocale("en");
    const first = mobileChatTabPresentation(officeUi, "Theo");
    const second = mobileChatTabPresentation(newChat, "Theo");
    assert.deepEqual(first, { profileName: "Theo", sessionTitle: "Office UI", accessibleLabel: "Theo — Office UI" });
    assert.deepEqual(second, { profileName: "Theo", sessionTitle: "New chat", accessibleLabel: "Theo — New chat" });
    assert.notEqual(first.accessibleLabel, second.accessibleLabel);
    const fourLabels = [officeUi, pwaShell, japanese, newChat]
      .map((item) => mobileChatTabPresentation(item, "Theo").accessibleLabel);
    assert.equal(new Set(fourLabels).size, 4);
    assert.ok(fourLabels[1]?.endsWith(pwaShell.title), "the accessible label must retain the full ellipsized title");

    setLocale("ja");
    assert.equal(mobileChatTabPresentation(newChat, "Theo").sessionTitle, "新しい会話");

    sessions.value = [officeUi, pwaShell, japanese, newChat];
    openSessionIds.value = sessions.value.map(({ id }) => id);
    openSession(officeUi.id);
    assert.equal(activeSessionId.value, officeUi.id);
    openSession(newChat.id);
    assert.equal(activeSessionId.value, newChat.id);
    assert.deepEqual(openSessionIds.value, [officeUi.id, pwaShell.id, japanese.id, newChat.id]);
  } finally {
    setLocale(previousLocale);
    sessions.value = [];
    openSessionIds.value = [];
    activeSessionId.value = "";
  }
});

test("mobile tabs number duplicate rendered titles by current pane order across locale changes", () => {
  const previousLocale = locale.value;
  const draftA = { ...session("draft-a", ""), titlePresentation: "new-chat" as const };
  const storedA = session("stored-a", "New chat");
  const draftB = { ...session("draft-b", ""), titlePresentation: "new-chat" as const };
  const storedB = session("stored-b", "New chat");
  const panes = [draftA, storedA, draftB, storedB];
  try {
    setLocale("en");
    const english = panes.map((item) => mobileChatTabPresentation(item, "Theo", panes));
    assert.deepEqual(english.map(({ sessionTitle }) => sessionTitle), [
      "New chat · 1", "New chat · 2", "New chat · 3", "New chat · 4"
    ]);
    assert.equal(new Set(english.map(({ accessibleLabel }) => accessibleLabel)).size, panes.length);

    setLocale("ja");
    const japanese = panes.map((item) => mobileChatTabPresentation(item, "Theo", panes));
    assert.deepEqual(japanese.map(({ sessionTitle }) => sessionTitle), [
      "新しい会話 · 1", "New chat · 1", "新しい会話 · 2", "New chat · 2"
    ]);
    assert.equal(new Set(japanese.map(({ accessibleLabel }) => accessibleLabel)).size, panes.length);

    const reordered = [storedB, draftB, storedA, draftA];
    assert.deepEqual(reordered.map((item) => mobileChatTabPresentation(item, "Theo", reordered).sessionTitle), [
      "New chat · 1", "新しい会話 · 1", "New chat · 2", "新しい会話 · 2"
    ]);

    sessions.value = panes;
    openSessionIds.value = panes.map(({ id }) => id);
    for (const item of panes) {
      openSession(item.id);
      assert.equal(activeSessionId.value, item.id);
    }
    assert.deepEqual(openSessionIds.value, panes.map(({ id }) => id));
  } finally {
    setLocale(previousLocale);
    sessions.value = [];
    openSessionIds.value = [];
    activeSessionId.value = "";
  }
});

test("mobile tab and Kanban CSS preserve scrolling, focus, scaled text, and touch targets", async () => {
  const [workspace, styles, appearance] = await Promise.all([
    readFile(new URL("../src/components/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/appearance.css", import.meta.url), "utf8")
  ]);

  assert.match(workspace, /aria-label=\{tab\.accessibleLabel\}/);
  assert.match(workspace, /<span>\{tab\.profileName\}<\/span>[\s\S]*<small title=\{tab\.sessionTitle\}>/);
  assert.match(styles, /\.mobile-chat-tabs \{[^}]*overflow-x: auto/);
  assert.match(styles, /\.mobile-chat-tabs button:focus-visible \{[^}]*outline: 2px solid/);
  assert.match(styles, /\.mobile-chat-tabs button \{[^}]*clamp\(148px, 48vw, 220px\)/);

  const utilitySelectors = selectorsUsing(appearance, "font-size: var(--text-utility)");
  for (const selector of [".task-status-select", ".task-status-select small", ".task-comments-state", ".task-comments-empty", ".task-comments-limit", ".task-comment-list header", ".kanban-unconfirmed"]) {
    assert.match(utilitySelectors, new RegExp(escapeRegExp(selector)), `${selector} must scale with the utility token`);
  }
  const labelSelectors = selectorsUsing(appearance, "font-size: var(--text-label)");
  for (const selector of [".task-assignee-select select", ".task-status-select select", ".task-comments-error", ".task-comments-error button", ".task-card footer button", ".task-comment-form input", ".task-comment-form button", ".kanban-unconfirmed button"]) {
    assert.match(labelSelectors, new RegExp(escapeRegExp(selector)), `${selector} must scale with the label token`);
  }
  assert.match(selectorsUsing(appearance, "font-size: var(--text-chat)"), /\.task-comment-list p/);

  const mobileTargets = selectorsUsing(appearance, "min-height: var(--target-mobile)");
  for (const selector of [".task-assignee-select select", ".task-status-select select", ".task-card footer button", ".task-comments-error button", ".task-comment-form input", ".task-comment-form button", ".kanban-unconfirmed button"]) {
    assert.match(mobileTargets, new RegExp(escapeRegExp(selector)), `${selector} must use the mobile touch target`);
  }
  assert.match(styles, /\.task-assignee-select, \.task-status-select \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.task-comment-list header \{[^}]*flex-wrap: wrap/);
  assert.match(styles, /\.task-comment-form \{[^}]*minmax\(var\(--target-mobile\), max-content\)/);
});

function session(id: string, title: string): ChatSession {
  return { id, profileId: "theo", title, status: "ready", messages: [], remoteKind: "demo" };
}

function selectorsUsing(css: string, declaration: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[2]?.includes(declaration))
    .map((match) => match[1]?.trim())
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
