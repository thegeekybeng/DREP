"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const crypto   = require("crypto");
const fs       = require("fs");
const os       = require("os");
const helmet        = require("helmet");
const { rateLimit } = require("express-rate-limit");
const validator     = require("validator");
const winston       = require("winston");

// ─── Logger ───────────────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, "data", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const logger = winston.createLogger({
  level: "info",
  defaultMeta: { service: "drep" },
  transports: [
    ...(process.env.NODE_ENV !== "production"
      ? [new winston.transports.Console({ format: winston.format.simple() })]
      : []),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "app.log"),
      format: winston.format.json(),
      maxsize: 10485760,
      maxFiles: 5,
      tailable: true
    })
  ]
});

// ─── Validation helpers ───────────────────────────────────────────────────────
function stripHtml(s) { return String(s || "").replace(/<[^>]*>/g, "").trim(); }
function vErr(res, details) { return res.status(422).json({ error: "Validation failed", details }); }
function validateHeroUrl(url) {
  if (!url) return null;
  if (!url.startsWith("https://")) return "Hero URL must use https://";
  const b = url.slice(8);
  const ok = ["drive.google.com/uc?export=view&id=", "i.imgur.com/", "imgur.com/"];
  if (!ok.some(p => b.startsWith(p))) return "Hero image must be from Google Drive or Imgur";
  return null;
}

// ─── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter   = rateLimit({ windowMs:15*60*1000, max:20,  message:{error:"Too many attempts. Please try again in 15 minutes."}, standardHeaders:true, legacyHeaders:false, skip:()=>false });
const apiLimiter    = rateLimit({ windowMs:60*1000,    max:120, message:{error:"Request rate exceeded. Please slow down."},           standardHeaders:true, legacyHeaders:false, skip:()=>false });
const shareLimiter  = rateLimit({ windowMs:60*1000,    max:30,  standardHeaders:true, legacyHeaders:false, skip:()=>false });
const backupLimiter = rateLimit({ windowMs:60*60*1000, max:5,   message:{error:"Max 5 backup downloads per hour."},                  standardHeaders:true, legacyHeaders:false, skip:()=>false });

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = "7d";
const BCRYPT_ROUNDS = 12;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("FATAL: JWT_SECRET must be set in .env and be at least 32 characters.");
  process.exit(1);
}
if (!process.env.GUEST_PIN) {
  console.error("FATAL: GUEST_PIN must be set in .env");
  process.exit(1);
}
if (!process.env.OWNER_SEED_PASSWORD || process.env.OWNER_SEED_PASSWORD.length < 8) {
  console.error("FATAL: OWNER_SEED_PASSWORD must be set in .env (min 8 chars). Used only on first boot to seed the owner account.");
  process.exit(1);
}
if (!process.env.OWNER_EMAIL) {
  console.error("FATAL: OWNER_EMAIL must be set in .env — used to seed the owner account on first boot.");
  process.exit(1);
}

const OWNER_EMAIL = process.env.OWNER_EMAIL;
const OWNER_NAME  = process.env.OWNER_NAME || "Registry Owner";

// ─── Database setup ───────────────────────────────────────────────────────────

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "data", "registry.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance with atomic writes
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = -32000");
db.pragma("temp_store = MEMORY");

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      email        TEXT NOT NULL UNIQUE,
      password     TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'pending',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      activated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS members (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      initials     TEXT NOT NULL,
      generation   INTEGER NOT NULL,
      relation     TEXT NOT NULL,
      notes        TEXT,
      avatar_color TEXT NOT NULL DEFAULT 'blue'
    );

    CREATE TABLE IF NOT EXISTS member_tags (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id    INTEGER NOT NULL REFERENCES members(id),
      type         TEXT NOT NULL,
      value        TEXT NOT NULL,
      pending      INTEGER NOT NULL DEFAULT 0,
      submitted_by INTEGER REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL,
      event_date   TEXT NOT NULL,
      event_time   TEXT NOT NULL,
      location     TEXT NOT NULL,
      details      TEXT,
      diet_notes   TEXT,
      pending      INTEGER NOT NULL DEFAULT 0,
      submitted_by INTEGER REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_member_tags_member_id ON member_tags(member_id);
    CREATE INDEX IF NOT EXISTS idx_member_tags_pending   ON member_tags(pending);
    CREATE INDEX IF NOT EXISTS idx_events_pending        ON events(pending);
    CREATE INDEX IF NOT EXISTS idx_users_email           ON users(email);
  `);

  // Safe migrations — add new columns if they don't exist yet
  const migrations = [
    "ALTER TABLE events ADD COLUMN hero_image_url TEXT",
    "ALTER TABLE events ADD COLUMN share_token TEXT",
    "ALTER TABLE events ADD COLUMN share_diet_enabled INTEGER DEFAULT 0",
    "ALTER TABLE events ADD COLUMN share_token_created_at TEXT",
    "ALTER TABLE users  ADD COLUMN last_password_change TEXT",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch (err) {
      // "duplicate column name" is expected on re-runs — anything else is a real error
      if (!err.message.includes("duplicate column name")) {
        logger.error("migration.unexpected_error", { sql, message: err.message });
      }
    }
  }
}


function seedData(ownerPasswordHash) {
  // Seed owner account only — all members and events are added via the admin panel
  // Email and display name are sourced from OWNER_EMAIL / OWNER_NAME env vars (never hardcoded)
  const ownerExists = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(OWNER_EMAIL);
  if (!ownerExists) {
    db.prepare(
      "INSERT INTO users (name, email, password, role, activated_at) VALUES (?, ?, ?, 'owner', datetime('now'))",
    ).run(OWNER_NAME, OWNER_EMAIL, ownerPasswordHash);
    console.log("[seed] Owner account created.");
  }
}

// ─── Role hierarchy ───────────────────────────────────────────────────────────

const ROLE_RANK = { owner: 5, admin: 4, member: 3, guest: 2, pending: 1 };

function roleAtLeast(role, minRole) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(minRole) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No token provided" });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    if (!payload.role || (payload.role !== "guest" && (payload.userId == null || typeof payload.userId !== "number"))) {
      return res.status(401).json({ error: "Invalid token structure" });
    }

    if (payload.role === "pending" && minRole !== "pending") {
      return res.status(403).json({ error: "Account pending approval" });
    }

    if (!roleAtLeast(payload.role, minRole)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // Reject tokens issued before last password change
    if (payload.userId && payload.role !== "guest") {
      const u = db.prepare("SELECT last_password_change FROM users WHERE id = ?").get(payload.userId);
      if (u && u.last_password_change) {
        const ct = Math.floor(new Date(u.last_password_change).getTime() / 1000);
        if (payload.iat < ct) return res.status(401).json({ error: "Session expired. Please sign in again." });
      }
    }

    req.user = payload;
    next();
  };
}

// Soft auth: attaches user if token present and valid, never blocks
function softAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
      req.user = null;
    }
  }
  next();
}

// ─── App bootstrap ────────────────────────────────────────────────────────────

async function bootstrap() {
  // Hash owner seed password and guest PIN at startup (never stored plain)
  // OWNER_SEED_PASSWORD is used only when creating the owner account for the first time.
  const [ownerPasswordHash, guestPinHash, DUMMY_HASH] = await Promise.all([
    bcrypt.hash(process.env.OWNER_SEED_PASSWORD, BCRYPT_ROUNDS),
    bcrypt.hash(process.env.GUEST_PIN, BCRYPT_ROUNDS),
    bcrypt.hash("dummy-timing-prevention", BCRYPT_ROUNDS),
  ]);

  // Store guest PIN hash in memory only — never written to DB or logs
  const GUEST_PIN_HASH = guestPinHash;

  initSchema();
  seedData(ownerPasswordHash);

  const app = express();
  app.set("trust proxy", 1);

  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc:["'self'"], scriptSrc:["'self'"], styleSrc:["'self'","'unsafe-inline'"],
      imgSrc:["'self'","data:","drive.google.com","i.imgur.com","*.imgur.com"],
      connectSrc:["'self'"], fontSrc:["'self'"], objectSrc:["'none'"],
      frameAncestors:["'none'"], baseUri:["'self'"], formAction:["'self'"]
    }},
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge:31536000, includeSubDomains:true, preload:true }
  }));
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.use(apiLimiter);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // ── Auth routes ─────────────────────────────────────────────────────────────

  // POST /api/auth/guest
  app.post("/api/auth/guest", authLimiter, async (req, res) => {
    const { guestPin } = req.body;
    if (!guestPin) return res.status(400).json({ error: "guestPin required" });
    const match = await bcrypt.compare(guestPin, GUEST_PIN_HASH);
    if (!match) {
      logger.info("auth.guest_fail", { ip: req.ip, timestamp: new Date().toISOString() });
      return res.status(401).json({ error: "Invalid guest password" });
    }
    logger.info("auth.guest_success", { ip: req.ip, timestamp: new Date().toISOString() });
    const token = jwt.sign(
      { userId: null, email: null, role: "guest", name: "Family Guest" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: JWT_EXPIRY },
    );
    res.json({ token, role: "guest", name: "Family Guest" });
  });

  // POST /api/auth/register
  app.post("/api/auth/register", authLimiter, async (req, res) => {
    const errs = [];
    const cleanName = ((req.body.name) || "").trim();
    const rawEmail  = ((req.body.email) || "").trim();
    const password  = req.body.password || "";
    if (!cleanName) errs.push({ field:"name", message:"Name is required" });
    if (cleanName.length > 100) errs.push({ field:"name", message:"Name max 100 chars" });
    if (!rawEmail || !validator.isEmail(rawEmail)) errs.push({ field:"email", message:"Valid email required" });
    if (rawEmail.length > 254) errs.push({ field:"email", message:"Email too long" });
    if (!password || password.length < 8) errs.push({ field:"password", message:"Password min 8 chars" });
    if (password.length > 128) errs.push({ field:"password", message:"Password max 128 chars" });
    if (errs.length) return vErr(res, errs);

    const cleanEmail = validator.normalizeEmail(rawEmail) || rawEmail.toLowerCase();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(cleanEmail);
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const row = db.prepare(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'pending')",
    ).run(cleanName, cleanEmail, hash);
    logger.info("auth.register", { userId: row.lastInsertRowid, email: cleanEmail, ip: req.ip, timestamp: new Date().toISOString() });
    res.status(201).json({ message: "Registration submitted. A family admin will activate your account." });
  });

  // POST /api/auth/login
  app.post("/api/auth/login", authLimiter, async (req, res) => {
    const rawEmail = ((req.body.email) || "").trim();
    const password  = req.body.password || "";
    if (!rawEmail || !validator.isEmail(rawEmail) || !password)
      return res.status(400).json({ error: "email and password required" });
    if (password.length > 128) return vErr(res, [{ field:"password", message:"Too long" }]);

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(rawEmail);
    // Always run bcrypt — prevents user-enumeration via response timing
    const match = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !match) {
      logger.info("auth.login_fail", { email_attempted: rawEmail, ip: req.ip, timestamp: new Date().toISOString() });
      return res.status(401).json({ error: "Invalid email or password" });
    }
    logger.info("auth.login_success", { userId: user.id, email: user.email, ip: req.ip, timestamp: new Date().toISOString() });
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: JWT_EXPIRY },
    );
    res.json({ token, role: user.role, name: user.name, userId: user.id });
  });

  // GET /api/auth/me
  app.get("/api/auth/me", requireAuth("pending"), (req, res) => {
    const user = db
      .prepare(
        "SELECT id, name, email, role, created_at, activated_at FROM users WHERE id = ?",
      )
      .get(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  });

  // PATCH /api/auth/me
  app.patch("/api/auth/me", requireAuth("pending"), (req, res) => {
    const errs = [];
    const rawName  = ((req.body.name)  || "").trim();
    const rawEmail = ((req.body.email) || "").trim();
    if (!rawName && !rawEmail)
      return res.status(400).json({ error: "Provide name or email to update" });
    if (rawName && rawName.length > 100) errs.push({ field: "name", message: "Name max 100 chars" });
    if (rawEmail && !validator.isEmail(rawEmail)) errs.push({ field: "email", message: "Valid email required" });
    if (rawEmail && rawEmail.length > 254) errs.push({ field: "email", message: "Email too long" });
    if (errs.length) return vErr(res, errs);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const newName    = rawName || user.name;
    const cleanEmail = rawEmail ? (validator.normalizeEmail(rawEmail) || rawEmail.toLowerCase()) : user.email;

    if (rawEmail && cleanEmail !== user.email) {
      const conflict = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(cleanEmail, user.id);
      if (conflict) return res.status(409).json({ error: "Email already in use" });
    }

    db.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").run(newName, cleanEmail, user.id);
    res.json({ message: "Profile updated" });
  });

  // POST /api/auth/change-password
  app.post(
    "/api/auth/change-password",
    requireAuth("pending"),
    async (req, res) => {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword)
        return res.status(400).json({ error: "currentPassword and newPassword required" });
      if (newPassword.length < 8)
        return res.status(400).json({ error: "New password must be at least 8 characters" });
      if (newPassword.length > 128)
        return res.status(422).json({ error: "New password max 128 chars" });
      if (newPassword === currentPassword)
        return res.status(400).json({ error: "New password must be different from current password" });

      const user = db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(req.user.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match)
        return res.status(401).json({ error: "Current password incorrect" });

      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      db.prepare("UPDATE users SET password = ?, last_password_change = datetime('now') WHERE id = ?").run(hash, user.id);
      res.json({ message: "Password changed successfully" });
    },
  );

  // ── Member routes ───────────────────────────────────────────────────────────

  // GET /api/members
  app.get("/api/members", requireAuth("guest"), (req, res) => {
    const isAdminPlus = roleAtLeast(req.user.role, "admin");
    const members = db
      .prepare("SELECT * FROM members ORDER BY generation, id")
      .all();

    const result = members.map((m) => {
      // Admin+ see all tags (including pending); others see approved only
      const tagSql = isAdminPlus
        ? "SELECT * FROM member_tags WHERE member_id = ? ORDER BY type, id"
        : "SELECT * FROM member_tags WHERE member_id = ? AND pending = 0 ORDER BY type, id";
      const tags = db.prepare(tagSql).all(m.id);
      return { ...m, tags };
    });

    res.json(result);
  });

  // POST /api/members/:id/updates  (member+ only)
  app.post("/api/members/:id/updates", requireAuth("member"), (req, res) => {
    if (req.user.role === "guest")
      return res.status(403).json({ error: "Guests cannot submit updates" });

    const memberId = parseInt(req.params.id);
    const member = db
      .prepare("SELECT id FROM members WHERE id = ?")
      .get(memberId);
    if (!member) return res.status(404).json({ error: "Member not found" });

    const { type, value, notes } = req.body;
    const validTypes = ["restriction", "allergy", "preference", "clinical"];
    if (!type || !validTypes.includes(type))
      return res.status(400).json({ error: "type must be one of: restriction, allergy, preference, clinical" });

    // Strip HTML from user-supplied text fields
    const cleanValue = stripHtml(value);
    const cleanNotes = notes ? stripHtml(notes) : null;
    if (!cleanValue) return res.status(400).json({ error: "value is required" });
    if (cleanValue.length > 200) return res.status(422).json({ error: "value max 200 chars" });

    const tagValue = cleanNotes ? `${cleanValue} — ${cleanNotes}` : cleanValue;
    const row = db
      .prepare(
        "INSERT INTO member_tags (member_id, type, value, pending, submitted_by) VALUES (?, ?, ?, 1, ?)",
      )
      .run(memberId, type, tagValue, req.user.userId);

    res.status(201).json({
      id: row.lastInsertRowid,
      member_id: memberId,
      type,
      value: tagValue,
      pending: 1,
      submitted_by: req.user.userId,
    });
  });

  // ── Event routes ─────────────────────────────────────────────────────────────

  // GET /api/events
  app.get("/api/events", softAuth, (req, res) => {
    if (!req.user) {
      // Unauthenticated: type field only, no pending
      const events = db
        .prepare(
          "SELECT id, type FROM events WHERE pending = 0 ORDER BY event_date",
        )
        .all();
      return res.json(events);
    }
    // Authenticated: admin+ get full data; others get has_share_link boolean (not the token)
    const isAdmin = roleAtLeast(req.user.role, "admin");
    const events = isAdmin
      ? db.prepare("SELECT * FROM events ORDER BY event_date").all()
      : db.prepare(
          "SELECT id, type, event_date, event_time, location, details, diet_notes, hero_image_url, pending, submitted_by, created_at, (CASE WHEN share_token IS NOT NULL THEN 1 ELSE 0 END) as has_share_link FROM events ORDER BY event_date",
        ).all();
    res.json(events);
  });

  // POST /api/events  (member+ only)
  app.post("/api/events", requireAuth("member"), (req, res) => {
    if (req.user.role === "guest")
      return res.status(403).json({ error: "Guests cannot submit events" });

    const {
      type,
      event_date,
      event_time,
      location,
      details,
      diet_notes,
      hero_image_url,
    } = req.body;
    if (!type || !event_date || !event_time || !location)
      return res.status(400).json({ error: "type, event_date, event_time, and location are required" });

    if (hero_image_url) {
      const urlErr = validateHeroUrl(hero_image_url);
      if (urlErr) return res.status(422).json({ error: urlErr });
    }

    const row = db
      .prepare(
        "INSERT INTO events (type, event_date, event_time, location, details, diet_notes, hero_image_url, pending, submitted_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
      )
      .run(
        type, event_date, event_time, location,
        details || null, diet_notes || null, hero_image_url || null,
        req.user.userId,
      );

    res.status(201).json({
      id: row.lastInsertRowid,
      type, event_date, event_time, location,
      details: details || null,
      diet_notes: diet_notes || null,
      hero_image_url: hero_image_url || null,
      pending: 1,
      submitted_by: req.user.userId,
    });
  });

  // ── Admin routes ─────────────────────────────────────────────────────────────

  // GET /api/admin/backup — safe online backup, owner only
  app.get("/api/admin/backup", backupLimiter, requireAuth("owner"), async (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `drep-backup-${stamp}.db`;
    const tmpPath = path.join(os.tmpdir(), `fdr-${Date.now()}.db`);
    try {
      await db.backup(tmpPath);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "application/octet-stream");
      const stream = fs.createReadStream(tmpPath);
      stream.pipe(res);
      stream.on("end", () => fs.unlink(tmpPath, () => {}));
      stream.on("error", () => { fs.unlink(tmpPath, () => {}); if (!res.headersSent) res.status(500).json({ error: "Backup failed" }); });
      logger.info("admin.backup_download", { userId: req.user.userId, ip: req.ip, timestamp: new Date().toISOString() });
    } catch { fs.unlink(tmpPath, () => {}); res.status(500).json({ error: "Backup failed" }); }
  });

  // GET /api/admin/users
  app.get("/api/admin/users", requireAuth("admin"), (req, res) => {
    const users = db
      .prepare(
        "SELECT id, name, email, role, created_at, activated_at FROM users ORDER BY created_at",
      )
      .all();
    res.json(users);
  });

  // ── Member management (admin+) ────────────────────────────────────────────

  // POST /api/admin/members
  app.post("/api/admin/members", requireAuth("admin"), (req, res) => {
    const { name, initials, generation, relation, notes, avatar_color } =
      req.body;
    if (!name || !initials || !generation || !relation) {
      return res
        .status(400)
        .json({
          error: "name, initials, generation, and relation are required",
        });
    }
    const validColors = [
      "blue",
      "purple",
      "teal",
      "pink",
      "coral",
      "green",
      "amber",
    ];
    const color = validColors.includes(avatar_color) ? avatar_color : "blue";
    const row = db
      .prepare(
        "INSERT INTO members (name, initials, generation, relation, notes, avatar_color) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        name.trim(),
        initials.trim().toUpperCase(),
        parseInt(generation),
        relation.trim(),
        notes?.trim() || null,
        color,
      );
    res
      .status(201)
      .json(
        db
          .prepare("SELECT * FROM members WHERE id = ?")
          .get(row.lastInsertRowid),
      );
  });

  // PATCH /api/admin/members/:id
  app.patch("/api/admin/members/:id", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const member = db.prepare("SELECT * FROM members WHERE id = ?").get(id);
    if (!member) return res.status(404).json({ error: "Member not found" });
    const { name, initials, generation, relation, notes, avatar_color } =
      req.body;
    const validColors = [
      "blue",
      "purple",
      "teal",
      "pink",
      "coral",
      "green",
      "amber",
    ];
    db.prepare(
      `UPDATE members SET
      name         = COALESCE(?, name),
      initials     = COALESCE(?, initials),
      generation   = COALESCE(?, generation),
      relation     = COALESCE(?, relation),
      notes        = COALESCE(?, notes),
      avatar_color = COALESCE(?, avatar_color)
      WHERE id = ?`,
    ).run(
      name?.trim() || null,
      initials?.trim().toUpperCase() || null,
      generation ? parseInt(generation) : null,
      relation?.trim() || null,
      notes !== undefined ? notes?.trim() || null : undefined,
      avatar_color && validColors.includes(avatar_color) ? avatar_color : null,
      id,
    );
    res.json(db.prepare("SELECT * FROM members WHERE id = ?").get(id));
  });

  // DELETE /api/admin/members/:id
  app.delete("/api/admin/members/:id", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const member = db.prepare("SELECT * FROM members WHERE id = ?").get(id);
    if (!member) return res.status(404).json({ error: "Member not found" });
    db.prepare("DELETE FROM member_tags WHERE member_id = ?").run(id);
    db.prepare("DELETE FROM members WHERE id = ?").run(id);
    res.json({ message: "Member and all their tags removed" });
  });

  // PATCH /api/admin/users/:id
  app.patch("/api/admin/users/:id", requireAuth("admin"), (req, res) => {
    const targetId = parseInt(req.params.id);
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId);
    if (!target) return res.status(404).json({ error: "User not found" });

    // Cannot modify owner
    if (target.role === "owner")
      return res
        .status(403)
        .json({ error: "Owner account cannot be modified" });
    // Cannot self-modify role
    if (targetId === req.user.userId)
      return res
        .status(403)
        .json({ error: "Cannot modify your own account here" });

    const { role, activated } = req.body;

    if (role !== undefined) {
      const allowedRoles = ["member", "pending"];
      // Only owner can promote to admin or demote from admin
      if (role === "admin" || target.role === "admin") {
        if (req.user.role !== "owner") {
          return res
            .status(403)
            .json({ error: "Only the owner can assign or remove admin role" });
        }
        allowedRoles.push("admin");
      }
      if (!allowedRoles.includes(role)) {
        return res
          .status(400)
          .json({ error: `Invalid role. Allowed: ${allowedRoles.join(", ")}` });
      }
      // Two explicit statements — no SQL fragment interpolation
      if (role === "member" || role === "admin") {
        db.prepare("UPDATE users SET role = ?, activated_at = datetime('now') WHERE id = ?").run(role, targetId);
      } else {
        db.prepare("UPDATE users SET role = ?, activated_at = NULL WHERE id = ?").run(role, targetId);
      }
    }

    if (activated === false) {
      db.prepare(
        "UPDATE users SET role = 'pending', activated_at = NULL WHERE id = ?",
      ).run(targetId);
    }

    const updated = db
      .prepare(
        "SELECT id, name, email, role, created_at, activated_at FROM users WHERE id = ?",
      )
      .get(targetId);
    res.json(updated);
  });

  // GET /api/admin/pending
  app.get("/api/admin/pending", requireAuth("admin"), (req, res) => {
    const tags = db
      .prepare(
        `
      SELECT mt.*, m.name as member_name, u.name as submitted_by_name
      FROM member_tags mt
      JOIN members m ON m.id = mt.member_id
      LEFT JOIN users u ON u.id = mt.submitted_by
      WHERE mt.pending = 1
      ORDER BY mt.created_at
    `,
      )
      .all();

    const events = db
      .prepare(
        `
      SELECT e.*, u.name as submitted_by_name
      FROM events e
      LEFT JOIN users u ON u.id = e.submitted_by
      WHERE e.pending = 1
      ORDER BY e.created_at
    `,
      )
      .all();

    res.json({ tags, events });
  });

  // POST /api/admin/tags/:id/approve
  app.post("/api/admin/tags/:id/approve", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const tag = db
      .prepare("SELECT * FROM member_tags WHERE id = ? AND pending = 1")
      .get(id);
    if (!tag) return res.status(404).json({ error: "Pending tag not found" });
    db.prepare("UPDATE member_tags SET pending = 0 WHERE id = ?").run(id);
    res.json({ message: "Tag approved" });
  });

  // POST /api/admin/tags/:id/reject
  app.post("/api/admin/tags/:id/reject", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const tag = db
      .prepare("SELECT * FROM member_tags WHERE id = ? AND pending = 1")
      .get(id);
    if (!tag) return res.status(404).json({ error: "Pending tag not found" });
    db.prepare("DELETE FROM member_tags WHERE id = ?").run(id);
    res.json({ message: "Tag rejected and removed" });
  });

  // PATCH /api/admin/tags/:id  — edit value and/or type of any tag
  app.patch("/api/admin/tags/:id", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const tag = db.prepare("SELECT * FROM member_tags WHERE id = ?").get(id);
    if (!tag) return res.status(404).json({ error: "Tag not found" });

    const { type, value } = req.body;
    const validTypes = ["restriction", "allergy", "preference", "clinical"];
    if (type && !validTypes.includes(type)) {
      return res
        .status(400)
        .json({
          error:
            "type must be one of: restriction, allergy, preference, clinical",
        });
    }
    if (value !== undefined && !value.trim()) {
      return res.status(400).json({ error: "value cannot be empty" });
    }

    const newType = type || tag.type;
    const newValue = value ? value.trim() : tag.value;
    db.prepare(
      "UPDATE member_tags SET type = ?, value = ?, pending = 0 WHERE id = ?",
    ).run(newType, newValue, id);
    res.json({ message: "Tag updated", id, type: newType, value: newValue });
  });

  // DELETE /api/admin/tags/:id  — remove any tag immediately
  app.delete("/api/admin/tags/:id", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const tag = db.prepare("SELECT * FROM member_tags WHERE id = ?").get(id);
    if (!tag) return res.status(404).json({ error: "Tag not found" });
    db.prepare("DELETE FROM member_tags WHERE id = ?").run(id);
    res.json({ message: "Tag removed" });
  });

  // POST /api/admin/events/:id/approve
  app.post(
    "/api/admin/events/:id/approve",
    requireAuth("admin"),
    (req, res) => {
      const id = parseInt(req.params.id);
      const event = db
        .prepare("SELECT * FROM events WHERE id = ? AND pending = 1")
        .get(id);
      if (!event)
        return res.status(404).json({ error: "Pending event not found" });
      db.prepare("UPDATE events SET pending = 0 WHERE id = ?").run(id);
      res.json({ message: "Event approved" });
    },
  );

  // POST /api/admin/events/:id/reject
  app.post("/api/admin/events/:id/reject", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const event = db
      .prepare("SELECT * FROM events WHERE id = ? AND pending = 1")
      .get(id);
    if (!event)
      return res.status(404).json({ error: "Pending event not found" });
    db.prepare("DELETE FROM events WHERE id = ?").run(id);
    res.json({ message: "Event rejected and removed" });
  });

  // PATCH /api/admin/events/:id — edit any event field directly
  app.patch("/api/admin/events/:id", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const {
      type,
      event_date,
      event_time,
      location,
      details,
      diet_notes,
      hero_image_url,
    } = req.body;

    if (hero_image_url) {
      const urlErr = validateHeroUrl(hero_image_url);
      if (urlErr) return res.status(422).json({ error: urlErr });
    }

    db.prepare(
      `
      UPDATE events SET
        type          = COALESCE(?, type),
        event_date    = COALESCE(?, event_date),
        event_time    = COALESCE(?, event_time),
        location      = COALESCE(?, location),
        details       = COALESCE(?, details),
        diet_notes    = COALESCE(?, diet_notes),
        hero_image_url = COALESCE(?, hero_image_url),
        pending       = 0
      WHERE id = ?`,
    ).run(
      type || null, event_date || null, event_time || null, location || null,
      details || null, diet_notes || null, hero_image_url || null, id,
    );

    res.json(db.prepare("SELECT * FROM events WHERE id = ?").get(id));
  });

  // POST /api/events/:id/share — generate or update share link (admin+)
  app.post("/api/events/:id/share", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const diet = req.body.diet ? 1 : 0;
    const token = (event.share_token && event.share_token.length === 64)
      ? event.share_token
      : crypto.randomBytes(32).toString("hex");
    db.prepare(
      "UPDATE events SET share_token = ?, share_diet_enabled = ?, share_token_created_at = COALESCE(share_token_created_at, datetime('now')) WHERE id = ?",
    ).run(token, diet, id);
    res.json({ token, url: `/share/${token}`, diet });
  });

  // DELETE /api/events/:id/share — revoke share link (admin+)
  app.delete("/api/events/:id/share", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    db.prepare(
      "UPDATE events SET share_token = NULL, share_token_created_at = NULL, share_diet_enabled = 0 WHERE id = ?",
    ).run(id);
    logger.info("share.link_revoked", { adminId: req.user.userId, eventId: id, timestamp: new Date().toISOString() });
    res.json({ message: "Share link revoked" });
  });

  // GET /share/:token — public share page (no auth)
  app.get("/share/:token", shareLimiter, (req, res) => {
    const provided = req.params.token;
    if (!/^[0-9a-f]{64}$/i.test(provided))
      return res.status(404).send("<h2>This link is no longer valid.</h2>");

    const event = db.prepare("SELECT * FROM events WHERE share_token = ?").get(provided);
    if (!event || !event.share_token)
      return res.status(404).send("<h2>This link is no longer valid.</h2>");

    try {
      const a = Buffer.from(event.share_token, "hex");
      const b = Buffer.from(provided, "hex");
      if (a.length !== 32 || b.length !== 32 || !crypto.timingSafeEqual(a, b))
        return res.status(404).send("<h2>This link is no longer valid.</h2>");
    } catch { return res.status(404).send("<h2>This link is no longer valid.</h2>"); }

    if (event.share_token_created_at) {
      const ts = event.share_token_created_at;
      const created = new Date(ts.endsWith("Z") ? ts : ts + " UTC");
      if (Date.now() - created.getTime() > 90 * 24 * 60 * 60 * 1000) {
        db.prepare("UPDATE events SET share_token = NULL, share_token_created_at = NULL WHERE id = ?").run(event.id);
        return res.status(410).send("<h2>This link has expired.</h2>");
      }
    }

    logger.info("share.link_accessed", { eventId: event.id, ip: req.ip, timestamp: new Date().toISOString() });


    const fmt = (d, t) => {
      const dt = new Date(`${d}T${t}`);
      return (
        dt.toLocaleDateString("en-SG", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }) +
        " at " +
        dt.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })
      );
    };

    // Dietary: aggregate counts by type only — no individual values, no PII
    let dietHtml = "";
    if (event.share_diet_enabled) {
      const counts = db.prepare(
        "SELECT type, COUNT(*) as cnt FROM member_tags WHERE pending = 0 GROUP BY type ORDER BY type"
      ).all();
      if (counts.length) {
        const icons = { allergy: "\u26a0\ufe0f", restriction: "\uD83D\uDEAB", preference: "\uD83C\uDF3F", clinical: "\uD83D\uDC8A" };
        dietHtml = `<div class="sp-diet"><h3>Dietary Overview</h3><ul>` +
          counts.map(r => `<li><span class="sp-tag sp-tag-${r.type}">${icons[r.type] || ""} ${r.type}</span> ${r.cnt} member${r.cnt > 1 ? "s" : ""}</li>`).join("") +
          `</ul></div>`;
      }
    }

    const heroHtml = event.hero_image_url
      ? `<div class="sp-hero"><img src="${escHtml(event.hero_image_url)}" alt="${escHtml(event.type)}"/></div>`
      : `<div class="sp-hero sp-hero-gradient"></div>`;

    function escHtml(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(event.type)} — Family Event</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#f4f5f7;color:#1a1d23;min-height:100vh}
.sp-wrap{max-width:520px;margin:0 auto;padding:1rem 1rem 3rem}
.sp-card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1);margin-top:1.5rem}
.sp-hero{height:200px;background:linear-gradient(135deg,#4f46e5,#7c3aed);overflow:hidden}
.sp-hero img{width:100%;height:100%;object-fit:cover}
.sp-hero-gradient{background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%)}
.sp-hero.sp-hero-error{background:linear-gradient(135deg,#4f46e5,#7c3aed)}
.sp-body{padding:1.5rem}
.sp-title{font-size:1.4rem;font-weight:800;margin-bottom:1rem}
.sp-meta{display:flex;flex-direction:column;gap:.5rem;margin-bottom:1rem}
.sp-meta-row{display:flex;align-items:center;gap:.5rem;font-size:14px;color:#6b7280}
.sp-meta-row strong{color:#1a1d23}
.sp-details{font-size:14px;line-height:1.6;margin-bottom:.75rem;padding:.75rem;background:#f9fafb;border-radius:8px}
.sp-diet-notes{font-size:13px;color:#16a34a;font-weight:500;margin-bottom:.75rem}
.sp-diet{margin-top:1rem;padding:1rem;background:#fef9ec;border:1px solid #fde68a;border-radius:8px}
.sp-diet h3{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#92400e;margin-bottom:.6rem}
.sp-diet ul{list-style:none;display:flex;flex-direction:column;gap:.35rem}
.sp-diet li{font-size:13px;display:flex;align-items:center;gap:.5rem}
.sp-tag{font-size:11px;font-weight:600;padding:.15rem .45rem;border-radius:20px}
.sp-tag-allergy{background:#fee2e2;color:#991b1b}
.sp-tag-restriction{background:#fef3c7;color:#92400e}
.sp-tag-preference{background:#dcfce7;color:#14532d}
.sp-tag-clinical{background:#f3f4f6;color:#374151}
.sp-footer{text-align:center;margin-top:1.5rem;font-size:12px;color:#9ca3af}
</style></head><body>
<div class="sp-wrap">
  ${heroHtml}
  <div class="sp-card">
    <div class="sp-body">
      <h1 class="sp-title">${escHtml(event.type)}</h1>
      <div class="sp-meta">
        <div class="sp-meta-row">📅 <strong>${escHtml(fmt(event.event_date, event.event_time))}</strong></div>
        <div class="sp-meta-row">📍 <strong>${escHtml(event.location)}</strong></div>
      </div>
      ${event.details ? `<div class="sp-details">${escHtml(event.details)}</div>` : ""}
      ${event.diet_notes ? `<div class="sp-diet-notes">🥗 ${escHtml(event.diet_notes)}</div>` : ""}
      ${dietHtml}
    </div>
  </div>
  <div class="sp-footer">🍜 DREP</div>
</div>
</body></html>`);
  });

  // DELETE /api/admin/events/:id — remove any event immediately
  app.delete("/api/admin/events/:id", requireAuth("admin"), (req, res) => {
    const id = parseInt(req.params.id);
    const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
    if (!event) return res.status(404).json({ error: "Event not found" });
    db.prepare("DELETE FROM events WHERE id = ?").run(id);
    res.json({ message: "Event deleted" });
  });

  // ── SPA fallback (excludes /share/ which is handled above) ─────────────────
  app.get(/^(?!\/share\/).*$/, (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.listen(PORT, () => {
    logger.info(`[server] DREP running on port ${PORT}`);
  });

  // Global error handler — must be last middleware (4-arg signature required)
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.error("error.unhandled", { message: err.message, stack: err.stack, timestamp: new Date().toISOString() });
    if (!res.headersSent) res.status(500).json({ error: "An unexpected error occurred." });
  });
}

process.on("uncaughtException", (err) => {
  try { logger.error("error.unhandled", { message: err.message, stack: err.stack }); } catch { console.error(err); }
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  try { logger.error("error.unhandled", { message: String(reason) }); } catch { console.error(reason); }
  process.exit(1);
});

bootstrap().catch((err) => {
  console.error("[fatal]", err.message);
  process.exit(1);
});
