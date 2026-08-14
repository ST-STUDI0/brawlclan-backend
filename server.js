// server.js — бэкенд для сайта клана "Звёздный Легион"
// Забирает данные из официального Brawl Stars API и отдаёт их фронтенду
// уже в удобном формате (без API-ключа, без CORS-проблем).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');

const app = express();
app.use(cors()); // разрешаем сайту стучаться на этот сервер с другого домена

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
app.get('/api/roster', async (req, res) => {
  try {
    const roster = await cached('roster', async () => {
      const club = await bsFetch(`/clubs/%23${CLUB_TAG}`);
      const members = club.members || [];

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Backend запущен: http://localhost:${PORT}`));
