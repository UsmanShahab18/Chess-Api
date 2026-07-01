// Serverless chess for a GitHub profile README.
//
// A visitor clicks a square -> this endpoint receives ?sq=<square> (or ?reset=1),
// updates the game inside the README's <!--START:chess--> ... <!--END:chess--> block
// via the GitHub Contents API, then 302-redirects back to the profile.
//
// SECURITY / ABUSE-PROOFING:
//   * The GitHub token lives ONLY in the GH_TOKEN env var (server-side). It is never
//     sent to the browser and never appears in the README, so a click cannot leak it.
//   * Use a FINE-GRAINED token scoped to ONLY this one repo, Contents: Read and write.
//     That is the most this endpoint can ever do — edit README.md in one repo.
//   * Every move is validated with chess.js; illegal input is ignored.
//   * A per-game rate limit (MIN_MS) throttles rapid/spam clicks.
//   * GitHub does NOT pre-fetch anchor links (only images, via camo), so crawlers
//     will not auto-trigger moves.

import { Chess } from 'chess.js';

const OWNER_REPO = process.env.GH_REPO || 'UsmanShahab18/UsmanShahab18';
const [OWNER, REPO] = OWNER_REPO.split('/');
const TOKEN = process.env.GH_TOKEN;
const BRANCH = process.env.GH_BRANCH || 'main';
// Redirect back to the chess board's heading anchor so the page lands on the
// board instead of jumping to the top — makes the reload feel like an in-place update.
const REDIRECT_URL = process.env.REDIRECT_URL || `https://github.com/${OWNER}#-play-live-chess-with-me`;
const MIN_MS = parseInt(process.env.MIN_MS || '1200', 10); // min gap between moves

const START = '<!--START:chess-->';
const END = '<!--END:chess-->';
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const GLYPH = {
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
  P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function apiBase(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/move`;
}

async function ghGetReadme() {
  const r = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/README.md?ref=${BRANCH}`,
    { headers: gh() }
  );
  if (!r.ok) throw new Error(`read README ${r.status}`);
  const j = await r.json();
  return { content: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha };
}

async function ghPutReadme(content, sha, message) {
  const r = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/README.md`,
    {
      method: 'PUT',
      headers: { ...gh(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha,
        branch: BRANCH,
      }),
    }
  );
  if (!r.ok) throw new Error(`write README ${r.status} ${await r.text()}`);
}

function gh() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'profile-chess-bot',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Bot (Black): greedy — prefer the most valuable capture / mate, else near-random.
function botMove(game) {
  const moves = game.moves({ verbose: true });
  if (!moves.length) return;
  const val = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    let s = m.captured ? val[m.captured] : 0;
    if (m.san.includes('#')) s += 100;
    if (m.san.includes('+')) s += 0.4;
    s += Math.random() * 0.6;
    if (s > bestScore) { bestScore = s; best = m; }
  }
  game.move(best);
}

function statusText(game) {
  if (game.isCheckmate()) {
    return game.turn() === 'w'
      ? '🏁 **Checkmate — the bot wins.** Click New Game to rematch.'
      : '🏆 **Checkmate — you win!** 🎉 Click New Game to play again.';
  }
  if (game.isStalemate()) return '🤝 **Stalemate — draw.** Click New Game.';
  if (game.isDraw()) return '🤝 **Draw.** Click New Game.';
  if (game.isCheck() && game.turn() === 'w') return '⚠️ **You are in check!** Move your King to safety.';
  return "♟️ **Your move (White).** Click one of your pieces, then its highlighted destination.";
}

function renderBlock(game, selected, base, lastMs) {
  const board = game.board();
  const targets = new Set();
  if (selected) game.moves({ square: selected, verbose: true }).forEach((m) => targets.add(m.to));

  let rows = '';
  for (let r = 0; r < 8; r++) {
    let tds = '';
    for (let f = 0; f < 8; f++) {
      const cell = board[r][f];
      const sq = FILES[f] + (8 - r);
      // Append U+FE0E (text-presentation selector) so GitHub renders classic
      // monochrome chess glyphs (outline = White, solid = Black) instead of
      // colored emoji.
      const piece = cell ? GLYPH[cell.color === 'w' ? cell.type.toUpperCase() : cell.type] + '︎' : '';
      let inner;
      if (sq === selected) {
        inner = `<a href="${base}?sq=${sq}" title="selected — click to deselect">🟨</a>`;
      } else if (targets.has(sq)) {
        inner = cell
          ? `<a href="${base}?sq=${sq}" title="capture here">🟥</a>`
          : `<a href="${base}?sq=${sq}" title="move here">🟩</a>`;
      } else if (cell && cell.color === 'w' && game.turn() === 'w' && !game.isGameOver()) {
        inner = `<a href="${base}?sq=${sq}" title="select ${sq}">${piece}</a>`;
      } else {
        inner = piece || '&nbsp;';
      }
      tds += `<td align="center" width="34" height="34">${inner}</td>`;
    }
    rows += `<tr>${tds}</tr>\n`;
  }
  const table = `<table>\n${rows}</table>`;

  const state = `<!-- chess:${game.fen()}|${selected}|${game.isGameOver() ? 'over' : 'playing'}|${lastMs} -->`;
  return [
    state,
    '<div align="center">',
    '',
    "**♟️ Live Chess — you're White vs my bot (Black). No New Issue page — clicking updates the board in place.**",
    '',
    table,
    '',
    statusText(game),
    '',
    '<sub>🟨 selected &nbsp;·&nbsp; 🟩 can move here &nbsp;·&nbsp; 🟥 capture</sub>',
    '',
    `<a href="${base}?reset=1">🔄 New Game</a>`,
    '',
    '<sub>Board updates a moment after each click — give your profile a refresh if it lags.</sub>',
    '',
    '</div>',
  ].join('\n');
}

export default async function handler(req, res) {
  try {
    if (!TOKEN) { res.status(500).send('Server not configured: missing GH_TOKEN env var.'); return; }

    const base = apiBase(req);
    const url = new URL(req.url, `https://${req.headers.host}`);
    const sq = url.searchParams.get('sq');
    const reset = url.searchParams.get('reset');

    const { content, sha } = await ghGetReadme();
    const secRe = new RegExp(`${escapeRe(START)}([\\s\\S]*?)${escapeRe(END)}`);
    const section = content.match(secRe);
    if (!section) { res.status(500).send('README is missing the <!--START:chess--> ... <!--END:chess--> markers.'); return; }

    let fen = '';
    let selected = '';
    let lastMs = 0;
    const st = section[1].match(/<!--\s*chess:([\s\S]*?)-->/);
    if (st) {
      const parts = st[1].split('|');
      fen = (parts[0] || '').trim();
      selected = (parts[1] || '').trim();
      lastMs = parseInt(parts[3] || '0', 10) || 0;
    }

    const game = new Chess();
    if (fen && fen !== 'startpos') { try { game.load(fen); } catch { game.reset(); } }

    const now = Date.now();
    let changed = false;

    if (reset) {
      game.reset();
      selected = '';
      changed = true;
    } else if (sq && /^[a-h][1-8]$/.test(sq)) {
      if (now - lastMs < MIN_MS) { res.writeHead(302, { Location: REDIRECT_URL }); res.end(); return; }
      if (game.isGameOver()) { game.reset(); selected = ''; }
      const piece = game.get(sq);
      if (selected) {
        if (sq === selected) {
          selected = ''; changed = true; // deselect
        } else {
          const cand = game.moves({ square: selected, verbose: true }).filter((x) => x.to === sq);
          if (cand.length) {
            const mv = cand.find((x) => x.promotion === 'q') || cand[0];
            game.move({ from: selected, to: sq, ...(mv.promotion ? { promotion: 'q' } : {}) });
            selected = '';
            changed = true;
            if (!game.isGameOver()) botMove(game);
          } else if (piece && piece.color === 'w') {
            selected = sq; changed = true; // reselect another own piece
          }
        }
      } else if (piece && piece.color === 'w' && game.turn() === 'w') {
        selected = sq; changed = true;
      }
    }

    if (!changed) { res.writeHead(302, { Location: REDIRECT_URL }); res.end(); return; }

    lastMs = now;
    const block = renderBlock(game, selected, base, lastMs);
    const newContent = content.replace(secRe, `${START}\n${block}\n${END}`);
    await ghPutReadme(newContent, sha, `chess: ${reset ? 'new game' : sq}`);

    res.writeHead(302, { Location: REDIRECT_URL });
    res.end();
  } catch (e) {
    res.status(500).send(`Chess error: ${e.message}`);
  }
}
