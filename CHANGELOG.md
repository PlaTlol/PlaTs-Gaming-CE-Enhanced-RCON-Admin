# Changelog

All notable changes to PlaT's Gaming — CE Enhanced RCON Admin are documented here.
This file mirrors the in-app **What's New** notes (the `CHANGELOG` array in
`app/renderer/app.js`) — keep the two in sync when cutting a release.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project follows [Semantic Versioning](https://semver.org/).

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
