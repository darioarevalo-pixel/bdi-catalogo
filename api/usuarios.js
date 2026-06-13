// Configuración de usuarios y permisos del monitor (guardada en el KV compartido).
// El login se valida ACÁ (server-side): las contraseñas nunca se descargan al navegador.
//
// GET                                  → config SIN contraseñas (para visibilidad/perfiles)
// POST {action:'login', user, pass}    → valida y devuelve { ok, perfil:{name,admin,cuenta,acceso} } (sin pass)
// POST {action:'config', adminUser, adminPass} → config COMPLETA (con pass) solo si es admin (pantalla de gestión)
// POST {adminUser, adminPass, config}  → guarda la config (solo admin)
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
async function leerCfg() {
  const raw = await kvCmd(['GET', KEY]);
  return raw ? JSON.parse(raw) : null;
}
const perfilDe = u => ({ name: u.name, admin: !!u.admin, cuenta: u.cuenta || null, acceso: u.acceso || { bdi: {}, zattia: {} } });
function esAdminValido(cfg, user, pass) {
  if (cfg && Array.isArray(cfg.users)) return cfg.users.some(u => u.admin && u.name === user && u.pass === pass);
  return BOOTSTRAP[user] && BOOTSTRAP[user] === pass;
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV no configurado' });

  try {
    if (req.method === 'GET') {
      // Config SIN contraseñas (para construir la visibilidad de quien está logueado)
      const cfg = await leerCfg();
      const safe = cfg ? { ...cfg, users: (cfg.users || []).map(({ pass, ...u }) => u) } : null;
      return res.status(200).json({ ok: true, config: safe });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = body.action;

      // Login: validación server-side, no devuelve contraseñas
      if (action === 'login') {
        const { user, pass } = body;
        const cfg = await leerCfg();
        let u = null;
        if (cfg && Array.isArray(cfg.users)) u = cfg.users.find(x => x.name === user && x.pass === pass);
        if (!u && BOOTSTRAP[user] && BOOTSTRAP[user] === pass) u = { name: user, admin: true };
        if (!u) return res.status(200).json({ ok: false });
        return res.status(200).json({ ok: true, perfil: perfilDe(u) });
      }

      // Config completa (con contraseñas) solo para administradores — pantalla de gestión
      if (action === 'config') {
        const cfg = await leerCfg();
        if (!esAdminValido(cfg, body.adminUser, body.adminPass)) return res.status(403).json({ error: 'Necesitás ser administrador.' });
        return res.status(200).json({ ok: true, config: cfg });
      }

      // Guardar config (solo admin)
      const { adminUser, adminPass, config } = body;
      if (!config || !Array.isArray(config.users)) return res.status(400).json({ error: 'config inválida' });
      const actual = await leerCfg();
      if (!esAdminValido(actual, adminUser, adminPass)) return res.status(403).json({ error: 'Necesitás ser administrador para guardar.' });
      if (!config.users.some(u => u.admin)) return res.status(400).json({ error: 'Tiene que quedar al menos un administrador.' });
      config.updatedAt = Date.now();
      await kvCmd(['SET', KEY, JSON.stringify(config)]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
