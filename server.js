// server.js — бэкенд для сайта клана "Звёздный Легион"
// Забирает данные из официального Brawl Stars API и отдаёт их фронтенду
// уже в удобном формате (без API-ключа, без CORS-проблем).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } }); // до 80 МБ на файл

// ---------- НАСТРОЙКИ ----------
// BS_API_BASE:
//   - если у твоего сервера есть статический IP, внесённый в вайтлист на
//     https://developer.brawlstars.com → используй https://api.brawlstars.com/v1
//   - если IP динамический (обычный хостинг типа Render/Railway) — используй
//     прокси от RoyaleAPI: https://bsproxy.royaleapi.dev/v1
//     (тогда в вайтлист на developer.brawlstars.com нужно внести IP 45.79.218.79)
const BS_API_BASE = process.env.BS_API_BASE || 'https://bsproxy.royaleapi.dev/v1';
const BS_API_TOKEN = process.env.BS_API_TOKEN; // твой токен с developer.brawlstars.com
const CLUB_TAG = process.env.CLUB_TAG || '2U0U9L2PG'; // без "#", он передаётся отдельно

if (!BS_API_TOKEN) {
  console.warn('⚠️  BS_API_TOKEN не задан — заполни .env, иначе запросы будут падать с 403');
}

// ---------- НАСТРОЙКИ: ВХОД ЧЕРЕЗ DISCORD ----------
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI; // https://.../auth/discord/callback
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID; // ID Discord-сервера клана
const DISCORD_ROLE_ID = process.env.DISCORD_ROLE_ID; // ID роли "участник клана"
const FRONTEND_URL = process.env.FRONTEND_URL; // https://st-studi0.github.io/brawlclan-site
const SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET || 'change-me-please';
const ADMIN_DISCORD_IDS = (process.env.ADMIN_DISCORD_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- НАСТРОЙКИ: SUPABASE (хранение заявок на события) ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Загружает файл (картинку/видео) в публичный бакет Supabase Storage "event-media"
// и возвращает прямую публичную ссылку на него.
async function uploadToStorage(buffer, originalName, contentType) {
  const safeName = originalName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${Date.now()}-${safeName}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/event-media/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase Storage ${res.status}: ${text}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/event-media/${path}`;
}

// кэш на 10 минут — чтобы не долбить API на каждый заход посетителя сайта
const cache = new NodeCache({ stdTTL: 600 });

async function bsFetch(path) {
  const res = await fetch(`${BS_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${BS_API_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BS API ${res.status}: ${text}`);
  }
  return res.json();
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit) return hit;
  const data = await loader();
  cache.set(key, data);
  return data;
}

// роли клана в Brawl Stars API приходят как "member","admin","leader","vicePresident"
const ROLE_MAP = {
  president: 'leader',
  leader: 'leader',
  vicePresident: 'co',
  admin: 'vet',
  member: 'member',
};

// ---------- ЭНДПОИНТЫ ДЛЯ ФРОНТЕНДА ----------

// Общая информация о клане (кубки, кол-во участников, требования и т.д.)
app.get('/api/club', async (req, res) => {
  try {
    const data = await cached('club', () => bsFetch(`/clubs/%23${CLUB_TAG}`));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Полный список участников клана с ролями и кубками
// (плюс лучший бравлер каждого — требует доп. запросов к /players)
// Сравнивает текущий состав клана с тем, что мы видели в прошлый раз (таблица roster_members),
// и обновляет статусы: новые участники добавляются, пропавшие помечаются как "left".
async function syncRosterMembers(members) {
  try {
    const existing = await sbFetch('/roster_members?select=tag,status');
    const existingMap = new Map(existing.map((r) => [r.tag, r.status]));
    const currentTags = new Set(members.map((m) => m.tag));
    const nowIso = new Date().toISOString();

    for (const m of members) {
      const wasTracked = existingMap.has(m.tag);
      const wasActive = existingMap.get(m.tag) === 'active';

      if (!wasTracked) {
        await sbFetch('/roster_members', {
          method: 'POST',
          body: JSON.stringify({
            tag: m.tag, name: m.name, trophies: m.trophies, icon_id: m.icon?.id || null,
            status: 'active', first_seen_at: nowIso, last_seen_at: nowIso,
          }),
        });
      } else {
        const patch = { name: m.name, trophies: m.trophies, icon_id: m.icon?.id || null, last_seen_at: nowIso, status: 'active' };
        if (!wasActive) { patch.first_seen_at = nowIso; patch.left_at = null; } // вернулся в клан — считаем новым вступлением
        await sbFetch(`/roster_members?tag=eq.${encodeURIComponent(m.tag)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
      }
    }

    for (const [tag, status] of existingMap) {
      if (status === 'active' && !currentTags.has(tag)) {
        await sbFetch(`/roster_members?tag=eq.${encodeURIComponent(tag)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'left', left_at: nowIso }),
        });
      }
    }
  } catch (e) {
    console.warn('Не удалось синхронизировать историю состава:', e.message);
  }
}

app.get('/api/roster', async (req, res) => {
  try {
    const roster = await cached('roster', async () => {
      const club = await bsFetch(`/clubs/%23${CLUB_TAG}`);
      const members = club.members || [];

      syncRosterMembers(members); // не ждём — пусть пишется в фоне, на ответ не влияет

      // подтягиваем детальный профиль каждого игрока (лучший бравлер, винрейт и т.д.)
      // Brawl Stars API не даёт лимит запросов в доке впритык — берём с запасом,
      // делаем пачками по 5, чтобы не словить рейт-лимит
      const results = [];
      for (let i = 0; i < members.length; i += 5) {
        const batch = members.slice(i, i + 5);
        const batchData = await Promise.all(
          batch.map((m) =>
            bsFetch(`/players/%23${m.tag.replace('#', '')}`).catch(() => null)
          )
        );
        results.push(...batchData);
      }

      return members.map((m, idx) => {
        const p = results[idx];
        const sortedBrawlers = p?.brawlers?.length
          ? [...p.brawlers].sort((a, b) => b.trophies - a.trophies)
          : [];
        const bestBrawler = sortedBrawlers[0] || null;
        const top5Brawlers = sortedBrawlers.slice(0, 5).map((b) => ({
          id: b.id,
          name: b.name,
          trophies: b.trophies,
        }));

        return {
          name: m.name,
          tag: m.tag,
          role: ROLE_MAP[m.role] || 'member',
          trophies: m.trophies,
          iconId: m.icon?.id || null, // ID иконки профиля игрока — для аватарки через cdn.brawlify.com
          bestBrawlerName: bestBrawler?.name || '—',
          bestBrawlerTrophies: bestBrawler?.trophies || 0,
          bestBrawlerId: bestBrawler?.id || null, // настоящий ID бравлера — для точной картинки через cdn.brawlify.com
          top5Brawlers, // настоящий топ-5 бравлеров игрока (id, name, trophies) — для карточки профиля
          expLevel: p?.expLevel || null,
          soloWins: p?.soloVictories ?? null,
          duoWins: p?.duoVictories ?? null,
        };
      });
    });
    res.json(roster);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Последние бои конкретного игрока (например, для карточки/модалки профиля)
app.get('/api/player/:tag/battlelog', async (req, res) => {
  try {
    const tag = req.params.tag.replace('#', '');
    const data = await cached(`battlelog:${tag}`, () =>
      bsFetch(`/players/%23${tag}/battlelog`)
    );
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// "Активность сегодня": сколько участников играли за последние 24 часа.
// Считаем сами по battlelog — API не даёт статус "онлайн"/"активность" напрямую.
// battleTime приходит в формате "20260814T151250.000Z" (без дефисов/двоеточий).
function parseBattleTime(str) {
  // "20260814T151250.000Z" -> "2026-08-14T15:12:50.000Z"
  const m = str.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

app.get('/api/activity', async (req, res) => {
  try {
    const activity = await cached('activity', async () => {
      const club = await bsFetch(`/clubs/%23${CLUB_TAG}`);
      const members = club.members || [];
      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;
      const HOUR_MS = 60 * 60 * 1000;

      let activeToday = 0;
      let onlineNowIsh = 0; // играл в последний час — грубая замена "онлайн"
      const perPlayer = [];

      for (let i = 0; i < members.length; i += 5) {
        const batch = members.slice(i, i + 5);
        const results = await Promise.all(
          batch.map(async (m) => {
            try {
              const log = await bsFetch(`/players/%23${m.tag.replace('#', '')}/battlelog`);
              const last = log.items?.[0]?.battleTime;
              const lastDate = last ? parseBattleTime(last) : null;
              return { name: m.name, tag: m.tag, lastBattle: lastDate };
            } catch {
              return { name: m.name, tag: m.tag, lastBattle: null };
            }
          })
        );
        for (const r of results) {
          perPlayer.push({
            name: r.name,
            tag: r.tag,
            lastBattleAt: r.lastBattle ? r.lastBattle.toISOString() : null,
          });
          if (r.lastBattle) {
            const diff = now - r.lastBattle.getTime();
            if (diff <= DAY_MS) activeToday++;
            if (diff <= HOUR_MS) onlineNowIsh++;
          }
        }
      }

      return {
        totalMembers: members.length,
        activeToday,
        onlineNowIsh,
        perPlayer,
        computedAt: new Date().toISOString(),
      };
    });
    res.json(activity);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Кто вступил и кто вышел из клана сегодня — сравнение с сохранённой историей состава.
app.get('/api/roster/activity', async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    const [joined, left] = await Promise.all([
      sbFetch(`/roster_members?first_seen_at=gte.${todayIso}&status=eq.active&select=tag,name,trophies,icon_id,first_seen_at&order=first_seen_at.desc`),
      sbFetch(`/roster_members?left_at=gte.${todayIso}&select=tag,name,trophies,icon_id,left_at&order=left_at.desc`),
    ]);

    res.json({ date: todayStart.toISOString().slice(0, 10), joined, left });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Актуальный список карт Brawl Stars (через открытый справочник BrawlAPI) —
// для выпадающего списка "выбрать карту" при создании события в админке.
app.get('/api/maps', async (req, res) => {
  try {
    const maps = await cached('maps', async () => {
      const r = await fetch('https://api.brawlapi.com/v1/maps');
      if (!r.ok) throw new Error(`BrawlAPI maps ${r.status}`);
      const data = await r.json();
      return (data.list || []).map((m) => ({
        id: m.id,
        name: m.name,
        mode: m.gameMode?.name || null,
        imageUrl: m.imageUrl || null,
      }));
    });
    res.json(maps);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Реальная статистика по последним боям клана: собираем battlelog каждого участника
// (обычно это последние ~25 боёв на человека, в любых режимах — не только Клубная лига)
// и считаем общие победы/поражения + активность по картам.
app.get('/api/battle-stats', async (req, res) => {
  try {
    const stats = await cached('battle-stats', async () => {
      const club = await bsFetch(`/clubs/%23${CLUB_TAG}`);
      const members = club.members || [];

      let wins = 0, losses = 0, draws = 0;
      const mapStats = {}; // { "Название карты": { plays, wins, losses } }

      for (let i = 0; i < members.length; i += 5) {
        const batch = members.slice(i, i + 5);
        const batchLogs = await Promise.all(
          batch.map((m) => bsFetch(`/players/%23${m.tag.replace('#', '')}/battlelog`).catch(() => null))
        );
        for (const log of batchLogs) {
          if (!log?.items) continue;
          for (const item of log.items) {
            const mapName = item.event?.map || null;
            const result = item.battle?.result; // 'victory' | 'defeat' | 'draw' — в Showdown вместо этого приходит "rank", пропускаем

            if (mapName && !mapStats[mapName]) mapStats[mapName] = { plays: 0, wins: 0, losses: 0 };
            if (mapName) mapStats[mapName].plays++;

            if (result === 'victory') { wins++; if (mapName) mapStats[mapName].wins++; }
            else if (result === 'defeat') { losses++; if (mapName) mapStats[mapName].losses++; }
            else if (result === 'draw') { draws++; }
          }
        }
      }

      const decisive = wins + losses;
      const winratePct = decisive ? Math.round((wins / decisive) * 100) : 0;

      const topMaps = Object.entries(mapStats)
        .map(([name, s]) => ({
          name, plays: s.plays, wins: s.wins, losses: s.losses,
          winrate: (s.wins + s.losses) ? Math.round((s.wins / (s.wins + s.losses)) * 100) : 0,
        }))
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 8);

      return { wins, losses, draws, winratePct, topMaps, computedAt: new Date().toISOString() };
    });
    res.json(stats);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- ВХОД ЧЕРЕЗ DISCORD ----------

// Middleware: проверяет JWT из заголовка Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    req.user = jwt.verify(token, SESSION_JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Только для админа' });
  next();
}

// Шаг 1: сайт перекидывает сюда кнопкой "Войти", а мы перенаправляем в Discord
app.get('/auth/discord/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// Шаг 2: Discord возвращает сюда пользователя с временным кодом
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect(`${FRONTEND_URL}#auth_error=no_code`);

  try {
    // меняем code на access_token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error('Не удалось обменять код на токен');
    const tokenData = await tokenRes.json();

    // получаем данные пользователя
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    // проверяем, что человек состоит именно в нашем Discord-сервере клана
    const memberRes = await fetch(
      `https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );

    if (!memberRes.ok) {
      // не состоит в сервере клана вообще
      return res.redirect(`${FRONTEND_URL}#auth_error=not_in_guild`);
    }
    const member = await memberRes.json();
    const hasRole = (member.roles || []).includes(DISCORD_ROLE_ID);

    if (!hasRole) {
      return res.redirect(`${FRONTEND_URL}#auth_error=not_clan_member`);
    }

    const isAdmin = ADMIN_DISCORD_IDS.includes(user.id);
    // Серверный никнейм (тот, что человек задал именно на сервере клана) в приоритете —
    // многие используют его как игровой ник. Если не задан — берём обычный аккаунт-ник.
    const displayName = member.nick || user.global_name || user.username;
    const sessionToken = jwt.sign(
      {
        id: user.id,
        username: displayName,
        avatar: user.avatar,
        verified: true,
        isAdmin,
      },
      SESSION_JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.redirect(`${FRONTEND_URL}#token=${sessionToken}`);
  } catch (e) {
    console.error('Discord auth error:', e.message);
    res.redirect(`${FRONTEND_URL}#auth_error=server_error`);
  }
});

// Проверка текущей сессии (фронтенд дёргает при загрузке страницы)
app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// ---------- СОБЫТИЯ И ЗАЯВКИ ----------

// Список событий — видно всем, без входа
app.get('/api/events', async (req, res) => {
  try {
    const events = await sbFetch('/events?select=*&order=event_date.asc');
    res.json(events);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Состав команд конкретного события — видно всем (просто ники, без discord_id)
app.get('/api/events/:id/lineup', async (req, res) => {
  try {
    const apps = await sbFetch(
      `/applications?event_id=eq.${req.params.id}&select=discord_username,assigned_team,assigned_time,status&order=assigned_team.asc`
    );
    res.json(apps);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Подать заявку на событие — только авторизованным участникам клана
app.post('/api/events/:id/apply', requireAuth, async (req, res) => {
  try {
    const eventId = req.params.id;
    const note = (req.body?.note || '').slice(0, 300);

    await sbFetch(`/applications?on_conflict=event_id,discord_id`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        event_id: eventId,
        discord_id: req.user.id,
        discord_username: req.user.username,
        discord_avatar: req.user.avatar,
        note,
        status: 'pending',
      }),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Мои заявки — чтобы игрок видел на сайте, куда уже подавался
app.get('/api/my-applications', requireAuth, async (req, res) => {
  try {
    const apps = await sbFetch(
      `/applications?discord_id=eq.${req.user.id}&select=*`
    );
    res.json(apps);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- АДМИНКА (только ты) ----------

// Все заявки по всем событиям — для распределения по командам
app.get('/api/admin/applications', requireAuth, requireAdmin, async (req, res) => {
  try {
    const apps = await sbFetch(
      `/applications?select=*,events(title,event_date)&order=created_at.desc`
    );
    res.json(apps);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Назначить команду/время конкретной заявке
app.patch('/api/admin/applications/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { assigned_team, assigned_time, status } = req.body || {};
    const patch = {};
    if (assigned_team !== undefined) patch.assigned_team = assigned_team;
    if (assigned_time !== undefined) patch.assigned_time = assigned_time;
    if (status !== undefined) patch.status = status;

    await sbFetch(`/applications?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Создать новое событие (админ)
app.post('/api/admin/events', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, description, event_date, mode, format, map, stream_url, image_url, video_url } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title обязателен' });

    const created = await sbFetch('/events', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ title, description, event_date, mode, format, map, stream_url, image_url, video_url }),
    });

    res.json(created);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Отредактировать событие: режим, карта, ссылка на стрим, результат, картинка, видео (админ)
app.patch('/api/admin/events/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const allowed = ['title', 'description', 'event_date', 'mode', 'format', 'map', 'stream_url', 'result', 'image_url', 'video_url'];
    const patch = {};
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) patch[key] = req.body[key];
    }

    await sbFetch(`/events?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Загрузка файла (картинка события или видео) — только админ.
// Принимает multipart/form-data с полем "file", возвращает { url }.
app.post('/api/admin/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
    const url = await uploadToStorage(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json({ url });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Удалить событие (админ). Заявки удалятся сами (on delete cascade в базе).
// Если у события была загруженная в наше хранилище картинка/видео — удаляем и файл(ы) тоже.
app.delete('/api/admin/events/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [event] = await sbFetch(`/events?id=eq.${req.params.id}&select=image_url,video_url`);

    const storagePrefix = `${SUPABASE_URL}/storage/v1/object/public/event-media/`;
    const filesToDelete = [event?.image_url, event?.video_url]
      .filter((url) => url && url.startsWith(storagePrefix))
      .map((url) => url.slice(storagePrefix.length));

    if (filesToDelete.length) {
      await fetch(`${SUPABASE_URL}/storage/v1/object/event-media`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefixes: filesToDelete }),
      }).catch(() => {}); // не критично, если не получится — событие всё равно удалится
    }

    await sbFetch(`/events?id=eq.${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Backend запущен: http://localhost:${PORT}`));
