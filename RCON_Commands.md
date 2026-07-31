# Conan Exiles — RCON Command Reference

Verified live against a production Conan Exiles server's RCON on 2026-06-02.
Conan's RconPlugin has a **closed command set** — only the commands below work. Raw console
variables do **not** work directly; use `exec` for those (see notes).

---

## Player management
| Command | Usage | Notes |
|---|---|---|
| `listplayers` | `listplayers` | List online players: index, char name, player name, User ID, Platform ID. |
| `KickPlayer` | `kickplayer (index\|name\|userid\|platformid\|player) <id> <message>` | Kick with a message. |
| `BanPlayer` | `banplayer (index\|name\|userid\|platformid\|player) <id> <message>` | Ban with a message. |
| `UnbanPlayer` | `unbanplayer <userid\|platformid>` | Remove a ban. |
| `listbans` | `listbans` | List current bans. |
| `WhitelistPlayer` | `whitelistplayer <userid\|platformid>` | Add to whitelist. |
| `UnWhitelistPlayer` | `unwhitelistplayer <userid\|platformid>` | Remove from whitelist. |

## Server control & messaging
| Command | Usage | Notes |
|---|---|---|
| `broadcast` | `broadcast <message>` | Sends a **centered popup** server message to all players (NOT a chat line). |
| `Shutdown` | `shutdown` | Shut the server down. |
| `restart` | `restart` | Restart the server. |
| `GetServerSetting` | `GetServerSetting <Setting Name>` | Read a ServerSettings.ini value live. |
| `SetServerSetting` | `SetServerSetting <Setting Name> <Value>` | Change a ServerSettings value live. |

## Building / world
| Command | Usage | Notes |
|---|---|---|
| `buildingquery` | `buildingquery (list\|destroy) <owner id> <filters>` | Query/destroy buildings by owner. |
| `BuildingDestroy` | `buildingdestroy <building ids>` | Destroy specific building(s). |
| `BuildingContribution` | `buildingcontribution <building id>` | Show contribution info for a building. |
| `GetLandOwner` | `getlandowner <x> <y>` | Who owns the land at coordinates. |
| `validateallbuildings` | `validateallbuildings` | Validate all building instances. |

## Diagnostics / advanced
| Command | Usage | Notes |
|---|---|---|
| `exec` | `exec <args>` | Runs a **console command / CVar** server-side. ⚠️ Output goes to **`ConanSandbox.log`, not the RCON reply** (RCON just returns "Successfully executed"). Use `exec dw.X` to read a CVar's value, `exec dw.X <value>` to set it. |
| `con` | `con <name#number> <command> <args>` | Run a console command in the context of an online player. **`<id>` must be the account token `name#number`** — see [Targeting a player with `con`](#targeting-a-player-with-con). |
| `dumpticks` | `dumpticks` | Dumps tick timing info (to log). |
| `memreport` | `memreport` | Memory report (to log). |
| `memreportsilentevent` | `memreportsilentevent (key)` | Memory report tied to a key. |
| `netprofile` | `netprofile (enable\|disable)` | Toggle network profiling (adds overhead). |
| `sql` | `sql <query>` | ⚠️ **Direct query against the game database.** Powerful and dangerous — can read/modify live world data. Back up `game.db` before write queries. |
| `Help` | `help "optional filter"` | List commands (optionally filtered). |

---

## Targeting a player with `con`

Everything player-facing must be wrapped in `con <id> <command> <args>`. `exec`
reports success and is a **no-op** for these.

**`<id>` must be the account token `name#number`** — the **Player name** column of
`listplayers` (e.g. `PlaT#49895`).

| Identifier | Use it? | Why |
|---|---|---|
| **`name#number`** (Player name column) | ✅ **always** | The only identifier `con` resolves correctly. |
| **User ID** (`A-8CPC756VE`) | 🛑 **never** | Despite the name it is *not* a Funcom account id. `con` can't resolve it and it **moves a different player** — two distinct User IDs have been seen resolving to one character object, which is what caused an arena teleport to move two uninvolved players. |
| **Platform / Steam ID** | 🛑 **never** | All digits, so the server **re-parses it as an `idx`** and hits whoever holds that index. |
| **`idx`** | ⚠️ fallback only | Shifts on **any** join or leave — stale the moment the roster changes. |

**The account name need not resemble the character name.** An order for character
`Cummere` correctly sends `con Spacey#74755 …` — same person. Always join through
`listplayers` before issuing a command; assuming the character name is the token
misroutes silently.

**Refuse ambiguous names.** Duplicate character names do occur on live servers
(`slave` exists twice on Perdition). A first-match `.find()` silently targets a
stranger — resolve to exactly one row or refuse.

### Commands verified through `con`

**Work:** `SpawnItem` (chunk at ~1000), `TeleportPlayer x y z` (**integers only**),
`datacmd spawn <class> thrall`, `LearnFeat`, `LearnSpell`, `setlevel`,
`JourneyUnlockAll` → `JourneyCompleteAll` (**in that order**), `suicide`.

**Don't:** `SpawnNPC` isn't a command on this server at all. `LearnRecipe` is
recognised but broken.

### Traps that fire destructively

- **Bare `TeleportPlayer` with no arguments moves the player.** Never use it to
  probe whether a command is reachable.
- **`JourneyCompleteAll` grants XP** and can level someone unintentionally.
- **Never loop a per-item progression command.** 51 looped `JourneyComplete`s hung
  the live game thread for ~3 minutes. **~20 commands is the practical ceiling.**

### Verifying that it actually worked

`Successfully executed` is emitted **even when the wrong player moved or nobody
did**, and Conan drops roughly half its acks anyway. Verify by **game state**:

- **Items** — check `item_inventory` counts.
- **Teleports** — `ConanSandbox.log` line
  `TeleportPlayerServer: teleporting BasePlayerChar_C_<n>` tells you *who actually
  moved*. That log is the only reason the misrouted-teleport bug was findable.

---

## Operational notes (learned in practice)
- **Connection:** Source RCON protocol over TCP to the server's RCON `host:port` (auth packet type 3, command type 2). Password is in `Game.ini [RconPlugin] RconPassword`.
- **Reading CVar values:** `exec dw.SomeCVar` → the value prints to `ConanSandbox.log` as
  `dw.SomeCVar = "<value>"   LastSetBy: <source>`. RCON itself only replies "Successfully executed".
- **`LastSetBy`** tells you where a value came from: `Constructor` = compiled default, `ProjectSetting`/`SystemSettingsIni` = from an ini, `Console` = set live via RCON/console.
- **Runtime vs persistent:** values set via `exec` are **runtime-only** and revert on restart. To persist, edit `Engine.ini` (note: it's kept read-only — clear the attribute, edit, re-set it).
- **Startup-only CVars** (e.g. `gc.MaxObjectsNotConsideredByGC`) ignore `exec` at runtime — they only take effect from Engine.ini on a restart.
- **`broadcast` is a popup, not chat.** Posting a real chat line requires a mod (the chat send
  functions `ServerSendChatMessage` / `ChatChannel::SendMessage` are not exposed to RCON).
- **No raw console passthrough:** unknown commands return *"Couldn't find the command: X. Try help"* — always go through `exec` for CVars/console commands.
