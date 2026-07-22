import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ApprovalChoice, ChatMessage, ChatOperationEvidence, ChatPendingInteraction, ChatSession, Profile } from "../domain";
import { chatMessageBody, chatSessionTitle, locale, localizeRuntimeMessage, officeRuntimeMessage, t, type TranslationKey } from "../i18n";
import { MarkdownBody } from "./markdown";
import {
  activeSessionId,
  clearFollowUpSuggestions,
  closeSession,
  interruptSession,
  officeSnapshot,
  openSession,
  reconnectChatSession,
  respondToApproval,
  respondToClarification,
  sendMessage,
  steerSession,
} from "../store";
import { canSteerChatSession, canSubmitChatPrompt, composerBlockedReason, isChatRunActive } from "../session-runtime";
import { profileDisplayName } from "../profile-names";
import {
  appendAttachments,
  buildPromptWithAttachments,
  fileToAttachment,
  type ChatAttachment,
} from "../chat-attachments";
import {
  activeChatModelPreset,
} from "../chat-model-prefs";
import { ChatModelPanel } from "./chat-model-panel";
import { ComposerModelPickers } from "./composer-model-pickers";

export function ChatPane({ session, profile }: { session: ChatSession; profile: Profile }) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const [modelNote, setModelNote] = useState<string | undefined>(undefined);
  const [modelOpen, setModelOpen] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const voiceRecognitionRef = useRef<any>(null);
  const [announcedOperation, setAnnouncedOperation] = useState<ChatOperationEvidence | undefined>(undefined);
  const [expandedLogGroups, setExpandedLogGroups] = useState<Set<string>>(() => new Set());
  const announcedOperationKey = useRef("");
  const messageListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const shouldStickToBottom = useRef(true);
  const isActive = activeSessionId.value === session.id;
  const isLiveChat = session.remoteKind === "stored" || session.remoteKind === "draft";
  const isConnected = !isLiveChat || session.connectionState === "ready";
  const { canCompose, canSteer, runActive, showStop } = chatComposerState(session);
  const canSend = canSubmitChatPrompt(session);
  const blocked = composerBlockedReason(session);
  const transcript = session.messages.filter((message) => message.promptOperation === undefined && message.kind !== "steer");
  const operationEvidence = presentedOperationEvidence(session);
  const timeline = groupChatTimeline(buildChatTimeline(transcript, operationEvidence));
  const displayTitle = chatSessionTitle(session);
  const profileName = profileDisplayName(profile);
  const composerPlaceholder = session.pendingInteraction ? t("chat.answerAbove")
    : !isConnected ? t("chat.connectingPlaceholder")
      : runActive ? t("chat.steerPlaceholder") : t("chat.instruct", { name: profileName });
  const statusText = useMemo(() => {
    if (session.connectionState === "error") return t("chat.status.error");
    if (session.connectionState === "connecting") return t("chat.status.connecting");
    if (session.connectionState === "disconnected" && isLiveChat) return t("chat.status.reconnecting");
    if (session.historyState === "loading") return t("chat.status.loading");
    if (session.interruptPending) return t("chat.status.stopping");
    if (session.pendingInteraction?.kind === "approval") return t("chat.status.approval");
    if (session.pendingInteraction?.kind === "clarify") return t("chat.status.clarify");
    if (session.status === "waiting") return t("chat.status.waiting");
    if (runActive) return t("chat.status.running");
    return t("chat.status.ready");
  }, [isLiveChat, locale.value, runActive, session.connectionState, session.historyState, session.interruptPending, session.pendingInteraction?.kind, session.status]);
  const suggestions = session.followUpSuggestions ?? [];
  const hasSendable = Boolean(draft.trim() || attachments.length > 0);
  const submitDisabled = (runActive ? !canSteer : !canSend) || !hasSendable;
  const activePreset = activeChatModelPreset();
  const presetReadout = activePreset?.name;

  useEffect(() => {
    const list = messageListRef.current;
    if (list && shouldStickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [session.messages.length, session.messages.at(-1)?.body, operationEvidence.length, operationEvidence.at(-1)?.state, session.pendingInteraction?.id, suggestions.length]);

  useEffect(() => {
    const next = nextOperationAnnouncement(operationEvidence, announcedOperationKey.current);
    if (!next) return;
    announcedOperationKey.current = next.key;
    setAnnouncedOperation(next.operation);
  }, [operationEvidence.at(-1)?.id, operationEvidence.at(-1)?.state, operationEvidence.at(-1)?.message]);

  async function addFiles(fileList: FileList | null): Promise<void> {
    if (!fileList?.length) return;
    setAttachError(undefined);
    const next: ChatAttachment[] = [];
    for (const file of Array.from(fileList)) {
      try {
        const result = await fileToAttachment(file);
        if ("error" in result) {
          setAttachError(t(`chat.attachError.${result.error}` as TranslationKey));
          continue;
        }
        next.push(result);
      } catch {
        setAttachError(t("chat.attachError.read-failed"));
      }
    }
    if (next.length > 0) {
      setAttachments((current) => {
        const merged = appendAttachments(current, next);
        if (merged.truncated > 0) setAttachError(t("chat.attachError.too-many", { count: merged.truncated }));
        return merged.attachments;
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    const prompt = buildPromptWithAttachments(draft, attachments);
    if (typeof prompt !== "string") {
      setAttachError(t("chat.attachError.payload-too-large"));
      return;
    }
    if (!prompt.trim()) return;
    if (runActive) {
      if (await steerSession(session.id, prompt)) {
        setDraft("");
        setAttachments([]);
        setAttachError(undefined);
      }
      return;
    }
    if (!canSend) return;
    sendMessage(session.id, prompt);
    setDraft("");
    setAttachments([]);
    setAttachError(undefined);
    clearFollowUpSuggestions(session.id);
  }

  function applySuggestion(text: string): void {
    setDraft(text);
    clearFollowUpSuggestions(session.id);
  }

  return (
    <article class={`chat-pane ${isActive ? "is-active" : ""}`} style={{ "--session-color": profile.color }} onPointerDown={() => openSession(session.id)}>
      <header class="chat-header">
        <span class="profile-dot" style={{ background: profile.color }} />
        <div>
          <b>{profileName}</b>
          <span>{displayTitle}</span>
        </div>
        <span class={`chat-state state-${session.connectionState ?? session.status}`}>{statusText}</span>
        <button class="icon-button" onClick={() => closeSession(session.id)} aria-label={t("chat.close", { title: displayTitle })}>×</button>
      </header>

      <div
        class="message-list"
        aria-live="polite"
        ref={messageListRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          shouldStickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
        }}
      >
        {session.errorMessage ? (
          <div class="chat-connection-note is-error" role="alert">
            <span>{localizeRuntimeMessage(session.errorMessage)}</span>
            {isLiveChat && (session.connectionState === "error" || session.historyState === "error") && <button type="button" onClick={() => reconnectChatSession(session.id)}>{session.historyState === "error" ? t("chat.reload") : t("chat.reconnect")}</button>}
          </div>
        ) : session.connectionState === "disconnected" && isLiveChat ? (
          <div class="chat-connection-note"><span>{t("chat.recovering")}</span></div>
        ) : null}
        {session.historyPartial && <div class="chat-connection-note"><span>{session.historyNotice ? localizeRuntimeMessage(session.historyNotice) : t("chat.historyPartial")}</span></div>}
        {timeline.length === 0 ? (
          <div class="empty-chat">
            <span>{session.historyState === "loading" ? t("chat.loadingHistory") : isLiveChat ? t("chat.hermesSession") : t("chat.newThread")}</span>
            <p>{session.historyState === "loading" ? t("chat.loadingSaved") : !isConnected ? t("chat.connectingLive") : runActive ? t("chat.runningPlaceholder") : t("chat.firstInstruction", { name: profileName })}</p>
          </div>
        ) : timeline.map((item) => item.kind === "operation" ? (
          <ChatOperationEntry key={`operation:${item.operation.id}`} operation={item.operation} />
        ) : item.kind === "log-group" ? (
          <ChatLogGroup
            key={`log-group:${item.id}`}
            group={item}
            expanded={expandedLogGroups.has(item.id)}
            onToggle={() => setExpandedLogGroups((current) => {
              const next = new Set(current);
              if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
              return next;
            })}
            profile={profile}
            profileName={profileName}
          />
        ) : (
          <ChatMessageEntry key={`message:${item.message.id}`} message={item.message} profile={profile} profileName={profileName} />
        ))}
        {session.pendingInteraction && (
          <ChatInteraction
            sessionId={session.id}
            interaction={session.pendingInteraction}
            connected={session.connectionState === "ready"}
          />
        )}
      </div>
      <span
        class="visually-hidden"
        role={announcedOperation && isUrgentOperation(announcedOperation) ? "alert" : "status"}
        aria-live={announcedOperation && isUrgentOperation(announcedOperation) ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {announcedOperation ? operationAnnouncementText(announcedOperation) : ""}
      </span>

      {suggestions.length > 0 && canSend && (
        <div class="chat-suggestions" aria-label={t("chat.suggestions")}>
          <span>{t("chat.suggestions")}</span>
          <div class="chat-suggestion-list">
            {suggestions.map((item) => (
              <button
                key={item}
                type="button"
                class="chat-suggestion-chip"
                title={t("chat.suggestions.use")}
                onClick={() => applySuggestion(item)}
              >{item}</button>
            ))}
          </div>
        </div>
      )}

      <form class="composer" onSubmit={(event) => void submit(event)}>
        {attachments.length > 0 && (
          <div class="composer-attachments" aria-label={t("chat.attach")}>
            {attachments.map((item) => (
              <div class="composer-attachment" key={item.id}>
                {item.kind === "image" && item.dataUrl
                  ? <img src={item.dataUrl} alt={item.name} />
                  : <span aria-hidden="true">📄</span>}
                <b title={item.name}>{item.name}</b>
                <button type="button" aria-label={t("chat.attachRemove")} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}>×</button>
              </div>
            ))}
          </div>
        )}
        <div class="composer-toolbar">
          <input
            ref={fileInputRef}
            class="visually-hidden"
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.toml,.sh"
            onChange={(event) => void addFiles(event.currentTarget.files)}
          />
          <button type="button" class="composer-tool" disabled={!canCompose} title={t("chat.attach")} aria-label={t("chat.attach")} onClick={() => fileInputRef.current?.click()}>📎</button>
          <button
            type="button"
            class={`composer-tool composer-voice-btn ${voiceListening ? "is-listening" : ""}`}
            disabled={!canCompose}
            title={voiceListening ? t("chat.voiceListening") : t("chat.voice")}
            aria-label={t("chat.voice")}
            onClick={() => {
              if (voiceListening) {
                voiceRecognitionRef.current?.stop();
                setVoiceListening(false);
                return;
              }
              const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
              if (!SR) { alert(t("chat.voiceUnsupported")); return; }
              const rec = new SR();
              rec.lang = locale.value.startsWith("ja") ? "ja-JP" : "en-US";
              rec.interimResults = true;
              rec.continuous = false;
              let finalTranscript = "";
              rec.onresult = (e: any) => {
                let interim = "";
                for (let i = e.resultIndex; i < e.results.length; i++) {
                  if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript;
                  else interim += e.results[i][0].transcript;
                }
                setDraft(finalTranscript + interim);
              };
              rec.onend = () => { setVoiceListening(false); voiceRecognitionRef.current = null; };
              rec.onerror = () => { setVoiceListening(false); voiceRecognitionRef.current = null; };
              voiceRecognitionRef.current = rec;
              setVoiceListening(true);
              rec.start();
            }}
          >{voiceListening ? "⏹" : "🎤"}</button>
          <div class="composer-menu-wrap">
            <button
              type="button"
              class={`composer-tool composer-menu-trigger ${composerMenuOpen ? "is-open" : ""}`}
              title={t("chat.menu")}
              aria-label={t("chat.menu")}
              aria-expanded={composerMenuOpen}
              onClick={() => setComposerMenuOpen(!composerMenuOpen)}
            >☰</button>
            {composerMenuOpen && (
              <div class="composer-menu-panel" role="menu">
                <div class="composer-menu-section">{t("chat.menu.add")}</div>
                <button type="button" role="menuitem" class="composer-menu-item" onClick={() => { fileInputRef.current?.click(); setComposerMenuOpen(false); }}>
                  <span class="composer-menu-icon">📎</span>
                  <b>{t("chat.menu.files")}</b>
                </button>
                <button type="button" role="menuitem" class="composer-menu-item" onClick={() => { setModelOpen(true); setModelNote(undefined); setComposerMenuOpen(false); }}>
                  <span class="composer-menu-icon">⚙</span>
                  <b>{t("chat.menu.settings")}</b>
                </button>
                <button type="button" role="menuitem" class="composer-menu-item" onClick={() => setComposerMenuOpen(false)}>
                  <span class="composer-menu-icon">🎯</span>
                  <b>{t("chat.menu.goal")}</b>
                  <small>{t("chat.menu.goalHint")}</small>
                </button>
                <button type="button" role="menuitem" class="composer-menu-item" onClick={() => setComposerMenuOpen(false)}>
                  <span class="composer-menu-icon">💡</span>
                  <b>{t("chat.menu.planMode")}</b>
                  <small>{t("chat.menu.planModeHint")}</small>
                </button>
              </div>
            )}
          </div>
          <ComposerModelPickers
            profileId={profile.id}
            sessionId={session.id}
            sessionProvider={session.provider}
            sessionModel={session.model}
            canSend={canSend}
            onQueued={() => setModelNote(t("chat.model.queued"))}
            onOpenAdvanced={() => {
              setModelOpen(true);
              setModelNote(undefined);
            }}
          />
          {presetReadout && (
            <small class="composer-model-readout" title={t("chat.model.hint")}>
              <span class="composer-model-preset-name">{t("chat.modelPreset.readout", { name: presetReadout })}</span>
            </small>
          )}
        </div>
        {modelOpen && (
          <ChatModelPanel
            profileId={profile.id}
            sessionId={session.id}
            canSend={canSend}
            onClose={() => { setModelOpen(false); setModelNote(undefined); }}
            onQueued={() => setModelNote(t("chat.model.queued"))}
          />
        )}
        <div class="composer-main">
          <textarea
            value={draft}
            disabled={!canCompose}
            aria-busy={session.steerPending === true}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (shouldSubmitComposerKey(event)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onPaste={(event) => {
              const files = event.clipboardData?.files;
              const text = event.clipboardData?.getData("text/plain") ?? "";
              if (files && files.length > 0 && !text.trim()) {
                event.preventDefault();
                void addFiles(files);
              } else if (files && files.length > 0) {
                // Prefer keeping typed/pasted text; still stage image files without blocking text.
                void addFiles(files);
              }
            }}
            placeholder={composerPlaceholder}
            aria-label={composerPlaceholder}
            rows={2}
          />
          <div class="composer-actions">
            <button type="submit" disabled={submitDisabled}>{runActive ? t("chat.steer") : t("chat.send")}</button>
            {showStop && <button type="button" class="interrupt-button" aria-busy={session.interruptPending === true} disabled={session.connectionState !== "ready" || session.interruptPending === true} onClick={() => void interruptSession(session.id)}>{session.interruptPending ? t("chat.stopping") : t("chat.stop")}</button>}
          </div>
        </div>
        {(attachError || modelNote || blocked) && (
          <p class={`composer-note ${attachError ? "is-error" : ""}`}>
            {attachError ?? modelNote ?? (blocked ? t(`chat.blocked.${blocked}` as TranslationKey) : "")}
            {blocked === "disconnected" && isLiveChat && (
              <button type="button" onClick={() => reconnectChatSession(session.id)}>{t("chat.reconnect")}</button>
            )}
          </p>
        )}
      </form>
    </article>
  );
}

export function shouldSubmitComposerKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

export function formatChatMessageTime(
  value: string,
  selectedLocale: "ja" | "en" = locale.value,
  timeZone?: string
): string {
  if (/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(selectedLocale === "ja" ? "ja-JP" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone })
  }).format(date);
}

function PromptOperationMark({ operation }: { operation: Pick<ChatOperationEvidence, "state" | "message"> }) {
  return (
    <span class={`message-prompt-state is-${operation.state}`}>
      <span>{t(operationStateTranslation(operation.state))}</span>
      {operation.message && <small>{localizeRuntimeMessage(officeRuntimeMessage(operation.message))}</small>}
    </span>
  );
}

function operationStateTranslation(state: ChatOperationEvidence["state"]): TranslationKey {
  return ({
    pending: "chat.prompt.pending",
    accepted: "chat.prompt.accepted",
    rejected: "chat.prompt.rejected",
    unconfirmed: "chat.prompt.unconfirmed",
  } as const)[state];
}

export function presentedOperationEvidence(session: Pick<ChatSession, "messages" | "operationEvidence">): ChatOperationEvidence[] {
  const legacy = session.messages.flatMap<ChatOperationEvidence>((message): ChatOperationEvidence[] => {
    if (message.promptOperation) return [{
      id: message.promptOperation.id, kind: "prompt" as const, body: message.body, at: message.at,
      state: message.promptOperation.state,
      ...(message.promptOperation.message ? { message: message.promptOperation.message } : {}),
    }];
    return message.kind === "steer"
      ? [{ id: message.id, kind: "steer" as const, body: message.body, at: message.at, state: "accepted" as const }]
      : [];
  });
  return [...(session.operationEvidence ?? []), ...legacy];
}

type ChatTimelineItem =
  | { kind: "message"; message: ChatMessage; sequence: number }
  | { kind: "operation"; operation: ChatOperationEvidence; sequence: number };

type ChatLogGroup = {
  kind: "log-group";
  id: string;
  messages: ChatMessage[];
  sequence: number;
};

type PresentedChatTimelineItem = ChatTimelineItem | ChatLogGroup;

export function buildChatTimeline(messages: readonly ChatMessage[], evidence: readonly ChatOperationEvidence[]): ChatTimelineItem[] {
  const timeline: ChatTimelineItem[] = [
    ...messages.map((message, sequence) => ({ kind: "message" as const, message, sequence })),
    ...evidence.map((operation, index) => ({ kind: "operation" as const, operation, sequence: messages.length + index })),
  ];
  const times = timeline.map((item) => comparableTimelineTime(item.kind === "message" ? item.message.at : item.operation.at));
  if (times.some((time) => time === undefined) || new Set(times.map((time) => time?.kind)).size !== 1) return timeline;
  return timeline.sort((left, right) => {
    const leftTime = comparableTimelineTime(left.kind === "message" ? left.message.at : left.operation.at);
    const rightTime = comparableTimelineTime(right.kind === "message" ? right.message.at : right.operation.at);
    if (leftTime && rightTime && leftTime.value !== rightTime.value) return leftTime.value - rightTime.value;
    return left.sequence - right.sequence;
  });
}

export function groupChatTimeline(timeline: readonly ChatTimelineItem[]): PresentedChatTimelineItem[] {
  const grouped: PresentedChatTimelineItem[] = [];
  let pending: ChatMessage[] = [];
  let pendingSequence = 0;

  const flush = () => {
    if (pending.length === 0) return;
    grouped.push({
      kind: "log-group",
      // Stable across mid-stream appends: first tool message id anchors the run.
      id: pending[0]!.id,
      messages: pending,
      sequence: pendingSequence,
    });
    pending = [];
  };

  for (const item of timeline) {
    if (item.kind === "message" && isCompactLogMessage(item.message)) {
      if (pending.length === 0) pendingSequence = item.sequence;
      pending.push(item.message);
      continue;
    }
    flush();
    grouped.push(item);
  }
  flush();
  return grouped;
}

function isCompactLogMessage(message: ChatMessage): boolean {
  if (message.status === "failed" || message.status === "cancelled") return false;
  return message.from === "tool"
    || message.presentation?.kind === "tool-fallback"
    || message.body.trim() === "[Tool output hidden]";
}

function ChatLogGroup({
  group,
  expanded,
  onToggle,
  profile,
  profileName,
}: {
  group: ChatLogGroup;
  expanded: boolean;
  onToggle: () => void;
  profile: Profile;
  profileName: string;
}) {
  const latest = group.messages.at(-1);
  const preview = latest && latest.body.trim() !== "[Tool output hidden]" ? chatMessageBody(latest) : t("chat.tool");
  return (
    <section class={`chat-log-group ${expanded ? "is-expanded" : ""}`}>
      <button type="button" class="chat-log-group-toggle" aria-expanded={expanded} onClick={onToggle}>
        <span class="chat-log-group-icon" aria-hidden="true">⚙</span>
        <b>{t("chat.logs.group", { count: group.messages.length })}</b>
        <span class="chat-log-group-preview">{preview}</span>
        <small>{expanded ? t("chat.logs.collapse") : t("chat.logs.expand")}</small>
      </button>
      {expanded && (
        <div class="chat-log-group-items">
          {group.messages.map((message) => <ChatMessageEntry key={message.id} message={message} profile={profile} profileName={profileName} />)}
        </div>
      )}
    </section>
  );
}

function ChatMessageEntry({ message, profile, profileName }: { message: ChatMessage; profile: Profile; profileName: string }) {
  return (
    <div
      class={`message message-${message.from} message-${message.status ?? "complete"}`}
      style={message.from === "agent" ? { "--agent-color": profile.color } : undefined}
    >
      <span class="visually-hidden">{message.from === "user" ? t("chat.you") : message.from === "tool" ? t("chat.tool") : profileName}</span>
      {message.from === "tool" && <span class="message-tool-mark" aria-hidden="true">⚙</span>}
      {message.from === "tool"
        ? <p>{chatMessageBody(message) || (message.status === "streaming" ? "…" : "")}</p>
        : <MarkdownBody text={chatMessageBody(message)} streaming={message.status === "streaming"} />}
      <time>{formatChatMessageTime(message.at)}</time>
    </div>
  );
}

export function nextOperationAnnouncement(
  evidence: readonly ChatOperationEvidence[],
  previousKey: string,
): { key: string; operation: ChatOperationEvidence } | undefined {
  const operation = evidence.at(-1);
  if (!operation) return undefined;
  const key = `${operation.id}\0${operation.state}\0${operation.message ?? ""}`;
  return key === previousKey ? undefined : { key, operation };
}

export function operationAnnouncementText(operation: ChatOperationEvidence): string {
  const kind = operation.kind === "steer" ? t("chat.operation.steer") : t("chat.operation.prompt");
  const state = t(operationStateTranslation(operation.state));
  const body = operation.body.length > 160 ? `${operation.body.slice(0, 160)}…` : operation.body;
  return t("chat.operation.announcement", { kind, state, body });
}

function isUrgentOperation(operation: ChatOperationEvidence): boolean {
  return operation.state === "rejected" || operation.state === "unconfirmed";
}

function ChatOperationEntry({ operation }: { operation: ChatOperationEvidence }) {
  const attention = operation.state === "pending" || operation.state === "rejected" || operation.state === "unconfirmed";
  return (
    <details class={`chat-operation-ledger chat-operation is-${operation.state}`} open={attention || undefined} aria-live="off">
      <summary>
        <span><b>{operation.kind === "steer" ? t("chat.operation.steer") : t("chat.operation.prompt")}</b><PromptOperationMark operation={operation} /></span>
        <span class="chat-operation-body">{operation.body}</span>
        <time>{formatChatMessageTime(operation.at)}</time>
      </summary>
      <div class="chat-operation-meta">
        <code>{operation.id}</code>
      </div>
    </details>
  );
}

function comparableTimelineTime(value: string): { kind: "absolute" | "clock"; value: number } | undefined {
  const clock = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)(?::(?<second>[0-5]\d))?$/.exec(value)?.groups;
  if (clock) return { kind: "clock", value: Number(clock.hour) * 3600 + Number(clock.minute) * 60 + Number(clock.second ?? 0) };
  const absolute = Date.parse(value);
  return Number.isNaN(absolute) ? undefined : { kind: "absolute", value: absolute };
}

export function chatComposerState(session: ChatSession): { canCompose: boolean; canSteer: boolean; runActive: boolean; showStop: boolean } {
  const runActive = isChatRunActive(session);
  const canSteer = canSteerChatSession(session);
  const showStop = runActive && (session.remoteKind === "stored" || session.remoteKind === "draft");
  return { runActive, canSteer, canCompose: canSubmitChatPrompt(session) || canSteer, showStop };
}

function ChatInteraction({ sessionId, interaction, connected }: {
  sessionId: string;
  interaction: ChatPendingInteraction;
  connected: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const disabled = !connected || interaction.submitting;

  useEffect(() => setAnswer(""), [interaction.id]);

  if (interaction.kind === "approval") {
    const canApprovePermanently = interaction.allowPermanent
      && officeSnapshot.value?.capabilities.access.allowedOperations.includes("chat.approval.permanent") === true;
    const choices = approvalChoicesForAccess(interaction, canApprovePermanently);
    return (
      <section class="chat-interaction approval-interaction" aria-label={t("chat.approvalAria")}>
        <span class="interaction-kicker">{t("chat.approvalRequired")}</span>
        <h3>{interaction.description || t("chat.approvalFallback")}</h3>
        {interaction.command && <pre><code>{interaction.command}</code></pre>}
        {interaction.error && <p class="interaction-error" role="alert">{localizeRuntimeMessage(interaction.error)}</p>}
        {!connected && <p class="interaction-note">{t("chat.approvalOffline")}</p>}
        <div class="interaction-actions">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              class={choice === "deny" ? "is-deny" : choice === "always" ? "is-permanent" : ""}
              disabled={disabled || (choice === "always" && !canApprovePermanently)}
              onClick={() => void respondToApproval(sessionId, choice)}
            >
              {approvalLabel(choice)}
            </button>
          ))}
        </div>
        {interaction.submitting && <span class="interaction-progress">{t("chat.submitting")}</span>}
      </section>
    );
  }

  return (
    <section class="chat-interaction clarify-interaction" aria-label={t("chat.clarifyAria")}>
      <span class="interaction-kicker">{t("chat.clarification")}</span>
      <h3>{interaction.question}</h3>
      {interaction.error && <p class="interaction-error" role="alert">{localizeRuntimeMessage(interaction.error)}</p>}
      {!connected && <p class="interaction-note">{t("chat.clarifyOffline")}</p>}
      {interaction.choices.length > 0 && (
        <div class="interaction-actions">
          {interaction.choices.map((choice) => (
            <button type="button" key={choice} disabled={disabled} onClick={() => void respondToClarification(sessionId, choice)}>{choice}</button>
          ))}
        </div>
      )}
      <form class="clarify-answer" onSubmit={(event) => {
        event.preventDefault();
        void respondToClarification(sessionId, answer);
      }}>
        <input
          value={answer}
          disabled={disabled}
          onInput={(event) => setAnswer(event.currentTarget.value)}
          placeholder={t("chat.freeAnswer")}
          aria-label={t("chat.answerAria")}
        />
        <button type="submit" disabled={disabled || !answer.trim()}>{t("chat.answer")}</button>
      </form>
      {interaction.submitting && <span class="interaction-progress">{t("chat.submitting")}</span>}
    </section>
  );
}

export function approvalChoicesForAccess(
  interaction: Extract<ChatPendingInteraction, { kind: "approval" }>,
  canApprovePermanently: boolean,
): ApprovalChoice[] {
  return interaction.choices.filter((choice) => choice !== "always" || canApprovePermanently);
}

function approvalLabel(choice: ApprovalChoice): string {
  if (choice === "once") return t("approval.once");
  if (choice === "session") return t("approval.session");
  if (choice === "always") return t("approval.always");
  return t("approval.deny");
}
