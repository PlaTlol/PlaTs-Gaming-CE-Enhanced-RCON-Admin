'use strict';

// Conan's RCON `sql` command prints results as a fixed-width-ish table:
//   "   id |  char_name |  level |\n#0 360 |   Akivasha |     13 |\n#1 ..."
// The header row has NO "#n" prefix; each data row is prefixed with "#<rownum>".
// Cells are separated by " | " and each row ends with " |". NULL prints as
// "void" and BLOB columns print as "BLOB".
//
// parseSqlTable() turns that into { columns: [...], rows: [ {col: val}, ... ] }.

function splitCells(line) {
  // strip trailing " |" then split on "|"
  let s = line.replace(/\s*\|\s*$/, '');
  // Some single-column outputs may not end with a pipe; handle gracefully.
  return s.split('|').map((c) => c.trim());
}

function parseSqlTable(text) {
  if (text == null) return { columns: [], rows: [], raw: '' };
  const raw = String(text).replace(/\r/g, '');
  const trimmed = raw.trim();
  if (!trimmed) return { columns: [], rows: [], raw };

  // Error / non-table replies (e.g. "near \"x\": syntax error", "Successfully executed")
  if (!/\|/.test(trimmed)) {
    return { columns: [], rows: [], raw, message: trimmed };
  }

  const lines = trimmed.split('\n').filter((l) => l.trim().length);
  if (!lines.length) return { columns: [], rows: [], raw };

  // First line = header (no leading "#")
  const headerLine = lines[0];
  const columns = splitCells(headerLine);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    let line = lines[i];
    // strip the "#<n>" row-number prefix
    const m = line.match(/^#\d+\s?/);
    if (m) line = line.slice(m[0].length);
    const cells = splitCells(line);
    const row = {};
    for (let c = 0; c < columns.length; c++) {
      let v = cells[c] !== undefined ? cells[c] : '';
      row[columns[c]] = v;
    }
    rows.push(row);
  }
  return { columns, rows, raw };
}

// Parse `listplayers` output into structured objects.
// Header: "Idx | Char name | Player name | User ID | Platform ID | Platform Name"
function parseListPlayers(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r/g, '').split('\n').filter((l) => l.includes('|'));
  if (!lines.length) return [];
  // find header line (contains "Char name")
  let startIdx = 0;
  if (/char\s*name/i.test(lines[0])) startIdx = 1;
  const players = [];
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split('|').map((p) => p.trim());
    if (parts.length < 5) continue;
    const idx = parseInt(parts[0], 10);
    if (Number.isNaN(idx)) continue;
    players.push({
      idx,
      charName: parts[1] || '',
      playerName: parts[2] || '',
      userId: parts[3] || '',
      platformId: parts[4] || '',
      platform: parts[5] || '',
    });
  }
  return players;
}

// Escape a string for safe embedding inside a single-quoted SQL literal.
function sqlEscape(v) {
  return String(v).replace(/'/g, "''");
}

module.exports = { parseSqlTable, parseListPlayers, sqlEscape };
