import type { ComponentChildren, JSX } from "preact";

type IconProps = Omit<JSX.IntrinsicElements["svg"], "children"> & {
  children?: ComponentChildren;
};

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 7.5 8 2.5l5.5 5" />
      <path d="M4 7v6.5h8V7" />
    </Icon>
  );
}

export function BoardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.5" width="3.2" height="11" rx="0.6" />
      <rect x="6.4" y="2.5" width="3.2" height="7" rx="0.6" />
      <rect x="10.8" y="2.5" width="3.2" height="9" rx="0.6" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.5" cy="5" r="2.2" />
      <path d="M1.8 13.5c0-2 1.7-3.6 3.7-3.6s3.7 1.6 3.7 3.6" />
      <circle cx="11.2" cy="5.4" r="1.8" />
      <path d="M10.6 9.9c2 .2 3.6 1.7 3.6 3.6" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 2v1.8M8 12.2V14M2 8h1.8M12.2 8H14M3.8 3.8l1.3 1.3M10.9 10.9l1.3 1.3M12.2 3.8l-1.3 1.3M5.1 10.9l-1.3 1.3" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.8V8l2.4 1.5" />
    </Icon>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Icon>
  );
}

export function CardsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2" width="5.2" height="5.2" rx="0.8" />
      <rect x="8.8" y="2" width="5.2" height="5.2" rx="0.8" />
      <rect x="2" y="8.8" width="5.2" height="5.2" rx="0.8" />
      <rect x="8.8" y="8.8" width="5.2" height="5.2" rx="0.8" />
    </Icon>
  );
}

export function GroupIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="5" width="8" height="8.5" rx="1" />
      <path d="M5.5 5V3.5a1 1 0 0 1 1-1H13a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1h-1.5" />
    </Icon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3.5 3z" />
    </Icon>
  );
}
