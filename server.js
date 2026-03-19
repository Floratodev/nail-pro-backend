// ═══════════════════════════════════════════════════════════════════════════
//  NAIL PRO — SERVIDOR BACKEND v3
//  CORRECCIÓN: CORS configurado para Netlify
// ═══════════════════════════════════════════════════════════════════════════
require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const cloudinary = require("cloudinary").v2;
const multer     = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const Database   = require("better-sqlite3");
const fs         = require("fs");

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── CORS CONFIGURADO PARA NETLIFY ───────────────────────────────────────────
// Permite solicitudes desde Netlify y localhost en desarrollo
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://nail-pro-frontend.netlify.app',  // CAMBIA por tu URL de Netlify
  'https://*.netlify.app',
  '*'  // En producción, cambia esto por tu dominio específico
];

app.use(cors({
  origin: function(origin, callback) {
    // Permitir solicitudes sin origin (como móviles o curl)
    if (!origin) return callback(null, true);
    
    // Verificar si el origen está permitido
    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('netlify.app')) {
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

// ─── BASE DE DATOS SQLITE ────────────────────────────────────────────────────
const db = new Database("./nail_pro.db");
db.exec(`
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

// Migraciones
try { db.exec("ALTER TABLE appointments ADD COLUMN services_json TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE appointments ADD COLUMN total_duration INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE appointments ADD COLUMN inspiration_url TEXT DEFAULT ''"); } catch {}

// Servicios por defecto
const contadorServicios = db.prepare("SELECT COUNT(*) as n FROM services").get();
if (contadorServicios.n === 0) {
  const insertar = db.prepare("INSERT INTO services (name, duration, price, emoji, accent) VALUES (?, ?, ?, ?, ?)");
  [
    ["Manicure Clásica", 45, 15, "💅", "#c9956c"],
    ["Manicure Semipermanente", 60, 25, "✨", "#d4607a"],
    ["Nail Art", 90, 35, "🎨", "#9b7dd4"],
    ["Retiro de Gel", 30, 10, "🌸", "#6db89a"],
    ["Pedicure Completa", 60, 20, "🦶", "#6a9fd4"],
    ["Extensiones Acrílicas", 120, 45, "💎", "#d4b86a"],
  ].forEach(s => insertar.run(...s));
}

// Configuración del salón por defecto
const insertarConfig = db.prepare("INSERT OR IGNORE INTO salon_config (key, value) VALUES (?, ?)");
insertarConfig.run("name", "Nail Studio by Luna");
insertarConfig.run("tagline", "L'art de la beauté en vos mains");
insertarConfig.run("address", "Cardenal Spínola 68, Los Palacios y Villafranca");
insertarConfig.run("phone", "");
insertarConfig.run("whatsapp", "");
insertarConfig.run("instagram", "");

// ─── CLOUDINARY ──────────────────────────────────────────────────────────────
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
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

const uploadGaleria = multer({ storage: almacenamientoGaleria, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadInspiracion = multer({ storage: almacenamientoInspiracion, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadLocal = multer({ dest: "./uploads/", limits: { fileSize: 5 * 1024 * 1024 } });

if (!fs.existsSync("./uploads")) fs.mkdirSync("./uploads");

// ─── NODEMAILER ──────────────────────────────────────────────────────────────
const transportadorEmail = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

async function enviarEmail(destinatario, asunto, html) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log("📧 Email no configurado. Se enviaría a:", destinatario);
    return { omitido: true };
  }
  try {
    await transportadorEmail.sendMail({
      from: `"${process.env.SALON_NAME || "Nail Pro"}" <${process.env.EMAIL_USER}>`,
      to: destinatario, subject: asunto, html,
    });
    return { enviado: true };
  } catch (error) {
    console.error("❌ Error enviando email:", error.message);
    return { error: error.message };
  }
}

// ─── JWT MIDDLEWARE ──────────────────────────────────────────────────────────
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
  const finMin = inicioMin + duracionMinutos;
  return todosLosSlots.filter(slot => {
    const [sh, sm] = slot.split(":").map(Number);
    const slotMin = sh * 60 + sm;
    return slotMin >= inicioMin && slotMin < finMin;
  });
}

// ─── RUTAS ───────────────────────────────────────────────────────────────────
// Health check
app.get("/api/health", (req, res) => {
  res.json({ estado: "ok", timestamp: new Date().toISOString() });
});

// Autenticación
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  const usuarioCorrecto = process.env.ADMIN_USER || "admin";
  const contrasenaCorrecto = process.env.ADMIN_PASSWORD || "admin1234";
  
  if (username !== usuarioCorrecto || password !== contrasenaCorrecto) {
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

// Servicios
app.get("/api/services", (req, res) => {
  res.json(db.prepare("SELECT * FROM services WHERE active = 1 ORDER BY id").all());
});

app.post("/api/services", verificarToken, (req, res) => {
  const { name, duration, price, emoji, accent } = req.body;
  if (!name || !duration || price === undefined) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  const r = db.prepare("INSERT INTO services (name, duration, price, emoji, accent) VALUES (?, ?, ?, ?, ?)")
    .run(name, duration, price, emoji || "💅", accent || "#c9956c");
  res.status(201).json(db.prepare("SELECT * FROM services WHERE id = ?").get(r.lastInsertRowid));
});

app.put("/api/services/:id", verificarToken, (req, res) => {
  const { name, duration, price, emoji, accent } = req.body;
  db.prepare("UPDATE services SET name=?, duration=?, price=?, emoji=?, accent=? WHERE id=?")
    .run(name, duration, price, emoji, accent, req.params.id);
  res.json({ exito: true });
});

app.delete("/api/services/:id", verificarToken, (req, res) => {
  db.prepare("UPDATE services SET active=0 WHERE id=?").run(req.params.id);
  res.json({ exito: true });
});

// Citas
app.get("/api/appointments", verificarToken, (req, res) => {
  const { date, status } = req.query;
  let q = "SELECT * FROM appointments WHERE 1=1";
  const p = [];
  if (date) { q += " AND date = ?"; p.push(date); }
  if (status) { q += " AND status = ?"; p.push(status); }
  q += " ORDER BY date DESC, time ASC";
  res.json(db.prepare(q).all(...p));
});

app.get("/api/appointments/booked/:date", (req, res) => {
  const todosSlots = [
    "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
    "15:30", "16:00", "16:30", "17:00", "17:30", "18:00"
  ];
  const citasDelDia = db.prepare(
    "SELECT time, total_duration FROM appointments WHERE date=? AND status != 'cancelada'"
  ).all(req.params.date);
  const slotsOcupados = new Set();
  citasDelDia.forEach(cita => {
    calcularSlotsOcupados(cita.time, cita.total_duration || 60, todosSlots)
      .forEach(s => slotsOcupados.add(s));
  });
  res.json([...slotsOcupados]);
});

app.post("/api/appointments/upload-inspiration", (req, res, next) => {
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
  
  if (!clientName || !phone || !date || !time) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  
  const idsServicios = serviceIds || (serviceId ? [serviceId] : []);
  if (idsServicios.length === 0) {
    return res.status(400).json({ error: "Debes seleccionar al menos un servicio" });
  }
  
  const serviciosSeleccionados = idsServicios.map(id => {
    const svc = db.prepare("SELECT * FROM services WHERE id=? AND active=1").get(id);
    if (!svc) throw new Error(`Servicio ${id} no encontrado`);
    return svc;
  });
  
  const precioTotal = serviciosSeleccionados.reduce((sum, s) => sum + s.price, 0);
  const duracionTotal = serviciosSeleccionados.reduce((sum, s) => sum + s.duration, 0);
  const nombresServicios = serviciosSeleccionados.map(s => s.name).join(" + ");
  const emojisServicios = serviciosSeleccionados.map(s => s.emoji).join("");
  
  const todosSlots = [
    "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
    "15:30", "16:00", "16:30", "17:00", "17:30", "18:00"
  ];
  
  const citasDelDia = db.prepare(
    "SELECT time, total_duration FROM appointments WHERE date=? AND status != 'cancelada'"
  ).all(date);
  
  const slotsOcupados = new Set();
  citasDelDia.forEach(cita => {
    calcularSlotsOcupados(cita.time, cita.total_duration || 60, todosSlots)
      .forEach(s => slotsOcupados.add(s));
  });
  
  if (slotsOcupados.has(time)) {
    return res.status(409).json({ error: "Ese horario ya está ocupado. Por favor elige otro." });
  }
  
  const slotsNecesarios = calcularSlotsOcupados(time, duracionTotal, todosSlots);
  const hayConflicto = slotsNecesarios.some(s => s !== time && slotsOcupados.has(s));
  if (hayConflicto) {
    return res.status(409).json({ error: `No hay suficiente tiempo para ${duracionTotal} minutos. Elige otro horario.` });
  }
  
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  
  db.prepare(`INSERT INTO appointments (id, client_name, phone, services_json, service_id, service_name, service_price, service_emoji, total_duration, date, time, notes, inspiration_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, clientName, phone,
    JSON.stringify(serviciosSeleccionados),
    serviciosSeleccionados[0].id,
    nombresServicios, precioTotal, emojisServicios, duracionTotal,
    date, time, notes || "",
    inspirationUrl || ""
  );
  
  const cita = db.prepare("SELECT * FROM appointments WHERE id=?").get(id);
  const nombreSalon = db.prepare("SELECT value FROM salon_config WHERE key='name'").get()?.value;
  
  if (phone.includes("@")) {
    await enviarEmail(phone, `✅ Cita reservada — ${nombreSalon}`, plantillaEmail("reserva", cita, nombreSalon));
  }
  
  res.status(201).json(cita);
});

app.patch("/api/appointments/:id/status", verificarToken, async (req, res) => {
  const { status } = req.body;
  const estadosValidos = ["pendiente", "confirmada", "completada", "cancelada"];
  
  if (!estadosValidos.includes(status)) {
    return res.status(400).json({ error: `Estado inválido. Opciones: ${estadosValidos.join(", ")}` });
  }
  
  db.prepare("UPDATE appointments SET status=? WHERE id=?").run(status, req.params.id);
  const cita = db.prepare("SELECT * FROM appointments WHERE id=?").get(req.params.id);
  const nombreSalon = db.prepare("SELECT value FROM salon_config WHERE key='name'").get()?.value;
  
  if (cita && cita.phone.includes("@")) {
    if (status === "confirmada") {
      await enviarEmail(cita.phone, `✅ Tu cita está confirmada — ${nombreSalon}`, plantillaEmail("confirmacion", cita, nombreSalon));
    } else if (status === "cancelada") {
      await enviarEmail(cita.phone, `❌ Cita cancelada — ${nombreSalon}`, plantillaEmail("cancelacion", cita, nombreSalon));
    }
  }
  
  res.json(cita);
});

app.delete("/api/appointments/:id", verificarToken, (req, res) => {
  db.prepare("DELETE FROM appointments WHERE id=?").run(req.params.id);
  res.json({ exito: true });
});

// Galería
app.get("/api/gallery", (req, res) => {
  res.json(db.prepare("SELECT * FROM gallery ORDER BY created_at DESC").all());
});

app.post("/api/gallery/upload", verificarToken, (req, res, next) => {
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
    
    const r = db.prepare("INSERT INTO gallery (url, public_id, caption) VALUES (?, ?, ?)")
      .run(urlFinal, publicId, req.body.caption || "");
    res.status(201).json(db.prepare("SELECT * FROM gallery WHERE id=?").get(r.lastInsertRowid));
  });
});

app.post("/api/gallery/url", verificarToken, (req, res) => {
  const { url, caption } = req.body;
  if (!url) return res.status(400).json({ error: "La URL es obligatoria" });
  const r = db.prepare("INSERT INTO gallery (url, caption) VALUES (?, ?)").run(url, caption || "");
  res.status(201).json(db.prepare("SELECT * FROM gallery WHERE id=?").get(r.lastInsertRowid));
});

app.delete("/api/gallery/:id", verificarToken, async (req, res) => {
  const foto = db.prepare("SELECT * FROM gallery WHERE id=?").get(req.params.id);
  if (!foto) return res.status(404).json({ error: "Foto no encontrada" });
  if (foto.public_id && process.env.CLOUDINARY_CLOUD_NAME) {
    try { await cloudinary.uploader.destroy(foto.public_id); } catch {}
  }
  db.prepare("DELETE FROM gallery WHERE id=?").run(req.params.id);
  res.json({ exito: true });
});

// Salón
app.get("/api/salon", (req, res) => {
  const registros = db.prepare("SELECT * FROM salon_config").all();
  const config = {};
  registros.forEach(r => { config[r.key] = r.value; });
  res.json(config);
});

app.put("/api/salon", verificarToken, (req, res) => {
  const actualizar = db.prepare("INSERT OR REPLACE INTO salon_config (key, value) VALUES (?, ?)");
  ["name", "tagline", "address", "phone", "whatsapp", "instagram"].forEach(campo => {
    if (req.body[campo] !== undefined) actualizar.run(campo, req.body[campo]);
  });
  res.json({ exito: true });
});

// Estadísticas
app.get("/api/stats", verificarToken, (req, res) => {
  const totalIngresos = db.prepare("SELECT COALESCE(SUM(service_price),0) as total FROM appointments WHERE status='completada'").get().total;
  const totalClientes = db.prepare("SELECT COUNT(DISTINCT phone) as total FROM appointments").get().total;
  const porEstado = db.prepare("SELECT status, COUNT(*) as count FROM appointments GROUP BY status").all();
  const porMes = db.prepare(`SELECT strftime('%m-%Y', date) as month, COUNT(*) as citas, SUM(CASE WHEN status='completada' THEN service_price ELSE 0 END) as ingresos FROM appointments WHERE date >= date('now', '-6 months') GROUP BY month ORDER BY month`).all();
  const serviciosPopulares = db.prepare(`SELECT service_name as name, COUNT(*) as value FROM appointments WHERE status != 'cancelada' GROUP BY service_name ORDER BY value DESC LIMIT 8`).all();
  
  res.json({ 
    totalRevenue: totalIngresos, 
    totalClients: totalClientes, 
    byStatus: porEstado, 
    monthly: porMes, 
    popularServices: serviciosPopulares 
  });
});

// Plantillas de email
function plantillaEmail(tipo, cita, nombreSalon) {
  const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const d = new Date(cita.date);
  const fechaFormateada = `${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;
  
  const inicio = `<div style="font-family:'Georgia',serif;max-width:480px;margin:0 auto;background:#fff0f5;color:#3a1028;border-radius:16px;overflow:hidden;"><div style="background:linear-gradient(135deg,#c2567a,#e8729a);padding:32px;text-align:center;"><div style="font-size:48px;margin-bottom:8px;">💅</div><h1 style="color:#fff;font-size:22px;font-weight:300;margin:0;">${nombreSalon}</h1></div><div style="padding:32px;">`;
  const fin = `</div><div style="background:#ffe4ef;padding:16px;text-align:center;font-size:11px;color:#9a6070;">${nombreSalon} · Con amor desde el primer detalle 🌸</div></div>`;
  
  const fotoInspiracion = cita.inspiration_url
    ? `<div style="margin:16px 0;"><p style="color:#9a6070;font-size:12px;margin-bottom:8px;">FOTO DE INSPIRACIÓN:</p><img src="${cita.inspiration_url}" alt="Inspiración" style="width:100%;border-radius:12px;max-height:200px;object-fit:cover;border:1px solid rgba(194,86,122,0.2);"/></div>`
    : "";
  
  const detalles = `<div style="background:rgba(194,86,122,0.08);border:1px solid rgba(194,86,122,0.2);border-radius:12px;padding:20px;margin:20px 0;"><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);"><span style="color:#9a6070;font-size:12px;">SERVICIO</span><span style="color:#c2567a;">${cita.service_emoji} ${cita.service_name}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);"><span style="color:#9a6070;font-size:12px;">FECHA</span><span style="color:#3a1028;">${fechaFormateada}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(194,86,122,0.1);"><span style="color:#9a6070;font-size:12px;">HORA</span><span style="color:#3a1028;">${cita.time}</span></div><div style="display:flex;justify-content:space-between;padding:8px 0;"><span style="color:#9a6070;font-size:12px;">PRECIO</span><span style="color:#c2567a;font-size:18px;">${cita.service_price}€</span></div></div>${fotoInspiracion}`;
  
  const plantillas = {
    reserva: `${inicio}<h2 style="color:#c2567a;font-weight:300;font-size:26px;">¡Cita Reservada! 🎉</h2><p style="color:#9a6070;">Hola <strong style="color:#3a1028;">${cita.client_name}</strong>, hemos recibido tu reserva.</p>${detalles}<p style="color:#9a6070;font-size:13px;">En breve recibirás confirmación. Para cambios contáctanos.</p>${fin}`,
    confirmacion: `${inicio}<h2 style="color:#10b981;font-weight:300;font-size:26px;">¡Cita Confirmada! ✅</h2><p style="color:#9a6070;">Hola <strong style="color:#3a1028;">${cita.client_name}</strong>, tu cita está confirmada.</p>${detalles}<p style="color:#9a6070;font-size:13px;">¡Te esperamos puntual! 🌸</p>${fin}`,
    cancelacion: `${inicio}<h2 style="color:#ef4444;font-weight:300;font-size:26px;">Cita Cancelada</h2><p style="color:#9a6070;">Hola <strong style="color:#3a1028;">${cita.client_name}</strong>, tu cita ha sido cancelada.</p>${detalles}<p style="color:#9a6070;font-size:13px;">Puedes reservar de nuevo cuando quieras. ¡Seguimos aquí! 💕</p>${fin}`,
  };
  
  return plantillas[tipo] || plantillas.reserva;
}

// ─── INICIAR SERVIDOR ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════╗
║ 💅 NAIL PRO BACKEND v3 💅
║
║ Servidor: http://localhost:${PORT}
║ Base de datos: nail_pro.db
║ Estado: ✅ Listo
╚══════════════════════════════════════╝`);
});