// ═══════════════════════════════════════════════════════════════════════════
//  NAIL PRO — SERVIDOR BACKEND v4 (Turso)
// ═══════════════════════════════════════════════════════════════════════════
require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const jwt        = require("jsonwebtoken");
const cloudinary = require("cloudinary").v2;
const multer     = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const { createClient } = require("@libsql/client");
const nodemailer = require("nodemailer");
const fs         = require("fs");

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: function(origin, callback) { callback(null, true); },
  credentials: true,
  methods: ["GET","POST","PUT","DELETE","PATCH","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const db = createClient({
  url:       process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

async function inicializarDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS appointments (
      id               TEXT PRIMARY KEY,
      client_name      TEXT NOT NULL,
      phone            TEXT NOT NULL,
      services_json    TEXT DEFAULT '[]',
      service_id       INTEGER,
      service_name     TEXT,
      service_price    REAL,
      service_emoji    TEXT,
      total_duration   INTEGER DEFAULT 0,
      date             TEXT NOT NULL,
      time             TEXT NOT NULL,
      notes            TEXT DEFAULT '',
      inspiration_url  TEXT DEFAULT '',
      status           TEXT DEFAULT 'pendiente',
      created_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS services (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,
      duration INTEGER NOT NULL,
      price    REAL NOT NULL,
      emoji    TEXT DEFAULT '💅',
      accent   TEXT DEFAULT '#c9956c',
      active   INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS gallery (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      url        TEXT NOT NULL,
      public_id  TEXT,
      caption    TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS salon_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS client_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT NOT NULL,
      client_name TEXT NOT NULL,
      note        TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  for (const sql of [
    "ALTER TABLE appointments ADD COLUMN services_json TEXT DEFAULT '[]'",
    "ALTER TABLE appointments ADD COLUMN total_duration INTEGER DEFAULT 0",
    "ALTER TABLE appointments ADD COLUMN inspiration_url TEXT DEFAULT ''",
  ]) { try { await db.execute(sql); } catch {} }

  const { rows } = await db.execute("SELECT COUNT(*) as n FROM services");
  if (Number(rows[0].n) === 0) {
    for (const [name, duration, price, emoji, accent] of [
      ["Manicure Clásica",        45,  15, "💅", "#c9956c"],
      ["Manicure Semipermanente", 60,  25, "✨", "#d4607a"],
      ["Nail Art",                90,  35, "🎨", "#9b7dd4"],
      ["Retiro de Gel",           30,  10, "🌸", "#6db89a"],
      ["Pedicure Completa",       60,  20, "🦶", "#6a9fd4"],
      ["Extensiones Acrílicas",  120,  45, "💎", "#d4b86a"],
    ]) {
      await db.execute({ sql: "INSERT INTO services (name,duration,price,emoji,accent) VALUES (?,?,?,?,?)", args: [name,duration,price,emoji,accent] });
    }
  }

  for (const [key, value] of [
    ["name",      "Nail Studio by Flor"],
    ["tagline",   "L'art de la beauté en vos mains"],
    ["address",   "Cardenal Spínola 68, Los Palacios y Villafranca"],
    ["phone",     ""],
    ["whatsapp",  ""],
    ["instagram", ""],
  ]) {
    await db.execute({ sql: "INSERT OR IGNORE INTO salon_config (key,value) VALUES (?,?)", args: [key,value] });
  }

  console.log("✅ Base de datos Turso lista");
}

if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const almacenamientoGaleria = new CloudinaryStorage({
  cloudinary,
  params: { folder: "nail_pro/gallery",     allowed_formats: ["jpg","jpeg","png","webp"] },
});
const almacenamientoInspiracion = new CloudinaryStorage({
  cloudinary,
  params: { folder: "nail_pro/inspiracion", allowed_formats: ["jpg","jpeg","png","webp"] },
});
const uploadGaleria     = multer({ storage: almacenamientoGaleria,     limits: { fileSize: 5*1024*1024 } });
const uploadInspiracion = multer({ storage: almacenamientoInspiracion, limits: { fileSize: 5*1024*1024 } });
const uploadLocal       = multer({ dest: "./uploads/",                 limits: { fileSize: 5*1024*1024 } });
if (!fs.existsSync("./uploads")) fs.mkdirSync("./uploads");

const transportadorEmail = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

async function enviarEmail(dest, asunto, html) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) { console.log("📧 Email no configurado"); return; }
  try { await transportadorEmail.sendMail({ from: `"Nail Pro" <${process.env.EMAIL_USER}>`, to: dest, subject: asunto, html }); }
  catch (e) { console.error("❌ Email error:", e.message); }
}

async function notificarAdmin(cita, nombreSalon) {
  if (!process.env.ADMIN_EMAIL) return;
  await enviarEmail(process.env.ADMIN_EMAIL, `💅 Nueva cita — ${cita.client_name}`,
    `<p>Nueva reserva de <strong>${cita.client_name}</strong></p><p>📅 ${cita.date} · ${cita.time}</p><p>💅 ${cita.service_name} — ${cita.service_price}€</p><p>📞 ${cita.phone}</p>`);
}

function verificarToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token requerido" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET || "secreto_desarrollo"); next(); }
  catch { res.status(401).json({ error: "Token inválido" }); }
}

const TODOS_SLOTS = ["09:30","10:00","10:30","11:00","11:30","12:00","12:30","15:30","16:00","16:30","17:00","17:30","18:00"];

function calcularSlotsOcupados(hora, durMin, slots) {
  const [h, m] = hora.split(":").map(Number);
  const ini = h*60+m, fin = ini+durMin;
  return slots.filter(s => { const [sh,sm] = s.split(":").map(Number); const t = sh*60+sm; return t >= ini && t < fin; });
}

app.get("/api/health", (req, res) => res.json({ estado: "ok", timestamp: new Date().toISOString() }));

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (username !== (process.env.ADMIN_USER||"admin") || password !== (process.env.ADMIN_PASSWORD||"admin1234"))
    return res.status(401).json({ error: "Credenciales incorrectas" });
  const token = jwt.sign({ username, rol: "admin" }, process.env.JWT_SECRET||"secreto_desarrollo", { expiresIn: "24h" });
  res.json({ token, username });
});
app.get("/api/auth/verify", verificarToken, (req, res) => res.json({ valido: true, usuario: req.user }));

app.get("/api/services", async (req, res) => {
  try { const { rows } = await db.execute("SELECT * FROM services WHERE active=1 ORDER BY id"); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/services", verificarToken, async (req, res) => {
  const { name, duration, price, emoji, accent } = req.body;
  if (!name || !duration || price===undefined) return res.status(400).json({ error: "Faltan campos" });
  try {
    const r = await db.execute({ sql: "INSERT INTO services (name,duration,price,emoji,accent) VALUES (?,?,?,?,?)", args: [name,duration,price,emoji||"💅",accent||"#c9956c"] });
    const { rows } = await db.execute({ sql: "SELECT * FROM services WHERE id=?", args: [r.lastInsertRowid] });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/services/:id", verificarToken, async (req, res) => {
  const { name, duration, price, emoji, accent } = req.body;
  try { await db.execute({ sql: "UPDATE services SET name=?,duration=?,price=?,emoji=?,accent=? WHERE id=?", args: [name,duration,price,emoji,accent,req.params.id] }); res.json({ exito: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/services/:id", verificarToken, async (req, res) => {
  try { await db.execute({ sql: "UPDATE services SET active=0 WHERE id=?", args: [req.params.id] }); res.json({ exito: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/appointments", verificarToken, async (req, res) => {
  const { date, status } = req.query;
  let sql = "SELECT * FROM appointments WHERE 1=1"; const args = [];
  if (date)   { sql += " AND date=?";   args.push(date); }
  if (status) { sql += " AND status=?"; args.push(status); }
  sql += " ORDER BY date DESC, time ASC";
  try { const { rows } = await db.execute({ sql, args }); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/appointments/booked/:date", async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: "SELECT time, total_duration FROM appointments WHERE date=? AND status!='cancelada'", args: [req.params.date] });
    const ocupados = new Set();
    rows.forEach(c => calcularSlotsOcupados(c.time, c.total_duration||60, TODOS_SLOTS).forEach(s => ocupados.add(s)));
    res.json([...ocupados]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/appointments/upload-inspiration", (req, res) => {
  const metodo = process.env.CLOUDINARY_CLOUD_NAME ? uploadInspiracion : uploadLocal;
  metodo.single("inspiration")(req, res, async (error) => {
    if (error) return res.status(400).json({ error: error.message });
    if (!req.file) return res.status(400).json({ error: "No se recibió imagen" });
    let url;
    if (process.env.CLOUDINARY_CLOUD_NAME) { url = req.file.path; }
    else { const buf = fs.readFileSync(req.file.path); url = `data:${req.file.mimetype};base64,${buf.toString("base64")}`; fs.unlinkSync(req.file.path); }
    res.status(201).json({ url });
  });
});

app.post("/api/appointments", async (req, res) => {
  const { clientName, phone, serviceIds, serviceId, date, time, notes, inspirationUrl } = req.body;
  if (!clientName || !phone || !date || !time) return res.status(400).json({ error: "Faltan campos" });
  const ids = serviceIds || (serviceId ? [serviceId] : []);
  if (!ids.length) return res.status(400).json({ error: "Selecciona al menos un servicio" });
  try {
    const svcs = [];
    for (const id of ids) {
      const { rows } = await db.execute({ sql: "SELECT * FROM services WHERE id=? AND active=1", args: [id] });
      if (!rows[0]) throw new Error(`Servicio ${id} no encontrado`);
      svcs.push(rows[0]);
    }
    const precio = svcs.reduce((s,v) => s+Number(v.price), 0);
    const dur    = svcs.reduce((s,v) => s+Number(v.duration), 0);
    const nombre = svcs.map(s=>s.name).join(" + ");
    const emoji  = svcs.map(s=>s.emoji).join("");
    const { rows: citasExist } = await db.execute({ sql: "SELECT time, total_duration FROM appointments WHERE date=? AND status!='cancelada'", args: [date] });
    const ocup = new Set();
    citasExist.forEach(c => calcularSlotsOcupados(c.time, c.total_duration||60, TODOS_SLOTS).forEach(s => ocup.add(s)));
    if (ocup.has(time)) return res.status(409).json({ error: "Ese horario ya está ocupado." });
    const necesarios = calcularSlotsOcupados(time, dur, TODOS_SLOTS);
    if (necesarios.some(s => s !== time && ocup.has(s))) return res.status(409).json({ error: `No hay suficiente tiempo para ${dur} minutos.` });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    await db.execute({
      sql: "INSERT INTO appointments (id,client_name,phone,services_json,service_id,service_name,service_price,service_emoji,total_duration,date,time,notes,inspiration_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [id,clientName,phone,JSON.stringify(svcs),svcs[0].id,nombre,precio,emoji,dur,date,time,notes||"",inspirationUrl||""],
    });
    const { rows } = await db.execute({ sql: "SELECT * FROM appointments WHERE id=?", args: [id] });
    const cita = rows[0];
    const { rows: cfg } = await db.execute("SELECT value FROM salon_config WHERE key='name'");
    const salonName = cfg[0]?.value;
    await notificarAdmin(cita, salonName);
    if (phone.includes("@")) await enviarEmail(phone, `✅ Cita reservada — ${salonName}`, plantillaEmail("reserva",cita,salonName));
    res.status(201).json(cita);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/appointments/:id", verificarToken, async (req, res) => {
  const { serviceIds, serviceName, servicePrice, serviceEmoji, totalDuration, servicesJson, date, time, notes } = req.body;
  try {
    let fn=serviceName, fp=servicePrice, fe=serviceEmoji, fd=totalDuration, fj=servicesJson;
    if (serviceIds?.length) {
      const svcs = [];
      for (const id of serviceIds) {
        const { rows } = await db.execute({ sql: "SELECT * FROM services WHERE id=? AND active=1", args: [id] });
        if (rows[0]) svcs.push(rows[0]);
      }
      if (svcs.length) { fn=svcs.map(s=>s.name).join(" + "); fp=svcs.reduce((s,v)=>s+Number(v.price),0); fe=svcs.map(s=>s.emoji).join(""); fd=svcs.reduce((s,v)=>s+Number(v.duration),0); fj=JSON.stringify(svcs); }
    }
    await db.execute({ sql: "UPDATE appointments SET service_id=?,service_name=?,service_price=?,service_emoji=?,total_duration=?,services_json=?,date=?,time=?,notes=? WHERE id=?", args: [serviceIds?.[0]||null,fn,fp,fe,fd,fj,date,time,notes||"",req.params.id] });
    const { rows } = await db.execute({ sql: "SELECT * FROM appointments WHERE id=?", args: [req.params.id] });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/appointments/:id/status", verificarToken, async (req, res) => {
  const { status } = req.body;
  if (!["pendiente","confirmada","completada","cancelada"].includes(status)) return res.status(400).json({ error: "Estado inválido" });
  try {
    await db.execute({ sql: "UPDATE appointments SET status=? WHERE id=?", args: [status,req.params.id] });
    const { rows } = await db.execute({ sql: "SELECT * FROM appointments WHERE id=?", args: [req.params.id] });
    const cita = rows[0];
    const { rows: cfg } = await db.execute("SELECT value FROM salon_config WHERE key='name'");
    const salonName = cfg[0]?.value;
    if (cita?.phone.includes("@")) {
      if (status==="confirmada") await enviarEmail(cita.phone, `✅ Cita confirmada — ${salonName}`, plantillaEmail("confirmacion",cita,salonName));
      if (status==="cancelada")  await enviarEmail(cita.phone, `❌ Cita cancelada — ${salonName}`,  plantillaEmail("cancelacion",cita,salonName));
    }
    res.json(cita);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/appointments/:id", verificarToken, async (req, res) => {
  try { await db.execute({ sql: "DELETE FROM appointments WHERE id=?", args: [req.params.id] }); res.json({ exito: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/gallery", async (req, res) => {
  try { const { rows } = await db.execute("SELECT * FROM gallery ORDER BY created_at DESC"); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/gallery/upload", verificarToken, (req, res) => {
  const metodo = process.env.CLOUDINARY_CLOUD_NAME ? uploadGaleria : uploadLocal;
  metodo.single("image")(req, res, async (error) => {
    if (error) return res.status(400).json({ error: error.message });
    if (!req.file) return res.status(400).json({ error: "No se recibió imagen" });
    let url, pid;
    if (process.env.CLOUDINARY_CLOUD_NAME) { url=req.file.path; pid=req.file.filename; }
    else { const buf=fs.readFileSync(req.file.path); url=`data:${req.file.mimetype};base64,${buf.toString("base64")}`; fs.unlinkSync(req.file.path); pid=null; }
    try {
      const r = await db.execute({ sql: "INSERT INTO gallery (url,public_id,caption) VALUES (?,?,?)", args: [url,pid,req.body.caption||""] });
      const { rows } = await db.execute({ sql: "SELECT * FROM gallery WHERE id=?", args: [r.lastInsertRowid] });
      res.status(201).json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});
app.post("/api/gallery/url", verificarToken, async (req, res) => {
  const { url, caption } = req.body;
  if (!url) return res.status(400).json({ error: "URL obligatoria" });
  try {
    const r = await db.execute({ sql: "INSERT INTO gallery (url,caption) VALUES (?,?)", args: [url,caption||""] });
    const { rows } = await db.execute({ sql: "SELECT * FROM gallery WHERE id=?", args: [r.lastInsertRowid] });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/gallery/:id", verificarToken, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: "SELECT * FROM gallery WHERE id=?", args: [req.params.id] });
    if (!rows[0]) return res.status(404).json({ error: "No encontrada" });
    if (rows[0].public_id && process.env.CLOUDINARY_CLOUD_NAME) try { await cloudinary.uploader.destroy(rows[0].public_id); } catch {}
    await db.execute({ sql: "DELETE FROM gallery WHERE id=?", args: [req.params.id] });
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/salon", async (req, res) => {
  try {
    const { rows } = await db.execute("SELECT * FROM salon_config");
    const config = {}; rows.forEach(r => { config[r.key] = r.value; });
    res.json(config);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/salon", verificarToken, async (req, res) => {
  try {
    for (const c of ["name","tagline","address","phone","whatsapp","instagram"]) {
      if (req.body[c] !== undefined) await db.execute({ sql: "INSERT OR REPLACE INTO salon_config (key,value) VALUES (?,?)", args: [c,req.body[c]] });
    }
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/client-notes", verificarToken, async (req, res) => {
  try { const { rows } = await db.execute("SELECT * FROM client_notes ORDER BY updated_at DESC"); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/client-notes/:phone", verificarToken, async (req, res) => {
  try { const { rows } = await db.execute({ sql: "SELECT * FROM client_notes WHERE phone=? ORDER BY updated_at DESC", args: [decodeURIComponent(req.params.phone)] }); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/client-notes", verificarToken, async (req, res) => {
  const { phone, client_name, note } = req.body;
  if (!phone || !client_name || !note) return res.status(400).json({ error: "Faltan campos" });
  try {
    const r = await db.execute({ sql: "INSERT INTO client_notes (phone,client_name,note) VALUES (?,?,?)", args: [phone,client_name,note] });
    const { rows } = await db.execute({ sql: "SELECT * FROM client_notes WHERE id=?", args: [r.lastInsertRowid] });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/client-notes/:id", verificarToken, async (req, res) => {
  try { await db.execute({ sql: "UPDATE client_notes SET note=?,updated_at=datetime('now') WHERE id=?", args: [req.body.note,req.params.id] }); res.json({ exito: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/client-notes/:id", verificarToken, async (req, res) => {
  try { await db.execute({ sql: "DELETE FROM client_notes WHERE id=?", args: [req.params.id] }); res.json({ exito: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats", verificarToken, async (req, res) => {
  try {
    const [r1,r2,r3,r4,r5] = await Promise.all([
      db.execute("SELECT COALESCE(SUM(service_price),0) as t FROM appointments WHERE status='completada'"),
      db.execute("SELECT COUNT(DISTINCT phone) as t FROM appointments"),
      db.execute("SELECT status, COUNT(*) as count FROM appointments GROUP BY status"),
      db.execute("SELECT strftime('%m-%Y',date) as month, COUNT(*) as citas, SUM(CASE WHEN status='completada' THEN service_price ELSE 0 END) as ingresos FROM appointments WHERE date>=date('now','-6 months') GROUP BY month ORDER BY month"),
      db.execute("SELECT service_name as name, COUNT(*) as value FROM appointments WHERE status!='cancelada' GROUP BY service_name ORDER BY value DESC LIMIT 8"),
    ]);
    res.json({ totalRevenue: Number(r1.rows[0].t), totalClients: Number(r2.rows[0].t), byStatus: r3.rows, monthly: r4.rows, popularServices: r5.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function plantillaEmail(tipo, cita, salon) {
  const meses=["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const d=new Date(cita.date), f=`${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;
  const ini=`<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;background:#fff0f5;color:#3a1028;border-radius:16px;overflow:hidden;"><div style="background:linear-gradient(135deg,#c2567a,#e8729a);padding:32px;text-align:center;"><div style="font-size:48px;">💅</div><h1 style="color:#fff;font-size:22px;font-weight:300;margin:0;">${salon}</h1></div><div style="padding:32px;">`;
  const fin=`</div><div style="background:#ffe4ef;padding:16px;text-align:center;font-size:11px;color:#9a6070;">${salon} · Con amor 🌸</div></div>`;
  const foto=cita.inspiration_url?`<div style="margin:16px 0;"><p style="color:#9a6070;font-size:12px;">FOTO DE INSPIRACIÓN:</p><img src="${cita.inspiration_url}" style="width:100%;border-radius:12px;max-height:200px;object-fit:cover;"/></div>`:"";
  const det=`<div style="background:rgba(194,86,122,.08);border:1px solid rgba(194,86,122,.2);border-radius:12px;padding:20px;margin:20px 0;"><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,.1);"><span style="color:#9a6070;font-size:12px;">SERVICIO</span><span style="color:#c2567a;">${cita.service_emoji} ${cita.service_name}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,.1);"><span style="color:#9a6070;font-size:12px;">FECHA</span><span>${f}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,.1);"><span style="color:#9a6070;font-size:12px;">HORA</span><span>${cita.time}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="color:#9a6070;font-size:12px;">PRECIO</span><span style="color:#c2567a;">${cita.service_price}€</span></div></div>${foto}`;
  const t={
    reserva:      `${ini}<h2 style="color:#c2567a;font-weight:300;">¡Cita Reservada! 🎉</h2><p>Hola <strong>${cita.client_name}</strong>, hemos recibido tu reserva.</p>${det}<p style="color:#9a6070;font-size:13px;">En breve recibirás confirmación.</p>${fin}`,
    confirmacion: `${ini}<h2 style="color:#10b981;font-weight:300;">¡Cita Confirmada! ✅</h2><p>Hola <strong>${cita.client_name}</strong>, tu cita está confirmada.</p>${det}<p style="color:#9a6070;font-size:13px;">¡Te esperamos puntual! 🌸</p>${fin}`,
    cancelacion:  `${ini}<h2 style="color:#ef4444;font-weight:300;">Cita Cancelada</h2><p>Hola <strong>${cita.client_name}</strong>, tu cita ha sido cancelada.</p>${det}<p style="color:#9a6070;font-size:13px;">Puedes reservar de nuevo cuando quieras. 💕</p>${fin}`,
  };
  return t[tipo]||t.reserva;
}

inicializarDB().then(() => {
  app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║  💅  NAIL PRO BACKEND v4 (Turso)    ║
  ║  Servidor: http://localhost:${PORT}     ║
  ║  Base de datos: Turso               ║
  ║  Estado: ✅ Listo                    ║
  ╚══════════════════════════════════════╝`);
  });
}).catch(err => {
  console.error("❌ Error al inicializar la BD:", err);
  process.exit(1);
});
