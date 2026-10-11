const crypto = require('crypto');
const { FILES } = require('../config');
const { readJson, writeJson, allScoped } = require('./storage');
const { levelFromXp, careerFor } = require('./economy');
const seasons = require('./seasons');
const war = require('./war');
const blacklist = require('./blacklist');
const rankedLib = require('./ranked');
const { DEFS } = require('./modifiers');
const { GOAL: REBELLION_GOAL } = require('./rebellion');
const { PAGES } = require('./helpPages');
const { ENTRIES } = require('./changelog');
const { logging } = require('./logging');

// ---------- Settings you can tweak ----------
const REPO = process.env.WEB_REPO || 'TheFallenStarGG/Overlord-Website';
const BRANCH = process.env.WEB_BRANCH || 'data';
const SALT = process.env.WEB_SALT || 'overlord'; // only scrambles the server links on the website
const TOP = 50; // names on the big boards
const TOP_SMALL = 25; // names on the extra boards
const SERVER_LIST_MAX = 60; // servers shown on the Servers page
const SERVER_DETAIL_ROWS = 8; // richest players shown on each server's card
const SERVER_TOP_PLAYERS = 5; // a server's score = its richest players added up
const SERVER_MIN_PLAYERS = 3; // players with MIN_COINS a server needs to be ranked
const SERVER_MIN_COINS = 100;
const RANKED_MIN_GAMES = 3; // ranked games needed to appear on a ladder
const DAY_MS = 24 * 60 * 60 * 1000;

// Commands that never appear on the website (owner-only commands are skipped automatically)
const HIDE_COMMANDS = new Set(['!!r', '!!e621', '!!rule34', '!!allow-18']);
const ADMIN_COMMANDS = ['!!settings', '!!events-channel', '!!levelchannel', '!!edittitles', '!!reactionroles', '!!deletedata'];

// ---------- People who hid themselves from the website ----------
const hidden = readJson(FILES.webhide, {});
const saveHidden = () => writeJson(FILES.webhide, hidden);
saveHidden();

const isHidden = (id) => Boolean(hidden[id]);
function setHidden(id, on) {
  if (on) hidden[id] = 1;
  else delete hidden[id];
  saveHidden();
}

// ---------- Past seasons (kept privately by user ID, names are looked up when publishing) ----------
const history = readJson(FILES.webhistory, {});
history.seasons ??= {};
const saveHistory = () => writeJson(FILES.webhistory, history);
saveHistory();

// ---------- Helpers ----------

const nameCache = new Map(); // id -> { name, until }
async function nameOf(client, id) {
  const hit = nameCache.get(id);
  if (hit && Date.now() < hit.until) return hit.name;
  const user = client.users.cache.get(id) ?? (await client.users.fetch(id).catch(() => null));
  const name = !user || user.bot ? null : String(user.globalName || user.username).slice(0, 40);
  nameCache.set(id, { name, until: Date.now() + (name ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000) });
  return name;
}

// Turns a sorted [{ id, ... }] list into named rows (skips bots and accounts that no longer exist)
async function nameRows(client, list, make, limit = TOP) {
  const rows = [];
  for (const entry of list) {
    if (rows.length >= limit) break;
    const name = await nameOf(client, entry.id);
    if (name) rows.push(make(entry, name));
  }
  return rows;
}

const sorted = (map) =>
  [...map]
    .map(([id, value]) => ({ id, value }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

// Servers get a scrambled link name so their real IDs are never published
const slugOf = (guildId) => crypto.createHash('sha256').update(SALT + guildId).digest('hex').slice(0, 10);
const iconOf = (guild) => guild.iconURL({ extension: 'png', size: 64 });
const iso = (ms) => new Date(ms).toISOString();

// A daily streak only counts while it is still alive
function streakOf(u) {
  const yesterday = iso(Date.now() - DAY_MS).slice(0, 10);
  return u.lastDaily && u.lastDaily >= yesterday ? u.streak ?? 0 : 0;
}

function stockValue(stock, id) {
  let value = 0;
  for (const [sym, pos] of Object.entries(stock?.users?.[id] ?? {})) {
    const price = stock.prices?.[sym];
    if (price && pos.shares > 0) value += pos.shares * price;
  }
  return Math.floor(value);
}

// Reads every server's saved data once, so all the pages are built from the same moment
function snapshot(client) {
  const by = (base) => new Map(allScoped(base).map((e) => [e.guildId, e.data]));
  const wld = by('world');
  const eco = by('economy');
  // Every server the bot is in, unless its admins ran "!!settings website off"
  const guilds = [...client.guilds.cache.values()].filter(
    (guild) => wld.get(guild.id)?.settings?.website !== false && !blacklist.isGuildBlocked(guild.id)
  );
  const rows = guilds.map((guild) => {
    const users = Object.entries(eco.get(guild.id) ?? {}).filter(
      ([id, u]) => u && typeof u === 'object' && !blacklist.isUserBlocked(id)
    );
    const rich = users.map(([, u]) => u.coins ?? 0).filter((c) => c >= SERVER_MIN_COINS).sort((a, b) => b - a);
    return { guild, users, players: rich.length, score: rich.slice(0, SERVER_TOP_PLAYERS).reduce((a, b) => a + b, 0) };
  });
  return { guilds, rows, wld, sea: by('seasons'), stk: by('stocks'), rk: by('ranked'), mod: by('modifiers') };
}

// ---------- Leaderboards ----------

// When a new month starts, remember how last month's season ended
function prevSeasonKey(key) {
  const [y, m] = key.split('-').map(Number);
  return iso(Date.UTC(y, m - 2, 1)).slice(0, 7);
}

function snapshotLastSeason(ctx) {
  const prev = prevSeasonKey(seasons.seasonKey());
  if (seasons.seasonNumber(prev) < 1 || history.seasons[prev]) return;
  const totals = new Map();
  for (const guild of ctx.guilds) {
    for (const e of seasons.board(ctx.sea.get(guild.id) ?? {}, 's', 'sk', prev)) totals.set(e.id, (totals.get(e.id) ?? 0) + e.value);
  }
  const top = sorted(totals).slice(0, 25).map((e) => ({ id: e.id, score: e.value }));
  if (!top.length) return;
  history.seasons[prev] = top;
  saveHistory();
}

async function buildLeaderboards(client, ctx) {
  snapshotLastSeason(ctx);
  const key = seasons.seasonKey();
  const players = new Set();
  let coinTotal = 0;

  const maps = Object.fromEntries(
    ['coins', 'xp', 'worth', 'prestige', 'streak', 'jobs', 'duelWins', 'bestStreak', 'bossKills', 'bossDamage', 'season'].map((k) => [k, new Map()])
  );
  const ladders = { duel: new Map(), c4: new Map(), bs: new Map() };
  const sum = (map, id, n) => map.set(id, (map.get(id) ?? 0) + n);
  const best = (map, id, n) => map.set(id, Math.max(map.get(id) ?? 0, n));

  for (const { guild, users } of ctx.rows) {
    const stock = ctx.stk.get(guild.id);
    for (const [id, u] of users) {
      players.add(id);
      coinTotal += u.coins ?? 0;
      if (isHidden(id)) continue;
      const c = u.combat ?? {};
      sum(maps.coins, id, u.coins ?? 0);
      sum(maps.xp, id, u.xp ?? 0);
      sum(maps.worth, id, (u.coins ?? 0) + stockValue(stock, id));
      best(maps.prestige, id, u.prestige ?? 0);
      best(maps.streak, id, streakOf(u));
      sum(maps.jobs, id, u.works ?? 0);
      sum(maps.duelWins, id, c.wins ?? 0);
      best(maps.bestStreak, id, c.best ?? 0);
      sum(maps.bossKills, id, c.bossKills ?? 0);
      sum(maps.bossDamage, id, c.bossDamage ?? 0);
    }

    for (const e of seasons.board(ctx.sea.get(guild.id) ?? {}, 's', 'sk', key)) {
      if (isHidden(e.id) || blacklist.isUserBlocked(e.id)) continue;
      sum(maps.season, e.id, e.value);
    }

    const games = ctx.rk.get(guild.id)?.games ?? {};
    for (const game of Object.keys(ladders)) {
      for (const [id, r] of Object.entries(games[game] ?? {})) {
        if (isHidden(id) || blacklist.isUserBlocked(id) || !r || r.wins + r.losses < RANKED_MIN_GAMES) continue;
        const have = ladders[game].get(id);
        if (!have || r.elo > have.elo) ladders[game].set(id, { elo: r.elo, wins: r.wins, losses: r.losses });
      }
    }
  }

  const board = async (id, group, emoji, title, blurb, suffix, limit, make = (e, name) => ({ name, value: e.value })) => ({
    id,
    group,
    emoji,
    title,
    blurb,
    suffix,
    rows: await nameRows(client, sorted(maps[id]), make, limit),
  });

  const boards = [
    await board('coins', 'players', '💰', 'Richest', 'Coins added up across every listed server.', ' 🪙', TOP),
    await board('worth', 'players', '💎', 'Net worth', 'Coins plus the value of stock holdings.', ' 🪙', TOP_SMALL),
    await board('xp', 'players', '📈', 'Top chatters', 'XP earned by chatting.', ' XP', TOP, (e, name) => ({
      name,
      value: e.value,
      level: levelFromXp(e.value),
      sub: 'Level ' + levelFromXp(e.value),
    })),
    await board('prestige', 'players', '🌟', 'Prestige', 'The highest prestige level in any server.', ' ★', TOP_SMALL),
    await board('streak', 'players', '🔥', 'Daily streaks', 'Current `!!daily` streaks that are still alive.', ' days', TOP_SMALL),
    await board('jobs', 'players', '💼', 'Hardest workers', 'Total times `!!work` was used.', ' jobs', TOP_SMALL, (e, name) => {
      const career = careerFor(e.value);
      return { name, value: e.value, sub: `${career.emoji} ${career.name}` };
    }),
    await board('duelWins', 'combat', '⚔️', 'Duel wins', 'Duels won across every listed server.', ' wins', TOP_SMALL),
    await board('bestStreak', 'combat', '🏅', 'Win streaks', 'The longest duel win streak ever reached.', ' in a row', TOP_SMALL),
    await board('bossKills', 'combat', '🐉', 'Boss slayers', 'Bosses defeated.', ' kills', TOP_SMALL),
    await board('bossDamage', 'combat', '💥', 'Boss damage', 'Total damage dealt to bosses.', ' dmg', TOP_SMALL),
  ];

  for (const [game, [emoji, label]] of Object.entries(rankedLib.GAMES)) {
    const list = [...ladders[game]].map(([id, r]) => ({ id, ...r })).sort((a, b) => b.elo - a.elo);
    boards.push({
      id: 'ranked-' + game,
      group: 'ranked',
      emoji,
      title: label,
      blurb: `Best rating in any server (at least ${RANKED_MIN_GAMES} ranked games this month).`,
      suffix: ' rating',
      rows: await nameRows(
        client,
        list,
        (e, name) => {
          const t = rankedLib.tierOf(e.elo);
          return { name, value: e.elo, sub: `${t.emoji} ${t.name} · ${e.wins}W-${e.losses}L` };
        },
        TOP_SMALL
      ),
    });
  }

  const hallOfFame = [];
  for (const k of Object.keys(history.seasons).sort().reverse().slice(0, 6)) {
    const list = history.seasons[k]
      .filter((e) => !isHidden(e.id) && !blacklist.isUserBlocked(e.id))
      .map((e) => ({ id: e.id, value: e.score }));
    const rows = await nameRows(client, list, (e, name) => ({ name, score: e.value }), 10);
    if (rows.length) hallOfFame.push({ number: seasons.seasonNumber(k), key: k, players: rows });
  }

  const seasonRows = await nameRows(client, sorted(maps.season), (e, name) => ({ name, score: e.value }));
  const servers = ctx.rows
    .filter((r) => r.players >= SERVER_MIN_PLAYERS)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP)
    .map((r) => ({
      slug: slugOf(r.guild.id),
      name: r.guild.name.slice(0, 60),
      icon: iconOf(r.guild),
      score: r.score,
      players: r.players,
      members: r.guild.memberCount,
    }));

  return {
    generatedAt: new Date().toISOString(),
    serversListed: ctx.rows.length,
    totals: { servers: ctx.rows.length, players: players.size, coins: coinTotal },
    season: { number: seasons.seasonNumber(key), endsAt: iso(seasons.seasonEnd(key)), players: seasonRows },
    hallOfFame,
    servers,
    boards,
    // kept so the older leaderboards page keeps working
    players: { coins: boards[0].rows, xp: boards[2].rows },
  };
}

// ---------- Servers page ----------

async function buildServers(client, ctx) {
  const key = seasons.seasonKey();
  const now = Date.now();
  const picked = [...ctx.rows]
    .sort((a, b) => b.score - a.score || b.guild.memberCount - a.guild.memberCount)
    .slice(0, SERVER_LIST_MAX);
  const out = [];

  for (const { guild, users, players, score } of picked) {
    const richest = await nameRows(
      client,
      users
        .filter(([id]) => !isHidden(id))
        .map(([id, u]) => ({ id, value: u.coins ?? 0, xp: u.xp ?? 0 }))
        .filter((e) => e.value > 0)
        .sort((a, b) => b.value - a.value),
      (e, name) => ({ name, coins: e.value, level: levelFromXp(e.xp) }),
      SERVER_DETAIL_ROWS
    );

    const seasonList = seasons
      .board(ctx.sea.get(guild.id) ?? {}, 's', 'sk', key)
      .filter((e) => !isHidden(e.id) && !blacklist.isUserBlocked(e.id));
    const seasonTop = await nameRows(client, seasonList, (e, name) => ({ name, score: e.value }), 5);

    const progress = war.guildProgress(guild.id, war.state.week);
    const rebellion = ctx.wld.get(guild.id)?.rebellion ?? {};
    const king = rebellion.usurper;
    const ruler =
      king && king.until > now && !isHidden(king.id) && !blacklist.isUserBlocked(king.id) ? await nameOf(client, king.id) : null;
    const active = Object.entries(ctx.mod.get(guild.id)?.active ?? {})
      .filter(([id, a]) => a.until > now && DEFS[id])
      .map(([id, a]) => ({ name: DEFS[id].name, emoji: DEFS[id].emoji, kind: DEFS[id].decree ? 'Decree' : 'Event', until: iso(a.until) }));

    out.push({
      slug: slugOf(guild.id),
      name: guild.name.slice(0, 60),
      icon: iconOf(guild),
      members: guild.memberCount,
      players,
      score,
      ranked: players >= SERVER_MIN_PLAYERS,
      richest,
      season: { score: seasonList.slice(0, SERVER_TOP_PLAYERS).reduce((sum, e) => sum + e.value, 0), top: seasonTop },
      war: { wins: war.state.wins[guild.id] ?? 0, score: progress.score, players: progress.players },
      realm: { ruler, meter: rebellion.meter ?? 0, goal: REBELLION_GOAL, raid: Boolean(rebellion.raid), active },
    });
  }

  return { generatedAt: new Date().toISOString(), listed: ctx.rows.length, servers: out };
}

// ---------- Server Wars page ----------

function buildWars(client, ctx) {
  const listed = new Map(ctx.guilds.map((g) => [g.id, g]));
  const card = (guildId, extra) => {
    const g = listed.get(guildId);
    return g ? { slug: slugOf(g.id), name: g.name.slice(0, 60), icon: iconOf(g), ...extra } : null;
  };
  const key = war.state.week;

  return {
    generatedAt: new Date().toISOString(),
    week: { key, endsAt: iso(seasons.weekEnd(key)) },
    rules: { minPlayers: war.MIN_CONTRIBUTORS, minProfit: war.MIN_PROFIT, topPlayers: war.TOP_N, prizes: war.PRIZES },
    standings: war
      .standingsFor(client, key)
      .map((s) => card(s.guildId, { score: s.score, players: s.players }))
      .filter(Boolean)
      .slice(0, TOP),
    history: war.state.history
      .map((h) => ({ week: h.week, top: h.top.map((t) => card(t.guildId, { score: t.score })).filter(Boolean) }))
      .filter((h) => h.top.length),
    champions: Object.entries(war.state.wins)
      .map(([id, wins]) => card(id, { wins }))
      .filter(Boolean)
      .sort((a, b) => b.wins - a.wins)
      .slice(0, 10),
  };
}

// ---------- Commands page ----------

function buildCommands(commands) {
  if (!commands) return null;
  const visible = new Map(
    [...commands.values()].filter((c) => c.access === 'free' && !c.hidden && !HIDE_COMMANDS.has(c.name)).map((c) => [c.name, c])
  );
  const used = new Set();
  const take = (names) =>
    names
      .filter((n) => visible.has(n) && !used.has(n))
      .map((n) => {
        used.add(n);
        const c = visible.get(n);
        return { name: c.name, usage: c.usage ?? c.name, description: c.description ?? '', aliases: c.aliases ?? [] };
      });

  const categories = [];
  for (const page of PAGES) {
    if (page.key === 'owner') continue;
    const list = take(page.names.filter((n) => !ADMIN_COMMANDS.includes(n)));
    if (list.length) categories.push({ key: page.key, emoji: page.emoji, title: page.title, intro: page.intro, commands: list });
  }
  const admin = take(ADMIN_COMMANDS);
  if (admin.length) categories.push({ key: 'admin', emoji: '🛠️', title: 'Server admin', intro: 'Setup and control commands for server admins.', commands: admin });
  const more = take([...visible.keys()].sort());
  if (more.length) categories.push({ key: 'more', emoji: '✨', title: 'More', intro: 'Everything else.', commands: more });

  return { total: used.size, categories };
}

// ---------- Changelog ----------

function buildChangelog() {
  return {
    updates: ENTRIES.map((e) => ({
      emoji: e.emoji,
      title: e.title,
      date: e.date,
      summary: e.summary,
      color: '#' + (e.color ?? 0x5865f2).toString(16).padStart(6, '0'),
      sections: e.sections.map((s) => ({ heading: s.heading, items: s.items })),
    })),
  };
}

// ---------- Status page ----------

function buildStatus(client) {
  const state = readJson(FILES.webstatus, {});
  const now = Date.now();
  const since = state.since ?? now;
  const weekAgo = now - 7 * DAY_MS;
  const incidents = (state.incidents ?? []).filter((i) => i.end > weekAgo).sort((a, b) => b.start - a.start);
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = todayStart - i * DAY_MS;
    const from = Math.max(dayStart, since);
    const to = Math.min(dayStart + DAY_MS, now);
    const date = iso(dayStart).slice(0, 10);
    if (to <= from) {
      days.push({ date, uptime: null, downMinutes: 0 }); // not tracked yet
      continue;
    }
    let down = 0;
    for (const inc of incidents) down += Math.max(0, Math.min(inc.end, to) - Math.max(inc.start, from));
    days.push({ date, uptime: Math.round((1 - down / (to - from)) * 10000) / 100, downMinutes: Math.round(down / 60000) });
  }

  return {
    checkedAt: iso(now),
    startedAt: iso(now - process.uptime() * 1000),
    trackingSince: iso(since),
    pingMs: Math.max(0, Math.round(client.ws.ping)),
    servers: client.guilds.cache.size,
    days,
    incidents: incidents.map((i) => ({
      kind: i.kind,
      start: iso(i.start),
      end: iso(i.end),
      minutes: Math.max(1, Math.round((i.end - i.start) / 60000)),
    })),
  };
}

// ---------- Home page news ticker (cross-server, last 24h, max 30) ----------
const NEWS_MAX = 30;
const NEWS_MAX_AGE_MS = DAY_MS; // 24 hours

function plainNews(text) {
  return String(text || '')
    .replace(/<@!?\d+>/g, 'someone')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function buildNews(client, ctx) {
  const now = Date.now();
  const cutoff = now - NEWS_MAX_AGE_MS;
  const items = [];

  for (const { guild } of ctx.rows) {
    const server = String(guild.name || 'Server').slice(0, 40);

    // Major stock headlines from this server's market
    const market = ctx.stk.get(guild.id);
    for (const n of market?.news ?? []) {
      const at = typeof n.at === 'number' ? n.at : Date.parse(n.at);
      if (!Number.isFinite(at) || at < cutoff) continue;
      // majors always; other lines only if the move was big
      if (!n.major && !(typeof n.pct === 'number' && Math.abs(n.pct) >= 0.08)) continue;
      const kind =
        n.kind === 'crash' || n.kind === 'buyout' || n.kind === 'ipo'
          ? n.kind
          : n.major
            ? 'market'
            : 'market';
      items.push({
        at,
        server,
        kind,
        text: plainNews(n.line || n.text),
      });
    }

    // Short chronicle lines that look like public events
    const log = ctx.wld.get(guild.id)?.chronicle?.log ?? [];
    for (const e of log) {
      const at = typeof e.at === 'number' ? e.at : Date.parse(e.at);
      if (!Number.isFinite(at) || at < cutoff) continue;
      const text = plainNews(e.text);
      if (!text) continue;
      if (
        !/(bankrupt|acquired|went public|bounty|decree|rebellion|usurper|delisted|collapsed|Gazette)/i.test(
          text
        )
      ) {
        continue;
      }
      items.push({ at, server, kind: 'chronicle', text });
    }
  }

  // Global war blurb (not tied to one opt-in server)
  try {
    const w = war.publicSnapshot?.(client) || war.snapshot?.(client) || null;
    // Fallback: light read if war module exposes state differently
  } catch (_) {
    /* ignore */
  }

  try {
    const warFile = readJson(FILES.war, null);
    if (warFile && (warFile.endsAt || warFile.endAt || warFile.until)) {
      const ends = warFile.endsAt || warFile.endAt || warFile.until;
      const endMs = typeof ends === 'number' ? ends : Date.parse(ends);
      if (Number.isFinite(endMs) && endMs > now) {
        items.push({
          at: now,
          server: 'Server War',
          kind: 'war',
          text: `This week's war ends <t:${Math.floor(endMs / 1000)}:R>`.replace(
            /<t:(\d+):R>/,
            () => {
              const hrs = Math.max(1, Math.round((endMs - now) / 3600000));
              return `in about ${hrs} hour${hrs === 1 ? '' : 's'}`;
            }
          ),
        });
      }
    }
  } catch (_) {
    /* war file optional */
  }

  // Newest first, drop empties, cap at 30
  items.sort((a, b) => b.at - a.at);
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.text) continue;
    const key = `${it.server}|${it.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      at: new Date(it.at).toISOString(),
      server: it.server,
      kind: it.kind,
      text: it.text,
    });
    if (out.length >= NEWS_MAX) break;
  }

  return { generatedAt: new Date().toISOString(), items: out };
}

// ---------- Sending it to GitHub ----------

const last = new Map(); // file -> what we last sent (so unchanged data never makes a commit)
let queue = Promise.resolve(); // commits to one branch must go one at a time

function github(method, file, body) {
  return fetch(`https://api.github.com/repos/${REPO}/contents/${file}${method === 'GET' ? `?ref=${BRANCH}` : ''}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.WEB_GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'OverLorder-Bot',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
}

// Returns true if a new version was saved, false if nothing changed
async function publishNow(file, text, sameAs) {
  if (last.get(file) === sameAs) return false;

  for (let attempt = 1; ; attempt++) {
    let sha;
    const get = await github('GET', file);
    if (get.ok) {
      const remote = await get.json();
      sha = remote.sha;
      if (Buffer.from(remote.content ?? '', 'base64').toString('utf8') === text) {
        last.set(file, sameAs);
        return false;
      }
    } else if (get.status !== 404) {
      throw new Error(`GitHub answered ${get.status} while reading ${file}`);
    }

    const put = await github('PUT', file, {
      message: `Update ${file}`,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: BRANCH,
      sha,
    });
    if (put.status === 409 && attempt < 3) continue; // someone else committed at the same moment, try again
    if (!put.ok) {
      const hint = put.status === 404 || put.status === 422 ? ` (does the "${BRANCH}" branch exist, and can the token write to ${REPO}?)` : '';
      throw new Error(`GitHub answered ${put.status} while saving ${file}${hint}`);
    }
    last.set(file, sameAs);
    return true;
  }
}

function publishJson(file, obj) {
  if (!obj) return Promise.resolve(false);
  const { generatedAt, ...stable } = obj; // the timestamp alone never makes a commit
  const run = queue.then(() => publishNow(file, JSON.stringify(obj), JSON.stringify(stable)));
  queue = run.catch(() => {});
  return run;
}

async function exportAll(client, commands) {
  if (!process.env.WEB_GITHUB_TOKEN) return { skipped: 'the WEB_GITHUB_TOKEN environment variable is not set' };

  const result = { updated: [], unchanged: [], failed: [] };
  const step = async (file, build) => {
    try {
      (await publishJson(file, await build())) ? result.updated.push(file) : result.unchanged.push(file);
    } catch (err) {
      result.failed.push(`${file} (${String(err.message).slice(0, 100)})`);
      logging('error', `Website export failed for ${file}`, err);
    }
  };

  const ctx = snapshot(client);
  await step('changelog.json', buildChangelog);
  await step('commands.json', () => buildCommands(commands));
  await step('wiki.json', () => require('./webWiki').buildWiki());
  await step('leaderboards.json', () => buildLeaderboards(client, ctx));
  await step('servers.json', () => buildServers(client, ctx));
  await step('wars.json', () => buildWars(client, ctx));
  await step('stocks.json', () =>
    require('./webStocks').buildStocks(ctx, {
      slugOf,
      iconOf,
      isHidden,
      isBlocked: (id) => blacklist.isUserBlocked(id),
    })
  );
  await step('news.json', () => buildNews(client, ctx));
  return { ...result, servers: ctx.rows.length };
}

// A small "I'm alive" file for the status page
async function exportStatus(client) {
  if (!process.env.WEB_GITHUB_TOKEN) return false;
  return publishJson('status.json', buildStatus(client));
}

module.exports = { exportAll, exportStatus, isHidden, setHidden };
