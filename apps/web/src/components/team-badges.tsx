import { t } from "../i18n";
import { teamsForProfile } from "../teams-store";

const MAX_VISIBLE = 2;

export function TeamBadges({ profileId, compact = false }: { profileId: string; compact?: boolean }) {
  const memberships = teamsForProfile(profileId);
  if (memberships.length === 0) return null;
  const visible = memberships.slice(0, MAX_VISIBLE);
  const overflow = memberships.length - visible.length;
  return (
    <span class={`team-badges ${compact ? "team-badges--compact" : ""}`} aria-label={t("teams.memberships", { count: memberships.length })}>
      {visible.map((team) => (
        <span key={team.id} class="team-badge" style={{ "--team-color": team.color }} title={team.name}>
          <i aria-hidden="true" />
          <span>{team.name}</span>
        </span>
      ))}
      {overflow > 0 && <span class="team-badge is-more" title={memberships.map((team) => team.name).join(", ")}>+{overflow}</span>}
    </span>
  );
}
