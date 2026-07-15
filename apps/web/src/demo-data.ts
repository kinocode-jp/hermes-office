import type { ChatSession, Profile, WorkTask } from "./domain";

export const profiles: Profile[] = [
  {
    id: "researcher",
    name: "Mina",
    role: "Research",
    status: "working",
    color: "#64b7a7",
    sessions: 2,
    taskCount: 3,
    memoryBytes: 1842,
    memoryNote: "一次情報を優先し、調査結果には出典と確度を付ける。",
    skills: ["source-review", "market-map"],
    inheritedSkills: ["web-search", "document-reader"]
  },
  {
    id: "builder",
    name: "Theo",
    role: "Engineering",
    status: "waiting",
    color: "#e07a55",
    sessions: 3,
    taskCount: 2,
    memoryBytes: 1270,
    memoryNote: "変更は小さく保ち、型境界と失敗時の挙動を先に固める。",
    skills: ["typescript", "release-check"],
    inheritedSkills: ["git", "terminal"]
  },
  {
    id: "operator",
    name: "Iris",
    role: "Operations",
    status: "blocked",
    color: "#d6a94f",
    sessions: 1,
    taskCount: 4,
    memoryBytes: 2031,
    memoryNote: "外部操作は必ず確認を挟み、復旧手順を作業記録へ残す。",
    skills: ["inbox-triage", "incident-notes"],
    inheritedSkills: ["calendar", "kanban"]
  },
  {
    id: "editor",
    name: "Ren",
    role: "Editorial",
    status: "idle",
    color: "#8499c8",
    sessions: 1,
    taskCount: 1,
    memoryBytes: 988,
    memoryNote: "簡潔な日本語を使い、固有名詞と数値は公開前に再確認する。",
    skills: ["tone-guide", "fact-check"],
    inheritedSkills: ["document-reader"]
  }
];

export const initialSessions: ChatSession[] = [
  {
    id: "s-research-1",
    profileId: "researcher",
    title: "Hermes API調査",
    status: "streaming",
    messages: [
      { id: "m1", from: "user", body: "公式APIで安定して使える境界を整理して。", at: "10:21" },
      { id: "m2", from: "agent", body: "Profile、Session、Kanbanを分けて確認しています。まずserveの接続契約を固定します。", at: "10:22" },
      { id: "m3", from: "tool", body: "Reading developer guide / desktop backend", at: "10:22" }
    ]
  },
  {
    id: "s-build-1",
    profileId: "builder",
    title: "Office UI",
    status: "waiting",
    messages: [
      { id: "m4", from: "user", body: "Profileをキャラクターとして扱って。", at: "10:08" },
      { id: "m5", from: "agent", body: "各キャラクターに複数Sessionを束ねました。レイアウト確認を待っています。", at: "10:11" }
    ]
  },
  {
    id: "s-build-2",
    profileId: "builder",
    title: "PWA shell",
    status: "ready",
    messages: [{ id: "m6", from: "agent", body: "Installable shell is ready for review.", at: "09:48" }]
  }
];

export const initialTasks: WorkTask[] = [
  { id: "t-104", title: "serve接続契約を固定", status: "running", assigneeId: "researcher", priority: "high", comments: 3 },
  { id: "t-105", title: "Profile継承モデル", status: "ready", assigneeId: "builder", priority: "normal", comments: 1 },
  { id: "t-106", title: "Remote auth threat model", status: "blocked", assigneeId: "operator", priority: "high", comments: 4 },
  { id: "t-107", title: "Mobile chat navigation", status: "triage", priority: "normal", comments: 0 },
  { id: "t-108", title: "Skill provenance labels", status: "ready", assigneeId: "editor", priority: "normal", comments: 2 },
  { id: "t-102", title: "Office state reducer", status: "done", assigneeId: "builder", priority: "normal", comments: 2 }
];
