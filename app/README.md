# PlaT's Gaming — CE Enhanced RCON Admin

A shareable desktop control panel for **Conan Exiles** servers, driven entirely
over **RCON** — no server mods required. It reproduces the in-game admin button
panel (kick, kill, teleport, summon, send home, edit/delete character, remove
buildings, view inventory, building heatmap, and more) using
the server's RCON `sql`, `con`, and native commands.

Fully **templatable**: anyone can run it, click **+ Add Server**, and plug in
**their own** server IP, RCON password, and in-game character name. You can add
**multiple servers** and tab between them at the top.

## Features

- **Multi-server tabs** — manage as many servers as you like; click a tab to
  switch, double-click (or **Edit**) to change its settings, **+ Add Server** to
  add more.
- **Live player list** per server from `listplayers`, with filter.
- **Live player map** — resizable (Normal / Large) inside the output column, or
  pop it out into its own window (`index.html?popout=map`) reusing the same
  map rendering. Refreshes **only when you click ↻** — no background polling.
- **No credentials in the bundle** — each server's settings (including the RCON
  password) are stored in your per-user data folder, never inside the shared app.

| Section | Button | How it works |
|---|---|---|
| Punishments | **Kick Player** | native `kickplayer` |
| | **Kill Player** | `con "<name#number>" Suicide` (command configurable) |
| Interactions | **Teleport to Player** | `con "<you>" TeleportToPlayer <target>` |
| | **Summon Player** | `con "<target>" TeleportToPlayer <you>` |
| | **Send Home** | `sql` read of their **bound spawn point** (`RegionSpawnPoints`), with a bed they placed / own / their clan owns as fallback — pick one, then `con "<them>" TeleportPlayer x y z` |
| Tools | **Edit Character** | `sql UPDATE characters` (name / alive) |
| | **Set Level** | `con "<name#number>" setlevel <n>` — live, player must be online |
| | **Delete Character** | `sql DELETE` across all related tables (confirmed) |
| | **Remove Buildings** | native `buildingquery destroy <owner>` |
| | **View Building Heatmap** | `sql` join of `buildings`→`actor_position`, rendered to canvas |
| | **View Inventory** | `sql` of `item_inventory` grouped by inventory type |

## How the data is reached

Conan's RconPlugin exposes a **closed command set**, but two of those commands
cover almost everything an admin panel needs:

- **`sql <query>`** runs directly against the live `game.db` and **returns the
  result rows over RCON**. This backs every data view and DB edit.
- **`con "<name#number>" <consolecommand>`** runs a console command in an online
  player's context. This backs teleport / summon / kill.

  The `<id>` is the **account token** from the *Player name* column of
  `listplayers` (e.g. `PlaT#49895`) — **not** the player index, **not** the
  "User ID" column, and **not** the Steam/platform id. The index shifts on any
  join or leave; the User ID isn't reliably one-to-one with a character and will
  move a different player; an all-digit id gets re-parsed as an index. It is
  **always sent in double quotes**: account names can contain a space
  (`GsQ Spoz#12345`), `con` splits on whitespace, and quoting an unspaced name
  behaves identically — so there's one code path and no call site can forget.
  Note the account name need not resemble the character name — an action on
  character `Cummere` correctly sends `con "Spacey#74755" …`. See
  [`RCON_Commands.md`](../RCON_Commands.md#targeting-a-player-with-con).

No local access to `game.db` is needed — everything goes over the RCON socket,
so it works against a remote server.

## Setup

```bash
cd app
npm install      # downloads Electron
npm start        # launches the app
```

On first launch you'll see **No servers yet** — click **+ Add your first
server** (or **+ Add Server** at the top right) and enter:

- **Server name** (anything — shown on the tab)
- **Server IP / host** and **RCON port** (default `25575`)
- **RCON password** — from `Game.ini` → `[RconPlugin] RconPassword`
- **Your in-game character name** — needed for Teleport/Summon, which run in
  *your* character's context (you must be online).

Click **Test connection**, then **Save**. Add more servers anytime.

### Build a distributable

```bash
npm run dist           # packaged app folder (no admin rights needed)
npm run dist:installer # NSIS installer (needs Windows Developer Mode for code-signing tools)
```

`npm run dist` writes `dist/PlaT RCON Admin-win32-x64/` containing
`PlaT RCON Admin.exe`. Zip that folder to share it — the exe needs the runtime
files beside it.

## Notes & limitations

- **Teleport / Summon** require *your* admin character to be **online**.
- **`con` player id** is the **account token** `name#number` from `listplayers`,
  sent in double quotes (handled automatically — see above). Names containing a
  `"` are refused: the quote would close the target early and let the rest of
  the name run as a command. All-digit account names are refused too — the
  server re-reads them as a player index.
- **Duplicate character names** are refused rather than guessed: if two online
  players share a character name, pick the right one from the online list.
- **"Successfully executed" is not proof.** Conan emits it even when the wrong
  player moved or nobody did, and drops roughly half its acks. Each action
  reports the account it addressed; verify real changes against game state
  (`item_inventory`, or the `TeleportPlayerServer:` line in `ConanSandbox.log`).
- **View Inventory** shows item `template_id`s (mapping IDs to names needs an
  external item table not present in `game.db`).
- **Send Home uses the player's bound spawn point.** `BasePlayerChar_C.RegionSpawnPoints`
  in `properties` records, per character and per region, the bedroll **and** the
  bed the game respawns them at. That is the only authoritative answer to "where
  is home" — read it with `sql SELECT hex(value) …` (a bare blob column prints as
  the literal `BLOB`; `hex()` returns TEXT and survives RCON). Decoder and
  validation notes are in `src/spawnPoints.js`. When a player has more than one
  option the app asks which to use rather than choosing for you.
- **Ownership is only the fallback**, because it can't tell clanmates apart:
  `buildings.owner_id` holds the **clan id** whenever the builder is in a clan,
  so an entire clan resolves to the same beds. Who *placed* a bed is recoverable
  from `<Class>.PlacingPlayerUniqueID` (its last 8 bytes are the placer's
  `characters.id`, little-endian), which is better but still not the binding.
  Measured live: of 153 characters both methods could answer for, they disagreed
  16 times.
- **A binding can outlive the bed.** The game keeps the reference after a bed
  decays, so every bound id is re-resolved against `actor_position` and dropped
  if it's gone.
- **Send Home cannot cross regions.** `TeleportPlayer x y z` can't move a player
  between the Exiled Lands and the Isle of Siptah, so if their only bed is on the
  other side the action reports that instead of teleporting them nowhere.
- Some buttons present in other admin tools depend on data that only exists with
  a mod loaded (e.g. multi-home points, mod variable systems); those are
  intentionally not included here since there's no server-side equivalent.

## Safety

- Destructive actions (Kill, Delete Character, Remove Buildings) require a native
  confirmation dialog.
- `Delete Character` removes rows from `characters`, `actor_position`,
  `character_stats`, `character_buffs`, `item_inventory`, `item_properties`, and
  `properties`. **Back up `game.db` before using it on a live server.**

MIT licensed. Built for the Conan Exiles community.
