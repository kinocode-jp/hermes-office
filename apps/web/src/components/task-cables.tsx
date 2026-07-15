import { useId } from "preact/hooks";
import "./task-cables.css";

export type TaskCableState = "queued" | "active" | "blocked";

export type TaskCablePoint = {
  x: number;
  y: number;
};

export type TaskCable = {
  /** Stable identifier for selection and SVG animation remounts. */
  id: string;
  taskId: string;
  taskLabel: string;
  profileId: string;
  profileName: string;
  source: TaskCablePoint;
  target: TaskCablePoint;
  state: TaskCableState;
  /** Shows one bounded plug-in pulse when this cable is mounted. */
  pulse?: boolean;
  /** Allows callers without controlled selection state to mark a cable. */
  selected?: boolean;
};

export type TaskCablesProps = {
  cables: readonly TaskCable[];
  /** Coordinate-space width; usually the measured office floor width. */
  width: number;
  /** Coordinate-space height; usually the measured office floor height. */
  height: number;
  selectedCableId?: string;
  onSelect?: (cable: TaskCable) => void;
  ariaLabel?: string;
  class?: string;
  /** May reduce work further, but can never exceed the hard limit of 100. */
  maxCables?: number;
};

const HARD_CABLE_LIMIT = 100;
const LANE_GAP = 4;
const LANE_COUNT = 7;

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pointInBounds(point: TaskCablePoint, width: number, height: number) {
  return {
    x: clamp(finite(point.x), 0, width),
    y: clamp(finite(point.y), 0, height),
  };
}

function cablePath(cable: TaskCable, index: number, width: number, height: number) {
  const source = pointInBounds(cable.source, width, height);
  const target = pointInBounds(cable.target, width, height);
  const lane = (index % LANE_COUNT) - Math.floor(LANE_COUNT / 2);
  const direction = Math.sign(target.x - source.x) || 1;
  const bend = source.x + (target.x - source.x) * 0.42 + lane * LANE_GAP * direction;
  const bendX = clamp(bend, 0, width);

  return `M ${source.x} ${source.y} H ${bendX} V ${target.y} H ${target.x}`;
}

function CableTerminal({ cable }: { cable: TaskCable }) {
  const { x, y } = cable.target;

  if (cable.state === "active") {
    return <circle class="task-cable__terminal" cx={x} cy={y} r="4" />;
  }

  if (cable.state === "blocked") {
    return (
      <rect
        class="task-cable__terminal"
        x={x - 4}
        y={y - 4}
        width="8"
        height="8"
        transform={`rotate(45 ${x} ${y})`}
      />
    );
  }

  return <rect class="task-cable__terminal" x={x - 3.5} y={y - 3.5} width="7" height="7" />;
}

function accessibleCableLabel(cable: TaskCable) {
  const stateLabel = {
    queued: "待機中",
    active: "実行中",
    blocked: "ブロック中",
  }[cable.state];

  return `${cable.taskLabel}、担当 ${cable.profileName}、${stateLabel}`;
}

export function TaskCables({
  cables,
  width,
  height,
  selectedCableId,
  onSelect,
  ariaLabel = "仕事と担当Profileの接続",
  class: className,
  maxCables = HARD_CABLE_LIMIT,
}: TaskCablesProps) {
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  const requestedLimit = Math.max(0, Math.floor(finite(maxCables, HARD_CABLE_LIMIT)));
  const limit = Math.min(HARD_CABLE_LIMIT, requestedLimit);
  const visibleCables = cables.slice(0, limit);
  const overflowCount = Math.max(0, cables.length - visibleCables.length);
  const classes = ["task-cables", className].filter(Boolean).join(" ");
  const instanceId = useId().replaceAll(":", "");

  return (
    <div class={classes} data-cable-count={visibleCables.length} data-overflow-count={overflowCount}>
      <svg
        class="task-cables__svg"
        viewBox={`0 0 ${safeWidth} ${safeHeight}`}
        preserveAspectRatio="none"
        role="group"
        aria-label={`${ariaLabel}、${visibleCables.length}件${overflowCount > 0 ? `、ほか${overflowCount}件は省略` : ""}`}
      >
        {visibleCables.map((cable, index) => {
          const selected = selectedCableId === cable.id || cable.selected === true;
          const path = cablePath(cable, index, safeWidth, safeHeight);
          const pathId = `${instanceId}-task-cable-path-${index}`;
          const terminalCable = {
            ...cable,
            target: pointInBounds(cable.target, safeWidth, safeHeight),
          };

          return (
            <g
              class={`task-cable task-cable--${cable.state}${selected ? " is-selected" : ""}`}
              data-cable-id={cable.id}
              data-task-id={cable.taskId}
              data-profile-id={cable.profileId}
              role={onSelect ? "button" : "img"}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={accessibleCableLabel(cable)}
              aria-pressed={onSelect ? selected : undefined}
              onClick={onSelect ? () => onSelect(cable) : undefined}
              onKeyDown={onSelect ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(cable);
                }
              } : undefined}
              key={cable.id}
            >
              <title>{accessibleCableLabel(cable)}</title>
              <path class="task-cable__shadow" d={path} />
              <path id={pathId} class="task-cable__line" d={path} />
              {onSelect && <path class="task-cable__hit-area" d={path} />}
              <CableTerminal cable={terminalCable} />
              {cable.pulse && (
                <rect class="task-cable__pulse" x="-3" y="-3" width="6" height="6">
                  <animateMotion dur="500ms" repeatCount="1" fill="freeze">
                    <mpath href={`#${pathId}`} />
                  </animateMotion>
                </rect>
              )}
            </g>
          );
        })}
      </svg>

    </div>
  );
}

export const taskCableLimit = HARD_CABLE_LIMIT;
