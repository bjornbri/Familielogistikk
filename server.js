// Familielogistikk – testversjon
// Express + Postgres. Innlogging med e-post og passord, én familie per konto,
// invitasjonslenker, felles avtaler og (valgfritt) bildelesing via Claude API.

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

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

app.get("/api/events", wrap(auth), wrap(async (req, res) => {
  const { rows } = await pool.query(`select id, data from events where family_id = $1`, [req.user.family_id]);
  res.json({ events: rows.map((r) => ({ id: r.id, ...r.data })) });
}));

app.put("/api/events/:id", wrap(auth), wrap(async (req, res) => {
  const id = clean(req.params.id, 60);
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

app.get("/healthz", (req, res) => res.send("ok"));

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: PROD ? "1h" : 0 }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Noe gikk galt på serveren. Prøv igjen." });
});

// Expired sessions/invites are cleaned up hourly
setInterval(() => {
  pool.query(`delete from sessions where expires_at < now(); delete from invites where expires_at < now() - interval '30 days'`).catch(() => {});
}, 3600e3);

migrate()
  .then(() => app.listen(PORT, () => console.log(`Familielogistikk kjører på port ${PORT}`)))
  .catch((e) => { console.error("Klarte ikke å sette opp databasen:", e); process.exit(1); });
