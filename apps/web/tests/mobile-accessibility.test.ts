import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ChatSession } from "../src/domain.ts";
import { createProfileSession } from "../src/components/profile-panel.tsx";
import { mobileChatTabPresentation } from "../src/components/chat-workspace.tsx";
import { locale, preferredBrowserLocale, setLocale } from "../src/i18n.ts";
import {
  activeSurface,
  activeSessionId,
  mobileInspectorOpen,
  mobileWorkspaceOpen,
  navigateToSurface,
  officeConnection,
  openSession,
  openSessionIds,
  profileList,
  selectProfile,
  selectedProfileId,
  sessions,
} from "../src/store.ts";

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

test("mobile new chat opens its workspace only after session creation succeeds", () => {
  const previousConnection = officeConnection.value;
  const previousProfiles = profileList.value;
  const previousSessions = sessions.value;
  const previousOpenIds = openSessionIds.value;
  const previousActiveId = activeSessionId.value;
  const previousSelectedProfile = selectedProfileId.value;
  const previousInspector = mobileInspectorOpen.value;
  const previousWorkspace = mobileWorkspaceOpen.value;
  try {
    officeConnection.value = { ...previousConnection, state: "demo", source: "demo" };
    profileList.value = [{
      id: "theo", name: "Theo", role: "Engineering", status: "idle", color: "#087f70",
      sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [],
    }];
    sessions.value = [];
    openSessionIds.value = [];
    activeSessionId.value = "";
    mobileInspectorOpen.value = true;
    mobileWorkspaceOpen.value = false;

    assert.equal(createProfileSession("missing"), false);
    assert.equal(mobileInspectorOpen.value, true);
    assert.equal(mobileWorkspaceOpen.value, false);
    assert.deepEqual(sessions.value, []);

    assert.equal(createProfileSession("theo"), true);
    assert.equal(mobileInspectorOpen.value, false);
    assert.equal(mobileWorkspaceOpen.value, true);
    assert.equal(sessions.value.length, 1);
    assert.equal(activeSessionId.value, sessions.value[0]?.id);
    assert.deepEqual(openSessionIds.value, [sessions.value[0]?.id]);
  } finally {
    officeConnection.value = previousConnection;
    profileList.value = previousProfiles;
    sessions.value = previousSessions;
    openSessionIds.value = previousOpenIds;
    activeSessionId.value = previousActiveId;
    selectedProfileId.value = previousSelectedProfile;
    mobileInspectorOpen.value = previousInspector;
    mobileWorkspaceOpen.value = previousWorkspace;
  }
});

test("mobile primary navigation closes both overlays before revealing its surface", () => {
  const previousSurface = activeSurface.value;
  const previousInspector = mobileInspectorOpen.value;
  const previousWorkspace = mobileWorkspaceOpen.value;
  try {
    for (const surface of ["office", "kanban", "library", "settings"] as const) {
      mobileInspectorOpen.value = true;
      mobileWorkspaceOpen.value = true;
      navigateToSurface(surface);
      assert.equal(activeSurface.value, surface);
      assert.equal(mobileInspectorOpen.value, false);
      assert.equal(mobileWorkspaceOpen.value, false);
    }
  } finally {
    activeSurface.value = previousSurface;
    mobileInspectorOpen.value = previousInspector;
    mobileWorkspaceOpen.value = previousWorkspace;
  }
});

test("mobile profile selection opens exactly one focused route with and without an existing chat", () => {
  const previousProfiles = profileList.value;
  const previousSessions = sessions.value;
  const previousOpenIds = openSessionIds.value;
  const previousActiveId = activeSessionId.value;
  const previousSelectedProfile = selectedProfileId.value;
  const previousInspector = mobileInspectorOpen.value;
  const previousWorkspace = mobileWorkspaceOpen.value;
  try {
    profileList.value = [{
      id: "theo", name: "Theo", role: "Engineering", status: "idle", color: "#087f70",
      sessions: 0, taskCount: 0, memoryBytes: 0, memoryNote: "", skills: [], inheritedSkills: [],
    }];
    sessions.value = [];
    openSessionIds.value = [];
    mobileWorkspaceOpen.value = true;
    selectProfile("theo");
    assert.equal(mobileInspectorOpen.value, true);
    assert.equal(mobileWorkspaceOpen.value, false);

    sessions.value = [session("existing", "Existing chat")];
    selectProfile("theo");
    assert.equal(mobileInspectorOpen.value, false);
    assert.equal(mobileWorkspaceOpen.value, true);
  } finally {
    profileList.value = previousProfiles;
    sessions.value = previousSessions;
    openSessionIds.value = previousOpenIds;
    activeSessionId.value = previousActiveId;
    selectedProfileId.value = previousSelectedProfile;
    mobileInspectorOpen.value = previousInspector;
    mobileWorkspaceOpen.value = previousWorkspace;
  }
});

test("mobile route and modal overlays expose consistent focus, inert, and navigation semantics", async () => {
  const [app, workspace, profile, overlay] = await Promise.all([
    readFile(new URL("../src/app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/profile-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/use-mobile-overlay.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /onClick=\{\(\) => navigateToSurface\(item\.id\)\}/);
  assert.match(app, /data-mobile-route-chrome/);
  assert.match(workspace, /kind: "route"/);
  assert.match(workspace, /role=\{mobileOverlay\.active \? "region" : undefined\}/);
  assert.doesNotMatch(workspace, /aria-modal=/);
  assert.match(profile, /kind: "modal"/);
  assert.match(profile, /viewport: COMPACT_OVERLAY_VIEWPORT/);
  assert.match(overlay, /COMPACT_OVERLAY_VIEWPORT = "\(max-width: 1279px\)"/);
  assert.match(overlay, /PHONE_OVERLAY_VIEWPORT = "\(max-width: 767px\)"/);
  assert.match(profile, /role=\{mobileOverlay\.active \? "dialog" : undefined\}/);
  assert.match(profile, /aria-modal=\{mobileOverlay\.active \? "true" : undefined\}/);
  for (const source of [workspace, profile]) assert.match(source, /data-mobile-overlay-initial-focus/);
  assert.match(overlay, /kind !== "route" \|\| !element\.hasAttribute\("data-mobile-route-chrome"\)/);
  assert.match(overlay, /element\.inert = true/);
  assert.match(overlay, /element\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(overlay, /event\.key === "Escape"/);
  assert.match(overlay, /kind !== "modal" \|\| event\.key !== "Tab"/);
  assert.match(overlay, /previousFocus\?\.isConnected/);
});

test("first-run locale follows the browser and login exposes an unauthenticated language switch", async () => {
  assert.equal(preferredBrowserLocale({ language: "en-US", languages: ["en-US", "ja-JP"] }), "en");
  assert.equal(preferredBrowserLocale({ language: "en-US", languages: ["en-US"] }), "en");
  assert.equal(preferredBrowserLocale({ language: "ja-JP", languages: ["ja-JP"] }), "ja");
  assert.equal(preferredBrowserLocale({ language: "fr-FR", languages: ["fr-FR"] }), "en");
  const login = await readFile(new URL("../src/components/device-login.tsx", import.meta.url), "utf8");
  assert.match(login, /class="device-login-language"/);
  assert.match(login, /setLocale\(locale\.value === "ja" \? "en" : "ja"\)/);
});

test("mobile tab and Kanban CSS preserve scrolling, focus, scaled text, and touch targets", async () => {
  const [workspace, styles, appearance, liveSettings, audit] = await Promise.all([
    readFile(new URL("../src/components/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/appearance.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/live-settings.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/access-audit.css", import.meta.url), "utf8"),
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
  for (const selector of [".device-login-message", ".device-login-form input", ".device-login-form button", ".device-login-language", ".avatar-picker > p", ".avatar-picker-actions button", ".avatar-picker-error"]) {
    assert.match(labelSelectors, new RegExp(escapeRegExp(selector)), `${selector} must scale with the label token`);
  }
  const utilityWithLogin = selectorsUsing(appearance, "font-size: var(--text-utility)");
  for (const selector of [".device-login-card .eyebrow", ".device-login-card::before", ".device-login-form label span", ".avatar-picker header small", ".profile-avatar-button > span:last-child"]) {
    assert.match(utilityWithLogin, new RegExp(escapeRegExp(selector)), `${selector} must scale with the utility token`);
  }
  for (const selector of [".device-login-card h1", ".device-login-mark", ".avatar-picker h3"]) {
    assert.match(declarationsForSelector(appearance, selector), /var\(--font-scale\)/, `${selector} must follow the selected font scale`);
  }
  assert.match(selectorsUsing(appearance, "font-size: var(--text-chat)"), /\.task-comment-list p/);

  const mobileTargets = selectorsUsing(appearance, "min-height: var(--target-mobile)");
  for (const selector of [".task-assignee-select select", ".task-status-select select", ".task-card footer button", ".task-comments-error button", ".task-comment-form input", ".task-comment-form button", ".kanban-unconfirmed button"]) {
    assert.match(mobileTargets, new RegExp(escapeRegExp(selector)), `${selector} must use the mobile touch target`);
  }
  assert.match(styles, /\.task-assignee-select, \.task-status-select \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.task-comment-list header \{[^}]*flex-wrap: wrap/);
  assert.match(styles, /\.task-comment-form \{[^}]*minmax\(var\(--target-mobile\), max-content\)/);

  for (const selector of [".live-settings__tabs button", ".skill-line p", ".settings-ledger textarea", ".memory-gauge span", ".settings-field"]) {
    assert.match(declarationsForSelector(liveSettings, selector), /var\(--ls-text-|var\(--font-scale\)/, `${selector} must follow the selected font scale`);
  }
  for (const selector of [".access-audit__title p", ".access-audit__current strong", ".access-audit__rail li", ".access-audit__message", ".access-audit footer"]) {
    assert.match(declarationsForSelector(audit, selector), /var\(--font-scale\)/, `${selector} must follow the selected font scale`);
  }
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

function declarationsForSelector(css: string, selector: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]?.split(",").some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]?.trim())
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
