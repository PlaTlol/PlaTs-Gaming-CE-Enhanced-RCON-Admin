# PlaT's Gaming — CE Enhanced RCON Admin

A shareable desktop control panel for **Conan Exiles** servers, driven entirely
over **RCON** — no server mods required. It reproduces the in-game admin button
panel (kick, kill, teleport, summon, send home, edit/delete character, remove
buildings, view inventory/feats/quest flags, building heatmap, and more) using
the server's RCON `sql`, `con`, and native commands.

Fully **templatable**: anyone can run it, click **+ Add Server**, and plug in
**their own** server IP, RCON password, and in-game character name. You can add
**multiple servers** and tab between them at the top.

## Features

- **Multi-server tabs** — manage as many servers as you like; click a tab to
  switch, double-click (or **Edit**) to change its settings, **+ Add Server** to
  add more.
- **Live player list** per server from `listplayers`, with filter.
- **No credentials in the bundle** — each server's settings (including the RCON
  password) are stored in your per-user data folder, never inside the shared app.

| Section | Button | How it works |
|---|---|---|
| Punishments | **Kick Player** | native `kickplayer` |
| | **Kill Player** | `con <idx> Suicide` (command configurable) |
| Interactions | **Teleport to Player** | reads target coords via `sql`, `con <you> TeleportPlayer x y z` |
| | **Summon Player** | reads your coords, teleports the target to you |
| | **Send Home** | teleports player to a bed/bedroll they own (`sql` lookup) |
| Tools | **Edit Character** | `sql UPDATE characters` (name / level / alive) |
| | **Delete Character** | `sql DELETE` across all related tables (confirmed) |
| | **Remove Buildings** | native `buildingquery destroy <owner>` |
| | **Clear All Cooldowns** | `sql DELETE FROM character_buffs` |
| | **View Feats** | `sql` progression properties (see notes) |
| | **View Building Heatmap** | `sql` join of `buildings`→`actor_position`, rendered to canvas |
| | **View Quest Flags** | `sql` quest properties |
| | **View Inventory** | `sql` of `item_inventory` grouped by inventory type |

## How the data is reached

Conan's RconPlugin exposes a **closed command set**, but two of those commands
cover almost everything an admin panel needs:

- **`sql <query>`** runs directly against the live `game.db` and **returns the
  result rows over RCON**. This backs every data view and DB edit.
- **`con <idx> <consolecommand>`** runs a console command in an online player's
  context. This backs teleport / summon / kill.

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
- **`con` player id** is the **index** from `listplayers` (handled automatically).
- **View Feats / Quest Flags**: vanilla stores recipes and quest sets as binary
  blobs, so these show the relevant progression/quest properties and their sizes.
- **View Inventory** shows item `template_id`s (mapping IDs to names needs an
  external item table not present in `game.db`).
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
