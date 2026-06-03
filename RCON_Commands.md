# Conan Exiles — RCON Command Reference

Pulled live from the production server (`the server`, RCON `the server IP:25575`) on 2026-06-02.
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
| `con` | `con <id> <command> <args>` | Run a console command in the context of online player `<id>`. |
| `dumpticks` | `dumpticks` | Dumps tick timing info (to log). |
| `memreport` | `memreport` | Memory report (to log). |
| `memreportsilentevent` | `memreportsilentevent (key)` | Memory report tied to a key. |
| `netprofile` | `netprofile (enable\|disable)` | Toggle network profiling (adds overhead). |
| `sql` | `sql <query>` | ⚠️ **Direct query against the game database.** Powerful and dangerous — can read/modify live world data. Back up `game.db` before write queries. |
| `Help` | `help "optional filter"` | List commands (optionally filtered). |

---

## Operational notes (learned in practice)
- **Connection:** Source RCON protocol over TCP to `the server IP:25575` (auth packet type 3, command type 2). Password is in `Game.ini [RconPlugin] RconPassword`.
- **Reading CVar values:** `exec dw.SomeCVar` → the value prints to `ConanSandbox.log` as
  `dw.SomeCVar = "<value>"   LastSetBy: <source>`. RCON itself only replies "Successfully executed".
- **`LastSetBy`** tells you where a value came from: `Constructor` = compiled default, `ProjectSetting`/`SystemSettingsIni` = from an ini, `Console` = set live via RCON/console.
- **Runtime vs persistent:** values set via `exec` are **runtime-only** and revert on restart. To persist, edit `Engine.ini` (note: it's kept read-only — clear the attribute, edit, re-set it).
- **Startup-only CVars** (e.g. `gc.MaxObjectsNotConsideredByGC`) ignore `exec` at runtime — they only take effect from Engine.ini on a restart.
- **`broadcast` is a popup, not chat.** Posting a real chat line requires a mod (the chat send
  functions `ServerSendChatMessage` / `ChatChannel::SendMessage` are not exposed to RCON).
- **No raw console passthrough:** unknown commands return *"Couldn't find the command: X. Try help"* — always go through `exec` for CVars/console commands.
