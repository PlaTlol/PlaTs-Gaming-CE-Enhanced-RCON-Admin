# Changelog

All notable changes to PlaT's Gaming — CE Enhanced RCON Admin are documented here.
This file mirrors the in-app **What's New** notes (the `CHANGELOG` array in
`app/renderer/app.js`) — keep the two in sync when cutting a release.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project follows [Semantic Versioning](https://semver.org/).

## [1.5.0] — July 2026

### Changed
- **Live commands now target the account token `name#number`** (the *Player name*
  column of `listplayers`) instead of the player index. The index shifts on any
  join or leave, so a command issued against a stale selection could land on a
  different player. Affects **Kill**, **Freeze/Unfreeze**, **Teleport to Player**,
  **Summon**, **Send Home** and **Set Level**.
- Every live action **re-reads `listplayers` at the moment you click** and
  resolves the target against that fresh roster.
- Actions now **report which account the command was sent to**, because Conan
  replies "Successfully executed" even when the wrong player moved or nobody did.
- **Send Home** sends integer coordinates — `TeleportPlayer` rejects fractional ones.
- The live map **no longer refreshes on a timer**. It has a **↻ refresh button**
  in its header (also in the popped-out window) and shows when it last updated.

### Removed
- The **Clear All Cooldowns**, **View Feats** and **View Quest Flags** buttons.

### Fixed
- **Send Home now actually works.** It matched beds on `buildings.owner_id`
  against the character id, but that column holds the **clan id** whenever the
  builder is in a clan — so it found a home for hardly anyone (12 of 450
  characters on a live server, because 220 of 235 beds are clan-owned). It now
  finds the bedroll the player **placed themselves**, decoded from the placeable's
  `PlacingPlayerUniqueID` property, and falls back to a bed owned by them or
  their clan — 154 of 450 on the same data.
- **Send Home prefers an actual bedroll** over a bed, and their own over their
  clan's, instead of picking an arbitrary one.
- **Send Home no longer teleports across regions.** `TeleportPlayer` can't move a
  player between the Exiled Lands and the Isle of Siptah; if their only bed is on
  the other side it now says so rather than silently failing.
- Send Home lands you **just above** the bed rather than inside it.
- Actions **refuse to run when two online players share a character name**
  instead of silently picking the first match, which could target a stranger.
- The **map right-click menu** no longer resolves a dot through the *User ID*
  column, which is not reliably one-to-one with a character and could open the
  menu for the wrong player.
- Selecting a **building owner** from the Building Report no longer makes that
  owner look like an online player to the live-action checks.

## [1.4.1] — June 2026

### Added
- Right-click a player on the live map for the same actions as the player list:
  **Set as Target, Kick, Kill, Teleport to, Summon, View Inventory**.
- Copy a player's **coordinates, SteamID, or User ID** straight from the map.
- A **"What's New"** patch-notes window that appears once after each update.
- A **✕ clear button** (and **Esc** shortcut) on the online-players filter.
- **Zoom & pan the map** — scroll to zoom toward the cursor, drag to pan — on the
  building heatmap and the live player map (including the pop-out window).

### Changed
- The right-click menu now shows the **player's name at the top**, so overlapping
  dots on the map are easy to tell apart.
- **More accurate live map & heatmap** — recalibrated alignment (per-axis X/Y
  scaling) so player and building positions match the in-game map.
- The live map now **refreshes every 30 seconds** (was once a minute).

### Fixed
- Map right-click actions now work in the **popped-out map window** too (they were
  hidden by the popout's UI-stripping styles).

## [1.4.0] — June 2026

### Added
- **Pop out the live map** into its own resizable window.

### Changed
- Live map resize toggles **Normal / Large** (was S/M/L); Large stays within the
  output column so it never covers the action buttons.
- Denser, responsive **action grid** so all actions fit without scrolling.

### Removed
- The **Dashboard** button.
