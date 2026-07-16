import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Profile } from "../domain";
import { t, type TranslationKey } from "../i18n";
import {
  CELL,
  cellCenter,
  createCharacters,
  generateWorld,
  tickCharacters,
  type OfficeLayoutId,
  type OfficeSizeId,
  type OfficeWorld,
  type SimCharacter
} from "../office/sim";
import { assignTask, selectProfile, selectedProfileId, sessions, tasks } from "../store";
import { loadMoreProfiles, profileInventoryState } from "../inventory";
import { CharacterPortrait } from "./character-portrait";
import { InfoTip } from "./info-tip";
import { StatusPill } from "./status-pill";
import { TaskCables, type TaskCable } from "./task-cables";
import "./office-scene.css";

const statusTranslation: Record<Profile["status"], TranslationKey> = {
  working: "status.working",
  waiting: "status.waiting",
  idle: "status.idle",
  blocked: "status.blocked"
};

type OfficeView = "scene" | "list";

function storedPreference<T extends string>(key: string, fallback: T, valid: readonly T[]): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return valid.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function persistPreference(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Preferences may be blocked. */ }
}

const officeView = signal<OfficeView>(storedPreference("hermes-office.office-view", "scene", ["scene", "list"]));
const officeLayout = signal<OfficeLayoutId>(storedPreference("hermes-office.office-layout", "studio", ["studio", "lounge"]));
const officeSize = signal<OfficeSizeId>(storedPreference("hermes-office.office-size", "m", ["s", "m", "l"]));

function setView(view: OfficeView): void { officeView.value = view; persistPreference("hermes-office.office-view", view); }
function setLayout(layout: OfficeLayoutId): void { officeLayout.value = layout; persistPreference("hermes-office.office-layout", layout); }
function setSize(size: OfficeSizeId): void { officeSize.value = size; persistPreference("hermes-office.office-size", size); }

const CHAR_W = 56;
const CHAR_H = 76;

function profileActivity(profileId: string): string | undefined {
  const profileSessions = sessions.value.filter((session) => session.profileId === profileId);
  const current = profileSessions.find((session) => session.status === "streaming" || session.status === "waiting") ?? profileSessions[0];
  return current?.title;
}

function profileDropHandlers(profileId: string) {
  return {
    onDragOver: (event: DragEvent) => event.preventDefault(),
    onDrop: (event: DragEvent) => {
      const taskId = event.dataTransfer?.getData("application/x-hermes-task");
      if (taskId) assignTask(taskId, profileId);
    }
  };
}

function characterTransform(character: SimCharacter): string {
  return `translate3d(${Math.round(character.x - CHAR_W / 2)}px, ${Math.round(character.y - CHAR_H + 14)}px, 0)`;
}

function OfficeStage({ profiles, world }: { profiles: Profile[]; world: OfficeWorld }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const charEls = useRef(new Map<string, HTMLButtonElement>());
  const simRef = useRef<SimCharacter[]>([]);
  const statusRef = useRef(new Map<string, Profile["status"]>());
  const [scale, setScale] = useState(1);
  const worldW = world.cols * CELL;
  const worldH = world.rows * CELL;
  const profileKey = profiles.map((profile) => profile.id).join("|");

  statusRef.current = new Map(profiles.map((profile) => [profile.id, profile.status]));

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      setScale(Math.min(rect.width / worldW, rect.height / worldH, 1.4));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [worldW, worldH]);

  useEffect(() => {
    simRef.current = createCharacters(world, profiles.map((profile) => profile.id), simRef.current);
    const paint = (now = performance.now()) => {
      const walkFrame = Math.floor(now / 220) % 2;
      for (const character of simRef.current) {
        const el = charEls.current.get(character.id);
        if (!el) continue;
        el.style.transform = characterTransform(character);
        el.style.zIndex = String(100 + Math.round(character.y / 4));
        el.classList.toggle("is-walking", character.moving);
        el.dataset.direction = character.direction;
        el.dataset.walkFrame = String(walkFrame);
      }
    };
    paint();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Without motion, seat everyone at their desk once and stop.
      for (const character of simRef.current) {
        const desk = world.desks[character.deskIndex];
        if (desk) {
          const seat = cellCenter(desk.chair);
          character.x = seat.x;
          character.y = seat.y;
        }
      }
      paint();
      return;
    }
    // Interval-driven so the sim keeps running where rAF is throttled;
    // the CSS transform transition smooths between the coarse updates.
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      tickCharacters(world, simRef.current, statusRef.current, dt);
      paint(now);
    }, 80);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, profileKey]);

  const cables: TaskCable[] = tasks.value.flatMap((task) => {
    if (!task.assigneeId) return [];
    const index = profiles.findIndex((profile) => profile.id === task.assigneeId);
    const desk = world.desks[index];
    if (index < 0 || !desk) return [];
    const profile = profiles[index]!;
    return [{
      id: `cable-${task.id}`,
      taskId: task.id,
      taskLabel: task.title,
      profileId: profile.id,
      profileName: profile.name,
      source: { x: (world.board.x + world.board.w / 2) * CELL, y: CELL * 0.9 },
      target: { x: (desk.x + 1) * CELL, y: (desk.y + 0.4) * CELL },
      state: task.status === "running" ? "active" : task.status === "blocked" ? "blocked" : "queued",
      pulse: task.status === "running"
    }];
  });

  return (
    <div class="office-stage" ref={stageRef}>
      <div class="office-world" style={{ width: `${worldW}px`, height: `${worldH}px`, transform: `scale(${scale})` }}>
        <div class="ow-wall" style={{ height: `${CELL}px` }} aria-hidden="true">
          <span /><span /><span /><span />
          <span class="ow-board" style={{ left: `${world.board.x * CELL}px`, width: `${world.board.w * CELL}px` }}>{t("office.board")}</span>
        </div>
        {world.objects.map((object) => (
          <div
            key={object.id}
            class={`ow-obj ow-${object.type}`}
            style={{ left: `${object.x * CELL}px`, top: `${object.y * CELL}px`, width: `${object.w * CELL}px`, height: `${object.h * CELL}px`, zIndex: object.solid ? 60 + object.y : 10 }}
            aria-hidden="true"
          />
        ))}
        {world.desks.slice(0, profiles.length).map((desk, index) => (
          <div
            key={`desk-${index}`}
            class="ow-obj ow-desk"
            style={{ left: `${desk.x * CELL}px`, top: `${desk.y * CELL}px`, width: `${2 * CELL}px`, height: `${CELL}px`, zIndex: 60 + desk.y, "--agent-color": profiles[index]!.color }}
            aria-hidden="true"
          >
            <i class="ow-monitor" />
          </div>
        ))}
        {cables.length > 0 && (
          <TaskCables cables={cables} width={worldW} height={worldH} maxCables={24} onSelect={(cable) => selectProfile(cable.profileId)} />
        )}
        {profiles.map((profile, profileIndex) => {
          const stateLabel = t(statusTranslation[profile.status]);
          const activity = profileActivity(profile.id);
          return (
            <button
              key={profile.id}
              ref={(el) => { if (el) charEls.current.set(profile.id, el); else charEls.current.delete(profile.id); }}
              class={`ow-char ${selectedProfileId.value === profile.id ? "is-selected" : ""}`}
              style={{ width: `${CHAR_W}px`, height: `${CHAR_H}px`, "--agent-color": profile.color }}
              data-status={profile.status}
              title={activity ?? stateLabel}
              onClick={() => selectProfile(profile.id)}
              {...profileDropHandlers(profile.id)}
              aria-label={t("office.profileLabel", { name: profile.name, state: stateLabel, activity: activity ?? stateLabel, count: profile.sessions })}
            >
              <CharacterPortrait profileId={profile.id} profileName={profile.name} profileIndex={profileIndex} class="character-portrait--sim" decorative />
              <span class="ow-char-name">{profile.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OfficeList({ profiles }: { profiles: Profile[] }) {
  return (
    <div class="office-list">
      {profiles.map((profile, profileIndex) => {
        const stateLabel = t(statusTranslation[profile.status]);
        const activity = profileActivity(profile.id);
        return (
          <button
            key={profile.id}
            class={`office-row ${selectedProfileId.value === profile.id ? "is-selected" : ""}`}
            style={{ "--agent-color": profile.color }}
            onClick={() => selectProfile(profile.id)}
            {...profileDropHandlers(profile.id)}
            aria-label={t("office.profileLabel", { name: profile.name, state: stateLabel, activity: activity ?? stateLabel, count: profile.sessions })}
          >
            <CharacterPortrait profileId={profile.id} profileName={profile.name} profileIndex={profileIndex} class="character-portrait--row" decorative />
            <span class="office-row-main">
              <b>{profile.name}</b>
              {activity && <small title={activity}>{activity}</small>}
            </span>
            <span class="office-row-meta">
              <StatusPill status={profile.status} />
              {profile.sessions > 0 && <span class="chat-chip" title={`${profile.sessions} ${t("office.chats")}`}>{profile.sessions}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function OfficeScene({ profiles }: { profiles: Profile[] }) {
  const working = profiles.filter((profile) => profile.status === "working").length;
  const attention = profiles.filter((profile) => profile.status === "waiting" || profile.status === "blocked").length;
  const world = useMemo(
    () => generateWorld(officeLayout.value, officeSize.value, Math.max(1, profiles.length)),
    [officeLayout.value, officeSize.value, profiles.length]
  );
  const inventory = profileInventoryState.value;

  return (
    <section class="office-wrap" aria-labelledby="office-title" data-view={officeView.value}>
      <header class="office-heading">
        <h1 id="office-title">{t("office.title")} <InfoTip text={t("office.hint")} align="start" side="bottom" /></h1>
        <div class="office-toolbar">
          <div class="shift-readout" aria-label={t("office.summary")}>
            <span class="stat stat--working" title={t("office.workingCount")}><i /><b>{working}</b></span>
            <span class="stat stat--waiting" title={t("office.attentionCount")}><i /><b>{attention}</b></span>
            <span class="stat stat--total" title={t("office.profilesCount")}><i /><b>{profiles.length}</b></span>
          </div>
          <div class="office-seg office-seg--view" role="group" aria-label={t("office.viewLabel")}>
            <button type="button" class={officeView.value === "scene" ? "is-active" : ""} title={t("office.viewScene")} aria-label={t("office.viewScene")} onClick={() => setView("scene")}>▦</button>
            <button type="button" class={officeView.value === "list" ? "is-active" : ""} title={t("office.viewList")} aria-label={t("office.viewList")} onClick={() => setView("list")}>☰</button>
          </div>
          {officeView.value === "scene" && (
            <>
              <div class="office-seg office-seg--scene" role="group" aria-label={t("office.layoutLabel")}>
                <button type="button" class={officeLayout.value === "studio" ? "is-active" : ""} title={t("office.layout.studio")} onClick={() => setLayout("studio")}>A</button>
                <button type="button" class={officeLayout.value === "lounge" ? "is-active" : ""} title={t("office.layout.lounge")} onClick={() => setLayout("lounge")}>B</button>
              </div>
              <div class="office-seg office-seg--scene" role="group" aria-label={t("office.sizeLabel")}>
                {(["s", "m", "l"] as const).map((size) => (
                  <button key={size} type="button" class={officeSize.value === size ? "is-active" : ""} title={`${t("office.sizeLabel")} ${size.toUpperCase()}`} onClick={() => setSize(size)}>{size.toUpperCase()}</button>
                ))}
              </div>
            </>
          )}
        </div>
      </header>

      {officeView.value === "scene" && <OfficeStage profiles={profiles} world={world} />}
      <OfficeList profiles={profiles} />
      {inventory.hasMore && <button class="secondary-button inventory-more" disabled={inventory.loading} onClick={() => void loadMoreProfiles()}>{inventory.loading ? t("inventory.loading") : t("inventory.showMore")}</button>}
      {inventory.truncated && !inventory.hasMore && <small class="inventory-note">{t("inventory.truncated")}</small>}
      {inventory.error && <small class="inventory-note inventory-note--error">{inventory.error}</small>}
    </section>
  );
}
