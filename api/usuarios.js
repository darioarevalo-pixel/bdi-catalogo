// Configuración de usuarios y permisos del monitor (guardada en el KV compartido).
// GET                         → devuelve la config { users, updatedAt } (o null si nunca se guardó)
// POST {adminUser, adminPass, config} → valida que sea un admin y guarda la config
//
// Seguridad acorde a la herramienta (interna): para guardar hay que ser un admin válido.
// La primera vez (sin config previa) se acepta a los admins de arranque (BOOTSTRAP).
const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const KEY = 'cfg:usuarios';
const BOOTSTRAP = { 'Bruno Arevalo': 'BDI123456', 'Dario Arevalo': 'BDI123456' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function kvCmd(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const d = await r.json();
  return d.result;
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV no configurado' });

  try {
    if (req.method === 'GET') {
      const raw = await kvCmd(['GET', KEY]);
      return res.status(200).json({ ok: true, config: raw ? JSON.parse(raw) : null });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { adminUser, adminPass, config } = body;
      if (!config || !Array.isArray(config.users)) return res.status(400).json({ error: 'config inválida' });

      // Validar admin contra la config actual; si no hay, contra los admins de arranque
      const raw = await kvCmd(['GET', KEY]);
      const actual = raw ? JSON.parse(raw) : null;
      let esAdmin = false;
      if (actual && Array.isArray(actual.users)) {
        esAdmin = actual.users.some(u => u.admin && u.name === adminUser && u.pass === adminPass);
      } else {
        esAdmin = BOOTSTRAP[adminUser] && BOOTSTRAP[adminUser] === adminPass;
      }
      if (!esAdmin) return res.status(403).json({ error: 'Necesitás ser administrador para guardar.' });

      // Seguridad: que no quede la config sin ningún admin (evita lockout)
      if (!config.users.some(u => u.admin)) return res.status(400).json({ error: 'Tiene que quedar al menos un administrador.' });

      config.updatedAt = Date.now();
      await kvCmd(['SET', KEY, JSON.stringify(config)]);
      return res.status(200).json({ ok: true, config });
    }

    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
