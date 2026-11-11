// Familielogistikk – testversjon
// Express + Postgres. Innlogging med e-post og passord, én familie per konto,
// invitasjonslenker, felles avtaler og (valgfritt) bildelesing via Claude API.

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const dns = require("dns").promises;
const net = require("net");
const ical = require("node-ical");

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";
const DATABASE_URL = process.env.DATABASE_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const SESSION_DAYS = 60;
const INVITE_DAYS = 7;

if (!DATABASE_URL) {
  console.error("DATABASE_URL mangler. Se README.md.");
  process.exit(1);
}

// SSL: Render's internal hostnames (no dots, e.g. dpg-xxxx-a) and localhost connect without SSL;
// external hostnames use SSL. Override with PGSSL=disable or PGSSL=require.
function sslFor(url) {
  if (process.env.PGSSL === "disable") return false;
  if (process.env.PGSSL === "require") return { rejectUnauthorized: false };
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || !host.includes(".") ? false : { rejectUnauthorized: false };
}
const pool = new Pool({ connectionString: DATABASE_URL, ssl: sslFor(DATABASE_URL), max: 5 });

// ---------- schema ----------
async function migrate() {
  await pool.query(`
    create table if not exists families (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      members jsonb not null default '[]',
      created_at timestamptz not null default now()
    );
    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      family_id uuid not null references families(id) on delete cascade,
      name text not null,
      email text not null,
      password_hash text not null,
      role text not null default 'member',
      created_at timestamptz not null default now()
    );
    create unique index if not exists users_email_idx on users (lower(email));
    create table if not exists sessions (
      token_hash text primary key,
      user_id uuid not null references users(id) on delete cascade,
      expires_at timestamptz not null
    );
    create table if not exists invites (
      token_hash text primary key,
      family_id uuid not null references families(id) on delete cascade,
      created_by uuid references users(id) on delete set null,
      expires_at timestamptz not null,
      used_at timestamptz
    );
    create table if not exists feeds (
      id uuid primary key default gen_random_uuid(),
      family_id uuid not null references families(id) on delete cascade,
      name text not null,
      url text not null,
      who jsonb not null default '[]',
      last_sync timestamptz,
      last_error text,
      event_count int not null default 0,
      created_at timestamptz not null default now()
    );
    create table if not exists notes (
      id text not null,
      family_id uuid not null references families(id) on delete cascade,
      data jsonb not null,
      updated_at timestamptz not null default now(),
      primary key (family_id, id)
    );
    create table if not exists events (
      id text not null,
      family_id uuid not null references families(id) on delete cascade,
      data jsonb not null,
      updated_at timestamptz not null default now(),
      primary key (family_id, id)
    );
  `);
}

// ---------- helpers ----------
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");
const COLORS = 6;

function cookieOpts(maxAgeMs) {
  return { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: maxAgeMs, path: "/" };
}
function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, value, maxAgeMs) {
  const o = cookieOpts(maxAgeMs);
  const parts = [`fl_sess=${encodeURIComponent(value)}`, `Path=/`, `Max-Age=${Math.floor(o.maxAge / 1000)}`, `HttpOnly`, `SameSite=Lax`];
  if (o.secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

async function createSession(res, userId) {
  const t = token();
  await pool.query(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha(t), userId]
  );
  setSessionCookie(res, t, SESSION_DAYS * 864e5);
}

const clean = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Simple in-memory throttle for login/register (per IP + route)
const hits = new Map();
function throttle(limit, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) return res.status(429).json({ error: "For mange forsøk. Vent noen minutter og prøv igjen." });
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
app.use(express.json({ limit: "8mb" }));

// CSRF guard: state-changing API calls must come from our own page (custom header + same-origin cookie)
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && req.get("X-FL") !== "1") return res.status(403).json({ error: "Ugyldig forespørsel." });
  next();
});

async function auth(req, res, next) {
  const t = parseCookies(req.headers.cookie).fl_sess;
  if (!t) return res.status(401).json({ error: "Ikke innlogget." });
  const { rows } = await pool.query(
    `select u.id, u.name, u.email, u.role, u.family_id
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [sha(t)]
  );
  if (!rows[0]) return res.status(401).json({ error: "Ikke innlogget." });
  req.user = rows[0];
  req.sessionHash = sha(t);
  next();
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function familyPayload(user) {
  const f = await pool.query(`select id, name, members from families where id = $1`, [user.family_id]);
  const people = await pool.query(`select name, email, role from users where family_id = $1 order by created_at`, [user.family_id]);
  return {
    user: { name: user.name, email: user.email, role: user.role },
    family: { name: f.rows[0].name, members: f.rows[0].members, accounts: people.rows },
    imageReading: !!ANTHROPIC_API_KEY,
    placesSearch: !!GOOGLE_MAPS_API_KEY,
  };
}

// Register: with a valid invite you join that family, otherwise a new family is created
app.post("/api/register", throttle(10, 15 * 60e3), wrap(async (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const invite = clean(req.body.invite, 100);
  if (!name) return res.status(400).json({ error: "Skriv inn navnet ditt." });
  if (!validEmail(email)) return res.status(400).json({ error: "E-postadressen ser ikke riktig ut." });
  if (password.length < 8) return res.status(400).json({ error: "Passordet må ha minst 8 tegn." });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const exists = await client.query(`select 1 from users where lower(email) = $1`, [email]);
    if (exists.rows[0]) { await client.query("rollback"); return res.status(409).json({ error: "Det finnes allerede en konto med denne e-posten. Logg inn i stedet." }); }

    let familyId, role = "owner";
    if (invite) {
      const inv = await client.query(
        `select family_id from invites where token_hash = $1 and expires_at > now() and used_at is null for update`,
        [sha(invite)]
      );
      if (!inv.rows[0]) { await client.query("rollback"); return res.status(400).json({ error: "Invitasjonen er brukt eller utløpt. Be om en ny lenke." }); }
      familyId = inv.rows[0].family_id;
      role = "member";
      await client.query(`update invites set used_at = now() where token_hash = $1`, [sha(invite)]);
      // Add the new person to the calendar's family list if they aren't there yet
      const f = await client.query(`select members from families where id = $1`, [familyId]);
      const members = f.rows[0].members || [];
      const first = name.split(/\s+/)[0].toLowerCase();
      if (!members.some((m) => String(m.name).split(/\s+/)[0].toLowerCase() === first)) {
        members.push({ id: "m" + crypto.randomBytes(4).toString("hex"), name: name.split(/\s+/)[0], c: (members.length % COLORS) + 1 });
        await client.query(`update families set members = $1 where id = $2`, [JSON.stringify(members), familyId]);
      }
    } else {
      const surname = name.split(/\s+/).length > 1 ? name.split(/\s+/).slice(-1)[0] : name;
      const members = [{ id: "m" + crypto.randomBytes(4).toString("hex"), name: name.split(/\s+/)[0], c: 1 }];
      const f = await client.query(`insert into families (name, members) values ($1, $2) returning id`, ["Familien " + surname, JSON.stringify(members)]);
      familyId = f.rows[0].id;
    }
    const hash = await bcrypt.hash(password, 11);
    const u = await client.query(
      `insert into users (family_id, name, email, password_hash, role) values ($1, $2, $3, $4, $5) returning id`,
      [familyId, name, email, hash, role]
    );
    await client.query("commit");
    await createSession(res, u.rows[0].id);
    res.json({ ok: true });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

app.post("/api/login", throttle(10, 15 * 60e3), wrap(async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const { rows } = await pool.query(`select id, password_hash from users where lower(email) = $1`, [email]);
  const ok = rows[0] && (await bcrypt.compare(password, rows[0].password_hash));
  if (!ok) return res.status(401).json({ error: "Feil e-post eller passord." });
  await createSession(res, rows[0].id);
  res.json({ ok: true });
}));

app.post("/api/logout", wrap(async (req, res) => {
  const t = parseCookies(req.headers.cookie).fl_sess;
  if (t) await pool.query(`delete from sessions where token_hash = $1`, [sha(t)]);
  setSessionCookie(res, "", 0);
  res.json({ ok: true });
}));

app.get("/api/me", wrap(auth), wrap(async (req, res) => {
  res.json(await familyPayload(req.user));
}));

app.put("/api/family", wrap(auth), wrap(async (req, res) => {
  const list = Array.isArray(req.body.members) ? req.body.members : null;
  if (!list || !list.length || list.length > 20) return res.status(400).json({ error: "Familien må ha mellom 1 og 20 personer." });
  const members = list.map((m) => ({
    id: clean(m.id, 40) || "m" + crypto.randomBytes(4).toString("hex"),
    name: clean(m.name, 40),
    c: Math.min(Math.max(parseInt(m.c, 10) || 1, 1), COLORS),
  })).filter((m) => m.name);
  const name = clean(req.body.name, 60);
  await pool.query(`update families set members = $1${name ? ", name = $3" : ""} where id = $2`,
    name ? [JSON.stringify(members), req.user.family_id, name] : [JSON.stringify(members), req.user.family_id]);
  res.json(await familyPayload(req.user));
}));

// Invites: any account in the family may create a link; it works once and expires after 7 days
app.post("/api/invites", wrap(auth), wrap(async (req, res) => {
  const t = token();
  await pool.query(
    `insert into invites (token_hash, family_id, created_by, expires_at) values ($1, $2, $3, now() + interval '${INVITE_DAYS} days')`,
    [sha(t), req.user.family_id, req.user.id]
  );
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base}/?invite=${t}`, days: INVITE_DAYS });
}));

app.get("/api/invites/:token", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `select f.name, u.name as inviter from invites i join families f on f.id = i.family_id
       left join users u on u.id = i.created_by
      where i.token_hash = $1 and i.expires_at > now() and i.used_at is null`,
    [sha(clean(req.params.token, 100))]
  );
  if (!rows[0]) return res.status(404).json({ error: "Invitasjonen er brukt eller utløpt." });
  res.json({ family: rows[0].name, inviter: rows[0].inviter });
}));

// Events
const EVENT_FIELDS = ["title", "date", "start", "end", "who", "place", "address", "mapsUrl", "placeId", "note", "remind", "repeat", "sms", "example", "created"];
function cleanEvent(b) {
  const o = {};
  for (const k of EVENT_FIELDS) if (b[k] !== undefined) o[k] = b[k];
  o.title = clean(o.title, 120);
  o.date = /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : "";
  o.start = /^\d{2}:\d{2}$/.test(o.start) ? o.start : "";
  o.end = /^\d{2}:\d{2}$/.test(o.end) ? o.end : "";
  o.who = Array.isArray(o.who) ? o.who.map((x) => clean(String(x), 40)).slice(0, 20) : [];
  o.place = clean(o.place, 200);
  o.address = clean(o.address, 300);
  o.mapsUrl = /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl)\//.test(o.mapsUrl || "") ? clean(o.mapsUrl, 500) : "";
  o.placeId = clean(o.placeId, 300);
  o.note = clean(o.note, 600);
  o.remind = clean(o.remind, 20);
  o.repeat = ["", "weekly", "biweekly"].includes(o.repeat) ? o.repeat : "";
  o.sms = clean(o.sms, 1200);
  o.example = !!o.example;
  o.created = Number(o.created) || Date.now();
  return o;
}

// Beskjeder: short messages from a family member that show on the board for one day
function cleanNote(b) {
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : "",
    who: clean(String(b.who || ""), 40),
    text: clean(b.text, 280),
    created: Number(b.created) || Date.now(),
  };
}
app.get("/api/notes", wrap(auth), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `select id, data from notes where family_id = $1 and data->>'date' >= to_char(now() - interval '7 days', 'YYYY-MM-DD')`,
    [req.user.family_id]
  );
  res.json({ notes: rows.map((r) => ({ id: r.id, ...r.data })) });
}));
app.put("/api/notes/:id", wrap(auth), wrap(async (req, res) => {
  const id = clean(req.params.id, 60);
  const data = cleanNote(req.body || {});
  if (!id || !data.text || !data.date) return res.status(400).json({ error: "Beskjeden må ha tekst og dato." });
  await pool.query(
    `insert into notes (id, family_id, data, updated_at) values ($1, $2, $3, now())
     on conflict (family_id, id) do update set data = excluded.data, updated_at = now()`,
    [id, req.user.family_id, JSON.stringify(data)]
  );
  res.json({ ok: true });
}));
app.delete("/api/notes/:id", wrap(auth), wrap(async (req, res) => {
  await pool.query(`delete from notes where family_id = $1 and id = $2`, [req.user.family_id, clean(req.params.id, 60)]);
  res.json({ ok: true });
}));

app.get("/api/events", wrap(auth), wrap(async (req, res) => {
  const { rows } = await pool.query(`select id, data from events where family_id = $1`, [req.user.family_id]);
  res.json({ events: rows.map((r) => ({ id: r.id, ...r.data })) });
}));

app.put("/api/events/:id", wrap(auth), wrap(async (req, res) => {
  const id = clean(req.params.id, 60);
  if (id.startsWith("f_")) return res.status(400).json({ error: "Avtaler fra et kalenderabonnement endres i kilden, for eksempel i Spond." });
  const data = cleanEvent(req.body || {});
  if (!id || !data.title || !data.date) return res.status(400).json({ error: "Avtalen må ha tittel og dato." });
  const count = await pool.query(`select count(*)::int as n from events where family_id = $1`, [req.user.family_id]);
  if (count.rows[0].n > 5000) return res.status(400).json({ error: "Kalenderen er full. Slett gamle avtaler først." });
  await pool.query(
    `insert into events (id, family_id, data, updated_at) values ($1, $2, $3, now())
     on conflict (family_id, id) do update set data = excluded.data, updated_at = now()`,
    [id, req.user.family_id, JSON.stringify(data)]
  );
  res.json({ ok: true });
}));

app.delete("/api/events/:id", wrap(auth), wrap(async (req, res) => {
  if (clean(req.params.id, 60).startsWith("f_")) return res.status(400).json({ error: "Avtaler fra et kalenderabonnement slettes i kilden." });
  await pool.query(`delete from events where family_id = $1 and id = $2`, [req.user.family_id, clean(req.params.id, 60)]);
  res.json({ ok: true });
}));

// Image reading through the Claude API (only when ANTHROPIC_API_KEY is set)
app.post("/api/read-image", throttle(30, 60 * 60e3), wrap(auth), wrap(async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: "Bildelesing er ikke slått på." });
  const { image, mediaType, today, weekday } = req.body || {};
  if (typeof image !== "string" || image.length > 7_000_000) return res.status(400).json({ error: "Bildet er for stort." });
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mediaType)) return res.status(400).json({ error: "Bruk et JPEG-, PNG-, WebP- eller GIF-bilde." });
  const fam = await pool.query(`select members from families where id = $1`, [req.user.family_id]);
  const names = (fam.rows[0].members || []).map((m) => m.name).join(", ");
  const prompt = `Bildet er et skjermbilde eller foto av en avtale, innkalling, timebekreftelse, invitasjon eller lignende (for eksempel fra Spond, SMS, e-post eller et skolebrev). Dagens dato er ${clean(today, 10)} (${clean(weekday, 12)}).
Finn avtalen og svar KUN med ett JSON-objekt med disse feltene:
{"title": kort norsk tittel, maks 40 tegn,
 "date": "YYYY-MM-DD",
 "start": "HH:MM" (oppmøtetid hvis den står, ellers starttid),
 "end": "HH:MM" eller "",
 "place": sted og adresse, eller "",
 "who": [fulle navn på personene avtalen gjelder, f.eks. «svarer på vegne av»],
 "note": kort notat med viktige detaljer som faktisk starttid etter oppmøte, svarfrist, hva man skal ha med, gruppe/lag (maks 160 tegn),
 "summary": én kort setning om hva bildet viser}
Bruk "" eller [] for det du ikke finner. Mangler årstall, velg første mulige dato fra og med i dag. Familiens navn i kalenderen: ${names}.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: prompt },
      ] }],
    }),
  });
  if (!r.ok) {
    console.error("Claude API", r.status, (await r.text()).slice(0, 300));
    return res.status(502).json({ error: r.status === 429 ? "For mange forespørsler akkurat nå. Prøv igjen om litt." : "Bildelesingen feilet. Prøv igjen." });
  }
  const out = await r.json();
  const text = (out.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  try { res.json(JSON.parse(m ? m[0] : text)); }
  catch { res.status(422).json({ error: "Fant ingen tydelig avtale i bildet. Prøv igjen, eller skriv den inn selv." }); }
}));

function googleHint(status, reason) {
  const t = (reason || "").toLowerCase();
  if (t.includes("referer") || t.includes("referrer")) return "Google-nøkkelen er låst til nettsider. Endre «Application restrictions» til «None» (eller IP) i Google Cloud.";
  if (t.includes("has not been used") || t.includes("disabled") || t.includes("service_disabled")) return "Places API (New) er ikke slått på i Google Cloud-prosjektet.";
  if (t.includes("billing")) return "Google Cloud-prosjektet mangler betalingskonto.";
  if (t.includes("api key not valid") || t.includes("api_key_invalid")) return "Google-nøkkelen er ugyldig. Sjekk at hele nøkkelen er limt inn i Render.";
  if (t.includes("blocked") || status === 403) return "Google-nøkkelen har ikke tilgang til Places API (New). Sjekk «API restrictions».";
  return "Stedssøket svarer ikke akkurat nå.";
}

// Place search through Google Places API (New). Session tokens group typing + selection into one billed session.
const NORWAY_BIAS = { rectangle: { low: { latitude: 57.9, longitude: 4.5 }, high: { latitude: 71.2, longitude: 31.2 } } };
app.get("/api/places/autocomplete", throttle(400, 60 * 60e3), wrap(auth), wrap(async (req, res) => {
  if (!GOOGLE_MAPS_API_KEY) return res.status(503).json({ error: "Forslag fra Google Maps er ikke slått på: GOOGLE_MAPS_API_KEY mangler i Render." });
  const q = clean(req.query.q, 120);
  if (q.length < 2) return res.json({ suggestions: [] });
  let r;
  try { r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY },
    body: JSON.stringify({ input: q, languageCode: "no", regionCode: "no", locationBias: NORWAY_BIAS, sessionToken: clean(req.query.session, 64) || undefined }),
  }); } catch (e) { console.error("Places autocomplete network", e.message); return res.status(502).json({ error: "Får ikke kontakt med Google Maps akkurat nå." }); }
  if (!r.ok) {
    const body = await r.text();
    console.error("Places autocomplete", r.status, body.slice(0, 500));
    let reason = ""; try { const g = JSON.parse(body).error || {}; reason = [g.status, g.message].filter(Boolean).join(": "); } catch {}
    return res.status(502).json({ error: googleHint(r.status, reason), reason: reason.slice(0, 300) });
  }
  const j = await r.json();
  const suggestions = (j.suggestions || []).filter((s) => s.placePrediction).slice(0, 6).map((s) => {
    const p = s.placePrediction;
    return { placeId: p.placeId, name: p.structuredFormat?.mainText?.text || p.text?.text || "", detail: p.structuredFormat?.secondaryText?.text || "" };
  });
  res.json({ suggestions });
}));

app.get("/api/places/:id", throttle(200, 60 * 60e3), wrap(auth), wrap(async (req, res) => {
  if (!GOOGLE_MAPS_API_KEY) return res.status(503).json({ error: "Stedssøk er ikke slått på." });
  const id = clean(req.params.id, 300);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: "Ugyldig sted." });
  const session = clean(req.query.session, 64);
  const r = await fetch(`https://places.googleapis.com/v1/places/${id}?languageCode=no${session ? "&sessionToken=" + encodeURIComponent(session) : ""}`, {
    headers: { "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": "id,displayName,formattedAddress,shortFormattedAddress,googleMapsUri" },
  });
  if (!r.ok) { console.error("Places details", r.status, (await r.text()).slice(0, 300)); return res.status(502).json({ error: "Fant ikke stedet." }); }
  const p = await r.json();
  res.json({ placeId: p.id, name: p.displayName?.text || "", address: p.shortFormattedAddress || p.formattedAddress || "", mapsUrl: p.googleMapsUri || "" });
}));

// ---------- Kalenderabonnement (iCal/ICS), f.eks. Spond via Google- eller iCloud-kalender ----------
const FEED_PAST_DAYS = 14, FEED_FUTURE_DAYS = 120, FEED_MAX_EVENTS = 1500;
const osloFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function oslo(d) { const s = osloFmt.format(d).replace(",", ""); return { date: s.slice(0, 10), time: s.slice(11, 16) }; }
function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

function normalizeFeedUrl(u) {
  u = clean(u, 1000).replace(/^webcals?:\/\//i, "https://");
  let url; try { url = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  return url.toString();
}
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:192.168.");
}
async function fetchIcs(urlStr) {
  const url = new URL(urlStr);
  if (!process.env.ALLOW_PRIVATE_FEEDS) {
    const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error("Fant ikke adressen. Sjekk lenken.");
    if (addrs.some((a) => privateIp(a.address))) throw new Error("Lenken peker til en intern adresse og kan ikke brukes.");
  }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(urlStr, { signal: ctl.signal, redirect: "follow", headers: { "User-Agent": "Familielogistikk/0.1 (kalenderabonnement)", Accept: "text/calendar,*/*" } });
    if (!r.ok) throw new Error(r.status === 404 ? "Kalenderen finnes ikke (404). Sjekk lenken." : r.status === 401 || r.status === 403 ? "Kalenderen er ikke delt (ingen tilgang). Bruk den hemmelige/offentlige iCal-lenken." : `Kalenderen svarte med feil ${r.status}.`);
    const text = await r.text();
    if (text.length > 8e6) throw new Error("Kalenderen er for stor.");
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("Lenken er ikke en iCal-kalender. Bruk lenken som slutter på .ics.");
    return text;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Kalenderen svarte ikke i tide.");
    if (e.message === "fetch failed" || e.cause) throw new Error("Får ikke kontakt med kalenderen. Sjekk at lenken er riktig og delt.");
    throw e;
  } finally { clearTimeout(t); }
}
function feedEventsFromIcs(text) {
  const data = ical.sync.parseICS(text);
  const from = new Date(Date.now() - FEED_PAST_DAYS * 864e5), to = new Date(Date.now() + FEED_FUTURE_DAYS * 864e5);
  const out = [];
  const push = (ev, start, end) => {
    if (out.length >= FEED_MAX_EVENTS || !start) return;
    const allDay = ev.datetype === "date" || (start && ev.start && ev.start.dateOnly);
    let date, st = "", en = "";
    if (allDay) { date = ymd(start); }
    else { const s = oslo(start); date = s.date; st = s.time; if (end) { const e = oslo(end); if (e.date === s.date) en = e.time; } }
    const title = typeof ev.summary === "string" ? ev.summary : (ev.summary && ev.summary.val) || "";
    const place = typeof ev.location === "string" ? ev.location : (ev.location && ev.location.val) || "";
    const desc = typeof ev.description === "string" ? ev.description : (ev.description && ev.description.val) || "";
    out.push({ uid: String(ev.uid || title) + "|" + date + st, title: clean(title, 120) || "Avtale", date, start: st, end: en, place: clean(place, 200), note: clean(desc.replace(/\s+/g, " "), 300) });
  };
  for (const k of Object.keys(data)) {
    const ev = data[k];
    if (!ev || ev.type !== "VEVENT" || !ev.start) continue;
    if (ev.status && String(ev.status).toUpperCase() === "CANCELLED") continue;
    const dur = ev.end ? ev.end - ev.start : 0;
    if (ev.rrule) {
      let occ = [];
      try { occ = ev.rrule.between(from, to, true); } catch { occ = []; }
      for (const o of occ) {
        const key = o.toISOString().slice(0, 10);
        if (ev.exdate && (ev.exdate[key] || Object.values(ev.exdate).some((x) => x && x.getTime && x.getTime() === o.getTime()))) continue;
        const ov = ev.recurrences && ev.recurrences[key];
        if (ov) { if (ov.start && ov.start >= from && ov.start <= to) push(ov, ov.start, ov.end); continue; }
        push(ev, o, dur ? new Date(o.getTime() + dur) : null);
      }
    } else if (ev.start >= from && ev.start <= to) {
      push(ev, ev.start, ev.end);
    }
  }
  return out;
}
async function syncFeed(feed) {
  try {
    const text = await fetchIcs(feed.url);
    const evs = feedEventsFromIcs(text);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from events where family_id = $1 and data->>'source' = $2`, [feed.family_id, feed.id]);
      for (const e of evs) {
        const id = "f_" + sha(feed.id + e.uid).slice(0, 24);
        const data = { title: e.title, date: e.date, start: e.start, end: e.end, who: feed.who || [], place: e.place, note: e.note, remind: "", repeat: "", source: feed.id, sourceName: feed.name, created: 0 };
        await client.query(`insert into events (id, family_id, data, updated_at) values ($1, $2, $3, now()) on conflict (family_id, id) do update set data = excluded.data, updated_at = now()`, [id, feed.family_id, JSON.stringify(data)]);
      }
      await client.query(`update feeds set last_sync = now(), last_error = null, event_count = $2 where id = $1`, [feed.id, evs.length]);
      await client.query("commit");
    } catch (e) { await client.query("rollback").catch(() => {}); throw e; } finally { client.release(); }
    return { ok: true, count: evs.length };
  } catch (e) {
    const msg = e && e.message ? e.message.slice(0, 300) : "Ukjent feil";
    await pool.query(`update feeds set last_sync = now(), last_error = $2 where id = $1`, [feed.id, msg]).catch(() => {});
    return { ok: false, error: msg };
  }
}
const feedRow = (f) => ({ id: f.id, name: f.name, who: f.who, host: (() => { try { return new URL(f.url).hostname; } catch { return ""; } })(), lastSync: f.last_sync, error: f.last_error, count: f.event_count });

app.get("/api/feeds", wrap(auth), wrap(async (req, res) => {
  const { rows } = await pool.query(`select * from feeds where family_id = $1 order by created_at`, [req.user.family_id]);
  res.json({ feeds: rows.map(feedRow) });
}));
app.post("/api/feeds", throttle(20, 60 * 60e3), wrap(auth), wrap(async (req, res) => {
  const url = normalizeFeedUrl(req.body.url);
  const name = clean(req.body.name, 40) || "Kalender";
  const who = Array.isArray(req.body.who) ? req.body.who.map((x) => clean(String(x), 40)).slice(0, 20) : [];
  if (!url) return res.status(400).json({ error: "Lim inn en gyldig iCal-lenke (begynner med https:// eller webcal://)." });
  const count = await pool.query(`select count(*)::int n from feeds where family_id = $1`, [req.user.family_id]);
  if (count.rows[0].n >= 10) return res.status(400).json({ error: "Maks 10 kalenderabonnement per familie." });
  const { rows } = await pool.query(`insert into feeds (family_id, name, url, who) values ($1, $2, $3, $4) returning *`, [req.user.family_id, name, url, JSON.stringify(who)]);
  const r = await syncFeed(rows[0]);
  if (!r.ok) { await pool.query(`delete from feeds where id = $1`, [rows[0].id]); return res.status(400).json({ error: r.error }); }
  const f = await pool.query(`select * from feeds where id = $1`, [rows[0].id]);
  res.json({ feed: feedRow(f.rows[0]), count: r.count });
}));
app.post("/api/feeds/:id/sync", throttle(30, 60 * 60e3), wrap(auth), wrap(async (req, res) => {
  const { rows } = await pool.query(`select * from feeds where id::text = $1 and family_id = $2`, [clean(req.params.id, 60), req.user.family_id]);
  if (!rows[0]) return res.status(404).json({ error: "Fant ikke abonnementet." });
  const r = await syncFeed(rows[0]);
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json({ ok: true, count: r.count });
}));
app.delete("/api/feeds/:id", wrap(auth), wrap(async (req, res) => {
  const id = clean(req.params.id, 60);
  const { rows } = await pool.query(`delete from feeds where id::text = $1 and family_id = $2 returning id`, [id, req.user.family_id]);
  if (rows[0]) await pool.query(`delete from events where family_id = $1 and data->>'source' = $2`, [req.user.family_id, id]);
  res.json({ ok: true });
}));

// Synkroniser alle abonnement hvert 30. minutt
let feedsRunning = false;
async function syncAllFeeds() {
  if (feedsRunning) return; feedsRunning = true;
  try {
    const { rows } = await pool.query(`select * from feeds where last_sync is null or last_sync < now() - interval '25 minutes'`);
    for (const f of rows) await syncFeed(f);
  } catch (e) { console.error("Feed-synk", e.message); } finally { feedsRunning = false; }
}
setInterval(syncAllFeeds, 30 * 60e3);
setTimeout(syncAllFeeds, 20e3);

// Lokale filer for tekstgjenkjenning (OCR) i nettleseren
const vendorOpts = { maxAge: PROD ? "30d" : 0, immutable: PROD };
app.use("/vendor/tesseract", express.static(path.join(__dirname, "node_modules/tesseract.js/dist"), vendorOpts));
app.use("/vendor/tesseract-core", express.static(path.join(__dirname, "node_modules/tesseract.js-core"), vendorOpts));
app.use("/vendor/lang", express.static(path.join(__dirname, "node_modules/@tesseract.js-data/nor/4.0.0"), vendorOpts));

app.get("/healthz", (req, res) => res.send("ok"));

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: PROD ? "1h" : 0 }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Noe gikk galt på serveren. Prøv igjen." });
});

// Expired sessions/invites are cleaned up hourly
setInterval(() => {
  pool.query(`delete from sessions where expires_at < now(); delete from invites where expires_at < now() - interval '30 days'; delete from notes where data->>'date' < to_char(now() - interval '30 days', 'YYYY-MM-DD')`).catch(() => {});
}, 3600e3);

migrate()
  .then(() => app.listen(PORT, () => console.log(`Familielogistikk kjører på port ${PORT}`)))
  .catch((e) => { console.error("Klarte ikke å sette opp databasen:", e); process.exit(1); });
