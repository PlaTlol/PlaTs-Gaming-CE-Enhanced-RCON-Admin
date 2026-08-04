'use strict';

// ---------------------------------------------------------------------------
// Targeting a player for `con <id> <command>`.
//
// THE RULE: <id> must be the account token `name#number` — the **Player name**
// column of `listplayers` (parts[2] in parseListPlayers), e.g. `PlaT#49895`.
//
// What must NEVER be used, and why:
//
//   * The "User ID" column (`A-8CPC756VE`). Despite the name it is not a Funcom
//     account id, `con` cannot resolve it, and it will move a DIFFERENT player.
//     Two distinct User IDs have been observed resolving to the same character
//     object on a live server — that is what caused the arena incident where a
//     single teleport moved two uninvolved players.
//
//   * The Platform / Steam ID. It is all digits, and an all-digit token gets
//     re-parsed by the server as an `idx` — so it silently targets whoever
//     happens to occupy that index.
//
//   * `idx` — permitted only as a last-resort fallback. It shifts on ANY join
//     or leave, so it is stale the moment the roster changes.
//
// The account display name need not resemble the character name: an order for
// character `Cummere` correctly sends `con Spacey#74755 …` — same person. That
// is why every call must join through a fresh `listplayers` rather than assume
// the character name is the token.
//
// THE TOKEN MUST BE SENT IN DOUBLE QUOTES. Account names may contain spaces
// (`GsQ Spoz#12345`), and `con` splits its argument list on whitespace, so an
// unquoted spaced token loses everything after the first word:
//
//   con Nobody Here#00000 TeleportPlayer 1 1 1
//     -> Command not recognized: Here#00000 TeleportPlayer 1 1 1   (split)
//   con "Nobody Here#00000" TeleportPlayer 1 1 1
//     -> Couldn't find a valid player with name Nobody Here#00000  (whole name)
//
// `con` honours double quotes, and quoting a name WITHOUT a space behaves
// identically — so quoting is unconditional and there is one code path.
// Unquoted, a spaced name falls through to the positional `con <idx>` path,
// which targets whoever currently occupies that index.
// ---------------------------------------------------------------------------

const TOKEN_RE = /^.+#\d+$/;
const ALL_DIGITS_RE = /^\d+$/;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// The `con` token for an online player row, or null if the row can't provide a
// safe one. All-digit player names are rejected outright (they'd be read as idx).
// A name containing a double quote is rejected too: it would close the quoting
// early and let the rest of the name run as a command.
function conToken(player) {
  if (!player) return null;
  const name = String(player.playerName == null ? '' : player.playerName).trim();
  if (!name) return null;
  if (ALL_DIGITS_RE.test(name)) return null;
  if (name.includes('"')) return null;
  return name;
}

// Why conToken() refused, for an error the admin can act on.
function tokenRejectReason(player) {
  const name = String((player && player.playerName) == null ? '' : player.playerName).trim();
  if (!name) return 'listplayers reports no account name for them';
  if (ALL_DIGITS_RE.test(name)) return `their account name "${name}" is all digits, which the server re-reads as a player index`;
  if (name.includes('"')) return `their account name "${name}" contains a double quote, which would break out of the quoted target`;
  return 'their account name is unusable';
}

// Wrap a token for emission. ALWAYS quote — see the header note. Callers must
// use this rather than interpolating the bare token.
const conQuote = (token) => `"${token}"`;

// Quote a console-command NAME ARGUMENT (e.g. `TeleportToPlayer <name>`) only
// when it contains whitespace. Unspaced names are emitted exactly as before —
// that path is proven in the field, so it stays byte-for-byte identical, while
// a spaced name (which currently splits and cannot work at all) gets quoted.
const nameArg = (name) => {
  const n = String(name == null ? '' : name).trim();
  return /\s/.test(n) ? `"${n}"` : n;
};

// True when the token carries the `#number` discriminator we expect.
const isFullToken = (token) => !!token && TOKEN_RE.test(token);

class AmbiguousPlayerError extends Error {
  constructor(label, matches) {
    const names = matches.map((m) => conToken(m) || `idx ${m.idx}`).join(', ');
    super(
      `"${label}" matches ${matches.length} online players (${names}). ` +
      `Refusing to guess — pick the exact player from the online list so the ` +
      `command goes to the right account.`
    );
    this.name = 'AmbiguousPlayerError';
    this.matches = matches;
  }
}

class PlayerNotOnlineError extends Error {
  constructor(label) {
    super(`${label || 'That player'} is not online — this runs live in their session.`);
    this.name = 'PlayerNotOnlineError';
  }
}

// Resolve a target to EXACTLY ONE online player row.
//
// Refuses ambiguity instead of taking a first match: duplicate character names
// do occur on live servers (`slave` exists twice on Perdition), and a silent
// `.find()` would target a stranger.
//
// Match order is most-specific-first. The User ID is deliberately NOT a match
// key — it is not reliably unique per character (see the header note).
function findUniqueOnline(online, target) {
  const rows = Array.isArray(online) ? online : [];
  const label = (target && (target.charName || target.playerName)) || 'player';

  // 1. Exact account token — already unique by construction.
  const wantToken = norm(target && target.playerName);
  if (wantToken) {
    const hit = rows.filter((p) => norm(p.playerName) === wantToken);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) throw new AmbiguousPlayerError(target.playerName, hit);
  }

  // 2. Character name — may legitimately collide, so ambiguity is fatal.
  const wantChar = norm(target && target.charName);
  if (wantChar) {
    const hit = rows.filter((p) => norm(p.charName) === wantChar);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) throw new AmbiguousPlayerError(target.charName, hit);
  }

  // 3. idx — last resort, and only if the row still agrees on who it is.
  if (target && target.idx != null && !Number.isNaN(Number(target.idx))) {
    const hit = rows.find((p) => p.idx === Number(target.idx));
    if (hit) {
      const sameChar = !wantChar || norm(hit.charName) === wantChar;
      if (sameChar) return hit;
      // The index moved to somebody else between refreshes — refuse it.
      throw new PlayerNotOnlineError(label);
    }
  }

  throw new PlayerNotOnlineError(label);
}

module.exports = {
  conToken,
  tokenRejectReason,
  conQuote,
  nameArg,
  isFullToken,
  findUniqueOnline,
  AmbiguousPlayerError,
  PlayerNotOnlineError,
};
