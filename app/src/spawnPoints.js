'use strict';

// ---------------------------------------------------------------------------
// The player's BOUND respawn points — `BasePlayerChar_C.RegionSpawnPoints`.
//
// Conan records, per character, which bedroll and which bed they are actually
// bound to, keyed by region. That is the game's own answer to "where is home",
// and it is the only thing here that is authoritative: everything else
// (ownership, who placed it) is inference. A clan's members all "own" the same
// beds, so ownership alone cannot tell two clanmates apart — verified live on
// Perdition, where four different players resolve to bedroll #1078258 by
// ownership while their bound spawn points are four distinct bedrolls.
//
// Read it with `sql SELECT hex(value) ...` — hex() returns TEXT, so it comes
// back over RCON intact (a bare blob column prints as the literal "BLOB").
// Largest observed blob is 547 bytes = 1094 hex chars, well under the ~10KB
// reply cap.
//
// Blob layout (UE serialized property). After a fixed header, for each region:
//
//   <RegionName>          e.g. "ExiledLands" / "IsleOfSiptah"
//   "BedRoll" "ObjectProperty" [ "/Script/UE4Dreamworld.UniqueID"
//                                "UniqueID_<n>" <8-byte LE actor id> | "None" ]
//   "Bed"     "ObjectProperty" [ ... same ... ]
//
// Every string is a u32 length followed by that many bytes INCLUDING a trailing
// null. Rather than track the fixed-width filler between fields (which varies),
// we walk the length-prefixed strings and read the 8-byte id that immediately
// follows a `UniqueID_<n>` token. Validated against actor_position on a live
// server: 103/103 BedRoll ids resolved to a Bedroll class, 97/97 Bed ids to a
// non-bedroll Bed class, and 200/200 entries sat in the region they were filed
// under. Zero mismatches.
//
// A bound id may point at a bed that has since decayed — the game keeps the
// binding. Callers MUST resolve each id against actor_position and drop misses.
// ---------------------------------------------------------------------------

const REGIONS = { ExiledLands: 'the Exiled Lands', IsleOfSiptah: 'the Isle of Siptah' };
const KEYS = new Set(['BedRoll', 'Bed']);
const UNIQUE_ID_RE = /^UniqueID_\d+$/;

// Walk the buffer collecting every length-prefixed, null-terminated ASCII
// string, remembering where each one ends (that is where an id would start).
function readStrings(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; ) {
    const len = buf.readUInt32LE(i);
    const end = i + 4 + len;
    if (len >= 2 && len <= 128 && end <= buf.length && buf[end - 1] === 0) {
      const s = buf.toString('latin1', i + 4, end - 1);
      if (/^[\x20-\x7e]*$/.test(s)) { out.push({ s, end }); i = end; continue; }
    }
    i += 1;
  }
  return out;
}

// hex string (as returned by `sql SELECT hex(value)`) ->
//   { ExiledLands: { BedRoll: <actorId|null>, Bed: <actorId|null> }, ... }
// Returns {} for anything unparseable rather than throwing — a player with no
// binding is an ordinary case, not an error.
function decodeRegionSpawnPoints(hex) {
  if (!hex || typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) return {};
  let buf;
  try { buf = Buffer.from(hex, 'hex'); } catch (e) { return {}; }
  const strings = readStrings(buf);
  const regions = {};
  let current = null;
  for (let i = 0; i < strings.length; i++) {
    const name = strings[i].s;
    if (REGIONS[name]) { current = name; regions[current] = regions[current] || {}; continue; }
    if (!current || !KEYS.has(name)) continue;
    // Scan forward for this key's value, stopping at the next key/region so a
    // malformed entry can't steal the following one's id.
    for (let j = i + 1; j < strings.length; j++) {
      const tok = strings[j].s;
      if (REGIONS[tok] || KEYS.has(tok)) break;
      if (tok === 'None') { regions[current][name] = null; break; }
      if (UNIQUE_ID_RE.test(tok)) {
        const at = strings[j].end;
        if (at + 8 <= buf.length) {
          const id = buf.readBigUInt64LE(at);
          regions[current][name] = id > 0n && id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : null;
        } else {
          regions[current][name] = null;
        }
        break;
      }
    }
  }
  return regions;
}

const regionLabel = (key) => REGIONS[key] || key;

// The x coordinate separating the two regions in the merged "Enhanced" world.
const REGION_SPLIT_X = 800000;
const regionOf = (x) => (Number(x) > REGION_SPLIT_X ? 'IsleOfSiptah' : 'ExiledLands');

module.exports = { decodeRegionSpawnPoints, regionLabel, regionOf, REGION_SPLIT_X, REGIONS };
