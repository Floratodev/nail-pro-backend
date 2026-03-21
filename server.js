// ═══════════════════════════════════════════════════════════════════════════
//  NAIL PRO — SERVIDOR BACKEND v4
//  BASE DE DATOS: Turso (libsql) — persistente en la nube
// ═══════════════════════════════════════════════════════════════════════════
require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const jwt        = require("jsonwebtoken");
const { Resend } = require("resend");
const cloudinary = require("cloudinary").v2;
const multer     = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const { createClient } = require("@libsql/client");
const fs         = require("fs");

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://nail-pro-frontend.vercel.app',
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      console.log('❌ Origen no permitido:', origin);
      callback(new Error('No allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── BASE DE DATOS TURSO ─────────────────────────────────────────────────────
const db = createClient({
  url:       process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

// Helper: devuelve filas como array de objetos
function filas(result) {
  return result.rows.map(row => {
    const obj = {};
    result.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// Helper: devuelve la primera fila o null
function fila(result) {
  const arr = filas(result);
  return arr.length > 0 ? arr[0] : null;
}

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

  // Migraciones seguras
  for (const sql of [
    "ALTER TABLE appointments ADD COLUMN services_json TEXT DEFAULT '[]'",
    "ALTER TABLE appointments ADD COLUMN total_duration INTEGER DEFAULT 0",
    "ALTER TABLE appointments ADD COLUMN inspiration_url TEXT DEFAULT ''",
  ]) {
    try { await db.execute(sql); } catch {}
  }

  // Servicios por defecto
  const countSvc = fila(await db.execute("SELECT COUNT(*) as n FROM services"));
  if (!countSvc || Number(countSvc.n) === 0) {
    for (const [name, duration, price, emoji, accent] of [
      ["Manicure Clásica",        45,  15, "💅", "#c9956c"],
      ["Manicure Semipermanente", 60,  25, "✨", "#d4607a"],
      ["Nail Art",                90,  35, "🎨", "#9b7dd4"],
      ["Retiro de Gel",           30,  10, "🌸", "#6db89a"],
      ["Pedicure Completa",       60,  20, "🦶", "#6a9fd4"],
      ["Extensiones Acrílicas",  120,  45, "💎", "#d4b86a"],
    ]) {
      await db.execute({
        sql: "INSERT INTO services (name, duration, price, emoji, accent) VALUES (?, ?, ?, ?, ?)",
        args: [name, duration, price, emoji, accent],
      });
    }
  }

  // Config del salón por defecto
  for (const [key, value] of [
    ["name",      "Nail Studio by Flor"],
    ["tagline",   "L'art de la beauté en vos mains"],
    ["address",   "Cardenal Spínola 68, Los Palacios y Villafranca"],
    ["phone",     ""],
    ["whatsapp",  ""],
    ["instagram", ""],
  ]) {
    await db.execute({ sql: "INSERT OR IGNORE INTO salon_config (key, value) VALUES (?, ?)", args: [key, value] });
  }

  console.log("✅ Base de datos Turso lista");
}

// ─── CLOUDINARY ──────────────────────────────────────────────────────────────
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const almacenamientoGaleria = new CloudinaryStorage({
  cloudinary,
  params: { folder: "nail_pro/gallery", allowed_formats: ["jpg","jpeg","png","webp"] },
});
const almacenamientoInspiracion = new CloudinaryStorage({
  cloudinary,
  params: { folder: "nail_pro/inspiracion", allowed_formats: ["jpg","jpeg","png","webp"] },
});

const uploadGaleria     = multer({ storage: almacenamientoGaleria,     limits: { fileSize: 5 * 1024 * 1024 } });
const uploadInspiracion = multer({ storage: almacenamientoInspiracion, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadLocal       = multer({ dest: "./uploads/",                 limits: { fileSize: 5 * 1024 * 1024 } });

if (!fs.existsSync("./uploads")) fs.mkdirSync("./uploads");

// ─── RESEND (EMAIL) ──────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

async function enviarEmail(destinatario, asunto, html) {
  if (!process.env.RESEND_API_KEY) {
    console.log("📧 Resend no configurado. Se enviaría a:", destinatario);
    return { omitido: true };
  }
  try {
    await resend.emails.send({
      from: `${process.env.SALON_NAME || "Nail Pro"} <onboarding@resend.dev>`,
      to: destinatario,
      subject: asunto,
      html,
    });
    return { enviado: true };
  } catch (error) {
    console.error("❌ Error enviando email:", error.message);
    return { error: error.message };
  }
}

async function notificarAdmin(cita, nombreSalon) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;
  const html = `
    <div style="font-family:'Georgia',serif;max-width:480px;margin:0 auto;background:#fff0f5;color:#3a1028;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#c2567a,#e8729a);padding:24px;text-align:center;">
        <div style="font-size:40px;margin-bottom:6px;">💅</div>
        <h1 style="color:#fff;font-size:18px;font-weight:400;margin:0;">Nueva reserva — ${nombreSalon}</h1>
      </div>
      <div style="padding:24px;">
        <div style="background:rgba(194,86,122,0.08);border:1px solid rgba(194,86,122,0.2);border-radius:12px;padding:16px;">
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);">
            <span style="color:#9a6070;font-size:12px;">CLIENTA</span>
            <span style="font-weight:600;">${cita.client_name}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);">
            <span style="color:#9a6070;font-size:12px;">TELÉFONO</span>
            <span>${cita.phone}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);">
            <span style="color:#9a6070;font-size:12px;">SERVICIO</span>
            <span>${cita.service_emoji} ${cita.service_name}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);">
            <span style="color:#9a6070;font-size:12px;">FECHA</span>
            <span>${cita.date}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);">
            <span style="color:#9a6070;font-size:12px;">HORA</span>
            <span style="font-weight:600;font-size:18px;color:#c2567a;">${cita.time}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;">
            <span style="color:#9a6070;font-size:12px;">PRECIO</span>
            <span style="font-weight:600;color:#c2567a;">${cita.service_price}€</span>
          </div>
          ${cita.notes ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(194,86,122,0.1);font-size:13px;color:#9a6070;">📝 ${cita.notes}</div>` : ""}
        </div>
      </div>
    </div>
  `;
  await enviarEmail(adminEmail, `💅 Nueva cita — ${cita.client_name} · ${cita.date} ${cita.time}`, html);
}
function verificarToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token de acceso requerido" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "secreto_desarrollo");
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

// ─── HELPER: Calcular slots ocupados ─────────────────────────────────────────
function calcularSlotsOcupados(hora, duracionMinutos, todosLosSlots) {
  const [h, m] = hora.split(":").map(Number);
  const inicioMin = h * 60 + m;
  const finMin    = inicioMin + duracionMinutos;
  return todosLosSlots.filter(slot => {
    const [sh, sm] = slot.split(":").map(Number);
    const slotMin  = sh * 60 + sm;
    return slotMin >= inicioMin && slotMin < finMin;
  });
}

const TODOS_SLOTS = [
  "09:30","10:00","10:30","11:00","11:30","12:00","12:30",
  "15:30","16:00","16:30","17:00","17:30","18:00",
];

// ─── RUTAS ───────────────────────────────────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  res.json({ estado: "ok", timestamp: new Date().toISOString() });
});

// Autenticación
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (username !== (process.env.ADMIN_USER || "admin") ||
      password !== (process.env.ADMIN_PASSWORD || "admin1234")) {
    return res.status(401).json({ error: "Credenciales incorrectas" });
  }
  const token = jwt.sign(
    { username, rol: "admin" },
    process.env.JWT_SECRET || "secreto_desarrollo",
    { expiresIn: "24h" }
  );
  res.json({ token, username });
});

app.get("/api/auth/verify", verificarToken, (req, res) => {
  res.json({ valido: true, usuario: req.user });
});

// ── Servicios ────────────────────────────────────────────────────────────────
app.get("/api/services", async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM services WHERE active = 1 ORDER BY id");
    res.json(filas(result));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/services", verificarToken, async (req, res) => {
  const { name, duration, price, emoji, accent } = req.body;
  if (!name || !duration || price === undefined)
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  try {
    const r = await db.execute({
      sql:  "INSERT INTO services (name, duration, price, emoji, accent) VALUES (?, ?, ?, ?, ?)",
      args: [name, duration, price, emoji || "💅", accent || "#c9956c"],
    });
    const nuevo = fila(await db.execute({ sql: "SELECT * FROM services WHERE id = ?", args: [r.lastInsertRowid] }));
    res.status(201).json(nuevo);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/services/:id", verificarToken, async (req, res) => {
  const { name, duration, price, emoji, accent } = req.body;
  try {
    await db.execute({
      sql:  "UPDATE services SET name=?, duration=?, price=?, emoji=?, accent=? WHERE id=?",
      args: [name, duration, price, emoji, accent, req.params.id],
    });
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/services/:id", verificarToken, async (req, res) => {
  try {
    await db.execute({ sql: "UPDATE services SET active=0 WHERE id=?", args: [req.params.id] });
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Citas ────────────────────────────────────────────────────────────────────
app.get("/api/appointments", verificarToken, async (req, res) => {
  const { date, status } = req.query;
  let sql  = "SELECT * FROM appointments WHERE 1=1";
  const args = [];
  if (date)   { sql += " AND date = ?";   args.push(date); }
  if (status) { sql += " AND status = ?"; args.push(status); }
  sql += " ORDER BY date DESC, time ASC";
  try {
    const result = await db.execute({ sql, args });
    res.json(filas(result));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/appointments/booked/:date", async (req, res) => {
  try {
    const result = await db.execute({
      sql:  "SELECT time, total_duration FROM appointments WHERE date=? AND status != 'cancelada'",
      args: [req.params.date],
    });
    const citasDelDia   = filas(result);
    const slotsOcupados = new Set();
    citasDelDia.forEach(cita => {
      calcularSlotsOcupados(cita.time, cita.total_duration || 60, TODOS_SLOTS)
        .forEach(s => slotsOcupados.add(s));
    });
    res.json([...slotsOcupados]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/appointments/upload-inspiration", (req, res) => {
  const metodo = process.env.CLOUDINARY_CLOUD_NAME ? uploadInspiracion : uploadLocal;
  metodo.single("inspiration")(req, res, async (error) => {
    if (error) return res.status(400).json({ error: error.message });
    if (!req.file) return res.status(400).json({ error: "No se recibió ninguna imagen" });
    let urlFinal;
    if (process.env.CLOUDINARY_CLOUD_NAME) {
      urlFinal = req.file.path;
    } else {
      const buffer = fs.readFileSync(req.file.path);
      urlFinal = `data:${req.file.mimetype};base64,${buffer.toString("base64")}`;
      fs.unlinkSync(req.file.path);
    }
    res.status(201).json({ url: urlFinal });
  });
});

app.post("/api/appointments", async (req, res) => {
  const { clientName, phone, serviceIds, serviceId, date, time, notes, inspirationUrl } = req.body;

  if (!clientName || !phone || !date || !time)
    return res.status(400).json({ error: "Faltan campos obligatorios" });

  const idsServicios = serviceIds || (serviceId ? [serviceId] : []);
  if (idsServicios.length === 0)
    return res.status(400).json({ error: "Debes seleccionar al menos un servicio" });

  try {
    // Obtener servicios seleccionados
    const serviciosSeleccionados = [];
    for (const id of idsServicios) {
      const svc = fila(await db.execute({ sql: "SELECT * FROM services WHERE id=? AND active=1", args: [id] }));
      if (!svc) return res.status(400).json({ error: `Servicio ${id} no encontrado` });
      serviciosSeleccionados.push(svc);
    }

    const precioTotal    = serviciosSeleccionados.reduce((sum, s) => sum + Number(s.price), 0);
    const duracionTotal  = serviciosSeleccionados.reduce((sum, s) => sum + Number(s.duration), 0);
    const nombresServicios = serviciosSeleccionados.map(s => s.name).join(" + ");
    const emojisServicios  = serviciosSeleccionados.map(s => s.emoji).join("");

    // Verificar disponibilidad
    const citasResult = await db.execute({
      sql:  "SELECT time, total_duration FROM appointments WHERE date=? AND status != 'cancelada'",
      args: [date],
    });
    const citasDelDia   = filas(citasResult);
    const slotsOcupados = new Set();
    citasDelDia.forEach(cita => {
      calcularSlotsOcupados(cita.time, cita.total_duration || 60, TODOS_SLOTS)
        .forEach(s => slotsOcupados.add(s));
    });

    if (slotsOcupados.has(time))
      return res.status(409).json({ error: "Ese horario ya está ocupado. Por favor elige otro." });

    const slotsNecesarios = calcularSlotsOcupados(time, duracionTotal, TODOS_SLOTS);
    const hayConflicto    = slotsNecesarios.some(s => s !== time && slotsOcupados.has(s));
    if (hayConflicto)
      return res.status(409).json({ error: `No hay suficiente tiempo para ${duracionTotal} minutos. Elige otro horario.` });

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.execute({
      sql:  `INSERT INTO appointments (id, client_name, phone, services_json, service_id, service_name, service_price, service_emoji, total_duration, date, time, notes, inspiration_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, clientName, phone,
        JSON.stringify(serviciosSeleccionados),
        serviciosSeleccionados[0].id,
        nombresServicios, precioTotal, emojisServicios, duracionTotal,
        date, time, notes || "", inspirationUrl || "",
      ],
    });

    const cita       = fila(await db.execute({ sql: "SELECT * FROM appointments WHERE id=?", args: [id] }));
    const configNombre = fila(await db.execute("SELECT value FROM salon_config WHERE key='name'"));
    const nombreSalon  = configNombre?.value;

    // Notificar a la admin
    await notificarAdmin(cita, nombreSalon);

    if (phone.includes("@")) {
      await enviarEmail(phone, `✅ Cita reservada — ${nombreSalon}`, plantillaEmail("reserva", cita, nombreSalon));
    }

    res.status(201).json(cita);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/appointments/:id/status", verificarToken, async (req, res) => {
  const { status } = req.body;
  const estadosValidos = ["pendiente", "confirmada", "completada", "cancelada"];
  if (!estadosValidos.includes(status))
    return res.status(400).json({ error: `Estado inválido. Opciones: ${estadosValidos.join(", ")}` });

  try {
    await db.execute({ sql: "UPDATE appointments SET status=? WHERE id=?", args: [status, req.params.id] });
    const cita        = fila(await db.execute({ sql: "SELECT * FROM appointments WHERE id=?", args: [req.params.id] }));
    const configNombre = fila(await db.execute("SELECT value FROM salon_config WHERE key='name'"));
    const nombreSalon  = configNombre?.value;

    if (cita && cita.phone.includes("@")) {
      if (status === "confirmada")
        await enviarEmail(cita.phone, `✅ Tu cita está confirmada — ${nombreSalon}`, plantillaEmail("confirmacion", cita, nombreSalon));
      else if (status === "cancelada")
        await enviarEmail(cita.phone, `❌ Cita cancelada — ${nombreSalon}`, plantillaEmail("cancelacion", cita, nombreSalon));
    }

    res.json(cita);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/appointments/:id", verificarToken, async (req, res) => {
  try {
    await db.execute({ sql: "DELETE FROM appointments WHERE id=?", args: [req.params.id] });
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Galería ──────────────────────────────────────────────────────────────────
app.get("/api/gallery", async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM gallery ORDER BY created_at DESC");
    res.json(filas(result));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/gallery/upload", verificarToken, (req, res) => {
  const metodo = process.env.CLOUDINARY_CLOUD_NAME ? uploadGaleria : uploadLocal;
  metodo.single("image")(req, res, async (error) => {
    if (error) return res.status(400).json({ error: error.message });
    if (!req.file) return res.status(400).json({ error: "No se recibió ninguna imagen" });
    let urlFinal, publicId;
    if (process.env.CLOUDINARY_CLOUD_NAME) {
      urlFinal = req.file.path;
      publicId = req.file.filename;
    } else {
      const buffer = fs.readFileSync(req.file.path);
      urlFinal = `data:${req.file.mimetype};base64,${buffer.toString("base64")}`;
      fs.unlinkSync(req.file.path);
      publicId = null;
    }
    try {
      const r    = await db.execute({ sql: "INSERT INTO gallery (url, public_id, caption) VALUES (?, ?, ?)", args: [urlFinal, publicId, req.body.caption || ""] });
      const foto = fila(await db.execute({ sql: "SELECT * FROM gallery WHERE id=?", args: [r.lastInsertRowid] }));
      res.status(201).json(foto);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

app.post("/api/gallery/url", verificarToken, async (req, res) => {
  const { url, caption } = req.body;
  if (!url) return res.status(400).json({ error: "La URL es obligatoria" });
  try {
    const r    = await db.execute({ sql: "INSERT INTO gallery (url, caption) VALUES (?, ?)", args: [url, caption || ""] });
    const foto = fila(await db.execute({ sql: "SELECT * FROM gallery WHERE id=?", args: [r.lastInsertRowid] }));
    res.status(201).json(foto);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/gallery/:id", verificarToken, async (req, res) => {
  try {
    const foto = fila(await db.execute({ sql: "SELECT * FROM gallery WHERE id=?", args: [req.params.id] }));
    if (!foto) return res.status(404).json({ error: "Foto no encontrada" });
    if (foto.public_id && process.env.CLOUDINARY_CLOUD_NAME) {
      try { await cloudinary.uploader.destroy(foto.public_id); } catch {}
    }
    await db.execute({ sql: "DELETE FROM gallery WHERE id=?", args: [req.params.id] });
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Salón ────────────────────────────────────────────────────────────────────
app.get("/api/salon", async (req, res) => {
  try {
    const result   = await db.execute("SELECT * FROM salon_config");
    const registros = filas(result);
    const config   = {};
    registros.forEach(r => { config[r.key] = r.value; });
    res.json(config);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/salon", verificarToken, async (req, res) => {
  try {
    for (const campo of ["name","tagline","address","phone","whatsapp","instagram"]) {
      if (req.body[campo] !== undefined) {
        await db.execute({ sql: "INSERT OR REPLACE INTO salon_config (key, value) VALUES (?, ?)", args: [campo, req.body[campo]] });
      }
    }
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Notas de clientes ────────────────────────────────────────────────────────
app.get("/api/client-notes", verificarToken, async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM client_notes ORDER BY updated_at DESC");
    res.json(filas(result));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/client-notes/:phone", verificarToken, async (req, res) => {
  try {
    const result = await db.execute({ sql: "SELECT * FROM client_notes WHERE phone=? ORDER BY updated_at DESC", args: [decodeURIComponent(req.params.phone)] });
    res.json(filas(result));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/client-notes", verificarToken, async (req, res) => {
  const { phone, client_name, note } = req.body;
  if (!phone || !client_name || !note)
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  try {
    const r      = await db.execute({ sql: "INSERT INTO client_notes (phone, client_name, note) VALUES (?, ?, ?)", args: [phone, client_name, note] });
    const nueva  = fila(await db.execute({ sql: "SELECT * FROM client_notes WHERE id=?", args: [r.lastInsertRowid] }));
    res.status(201).json(nueva);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/client-notes/:id", verificarToken, async (req, res) => {
  const { note } = req.body;
  try {
    await db.execute({ sql: "UPDATE client_notes SET note=?, updated_at=datetime('now') WHERE id=?", args: [note, req.params.id] });
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/client-notes/:id", verificarToken, async (req, res) => {
  try {
    await db.execute({ sql: "DELETE FROM client_notes WHERE id=?", args: [req.params.id] });
    res.json({ exito: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Estadísticas ─────────────────────────────────────────────────────────────
app.get("/api/stats", verificarToken, async (req, res) => {
  try {
    const [ingresos, clientes, porEstado, porMes, populares] = await Promise.all([
      db.execute("SELECT COALESCE(SUM(service_price),0) as total FROM appointments WHERE status='completada'"),
      db.execute("SELECT COUNT(DISTINCT phone) as total FROM appointments"),
      db.execute("SELECT status, COUNT(*) as count FROM appointments GROUP BY status"),
      db.execute(`SELECT strftime('%m-%Y', date) as month, COUNT(*) as citas, SUM(CASE WHEN status='completada' THEN service_price ELSE 0 END) as ingresos FROM appointments WHERE date >= date('now', '-6 months') GROUP BY month ORDER BY month`),
      db.execute(`SELECT service_name as name, COUNT(*) as value FROM appointments WHERE status != 'cancelada' GROUP BY service_name ORDER BY value DESC LIMIT 8`),
    ]);
    res.json({
      totalRevenue:    Number(fila(ingresos)?.total || 0),
      totalClients:    Number(fila(clientes)?.total || 0),
      byStatus:        filas(porEstado),
      monthly:         filas(porMes),
      popularServices: filas(populares),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Plantillas de email ───────────────────────────────────────────────────────
function plantillaEmail(tipo, cita, nombreSalon) {
  const meses = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const d = new Date(cita.date);
  const fechaFormateada = `${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;

  const inicio = `<div style="font-family:'Georgia',serif;max-width:480px;margin:0 auto;background:#fff0f5;color:#3a1028;border-radius:16px;overflow:hidden;"><div style="background:linear-gradient(135deg,#c2567a,#e8729a);padding:32px;text-align:center;"><div style="font-size:48px;margin-bottom:8px;">💅</div><h1 style="color:#fff;font-size:22px;font-weight:300;margin:0;">${nombreSalon}</h1></div><div style="padding:32px;">`;
  const fin    = `</div><div style="background:#ffe4ef;padding:16px;text-align:center;font-size:11px;color:#9a6070;">${nombreSalon} · Con amor desde el primer detalle 🌸</div></div>`;

  const fotoInspiracion = cita.inspiration_url
    ? `<div style="margin:16px 0;"><p style="color:#9a6070;font-size:12px;margin-bottom:8px;">FOTO DE INSPIRACIÓN:</p><img src="${cita.inspiration_url}" alt="Inspiración" style="width:100%;border-radius:12px;max-height:200px;object-fit:cover;border:1px solid rgba(194,86,122,0.2);"/></div>`
    : "";

  const detalles = `<div style="background:rgba(194,86,122,0.08);border:1px solid rgba(194,86,122,0.2);border-radius:12px;padding:20px;margin:20px 0;"><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);"><span style="color:#9a6070;font-size:12px;">SERVICIO</span><span style="color:#c2567a;">${cita.service_emoji} ${cita.service_name}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);"><span style="color:#9a6070;font-size:12px;">FECHA</span><span style="color:#3a1028;">${fechaFormateada}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);"><span style="color:#9a6070;font-size:12px;">HORA</span><span style="color:#3a1028;">${cita.time}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="color:#9a6070;font-size:12px;">PRECIO</span><span style="color:#c2567a;font-size:18px;">${cita.service_price}€</span></div></div>${fotoInspiracion}`;

  const plantillas = {
    reserva:      `${inicio}<h2 style="color:#c2567a;font-weight:300;font-size:26px;">¡Cita Reservada! 🎉</h2><p style="color:#9a6070;">Hola <strong style="color:#3a1028;">${cita.client_name}</strong>, hemos recibido tu reserva.</p>${detalles}<p style="color:#9a6070;font-size:13px;">En breve recibirás confirmación. Para cambios contáctanos.</p>${fin}`,
    confirmacion: `${inicio}<h2 style="color:#10b981;font-weight:300;font-size:26px;">¡Cita Confirmada! ✅</h2><p style="color:#9a6070;">Hola <strong style="color:#3a1028;">${cita.client_name}</strong>, tu cita está confirmada.</p>${detalles}<p style="color:#9a6070;font-size:13px;">¡Te esperamos puntual! 🌸</p>${fin}`,
    cancelacion:  `${inicio}<h2 style="color:#ef4444;font-weight:300;font-size:26px;">Cita Cancelada</h2><p style="color:#9a6070;">Hola <strong style="color:#3a1028;">${cita.client_name}</strong>, tu cita ha sido cancelada.</p>${detalles}<p style="color:#9a6070;font-size:13px;">Puedes reservar de nuevo cuando quieras. ¡Seguimos aquí! 💕</p>${fin}`,
  };

  return plantillas[tipo] || plantillas.reserva;
}

// ─── INICIAR SERVIDOR ────────────────────────────────────────────────────────
inicializarDB().then(() => {
  app.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════╗
║ 💅 NAIL PRO BACKEND v4 (Turso) 💅
║
║ Servidor: http://localhost:${PORT}
║ Base de datos: Turso (nube) ☁️
║ Estado: ✅ Listo
╚══════════════════════════════════════╝`);
  });
}).catch(err => {
  console.error("❌ Error iniciando la base de datos:", err);
  process.exit(1);
});
