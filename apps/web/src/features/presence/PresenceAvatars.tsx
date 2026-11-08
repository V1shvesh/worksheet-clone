import { emailLocalPart, uniquePeersByUser } from "../../crdt/presence";
import { usePresence } from "../../crdt/usePresence";
import "./PresenceAvatars.css";

const MAX_VISIBLE = 5;

/** "bob@x" → "B", "jane.doe@x" → "JD". */
export function initialsOf(email: string): string {
  const parts = emailLocalPart(email)
    .split(/[._+-]+/)
    .filter(Boolean);
  const letters = parts.length > 1 ? parts.slice(0, 2).map((p) => p[0]) : [parts[0]?.[0]];
  return letters.join("").toUpperCase() || "?";
}

/** Who else has the workbook open (viewers and this user's other tabs included), one circle per user. */
export function PresenceAvatars() {
  const people = uniquePeersByUser(usePresence());
  if (people.length === 0) return null;
  const shown = people.slice(0, MAX_VISIBLE);
  const hidden = people.slice(MAX_VISIBLE);
  return (
    <ul className="presence-avatars" data-testid="presence-avatars" aria-label="Collaborators">
      {shown.map((peer) => (
        <li
          key={peer.user.id}
          className="presence-avatar"
          data-testid="presence-avatar"
          data-user-id={peer.user.id}
          title={peer.isSelf ? `${peer.user.email} (you, another tab)` : peer.user.email}
          style={{ backgroundColor: peer.user.color }}
        >
          {initialsOf(peer.user.email)}
        </li>
      ))}
      {hidden.length > 0 && (
        <li
          className="presence-avatar presence-avatar-more"
          data-testid="presence-avatar-more"
          title={hidden.map((p) => p.user.email).join(", ")}
        >
          +{hidden.length}
        </li>
      )}
    </ul>
  );
}
