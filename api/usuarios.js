// Configuración de usuarios y permisos del monitor (guardada en el KV compartido).
// El login se valida ACÁ (server-side): las contraseñas nunca se descargan al navegador.
//
// GET                                     → config SIN contraseñas (para visibilidad/perfiles)
// POST {action:'login', user, pass}       → valida y devuelve { ok, perfil } (sin pass)
// POST {action:'login-google', token}     → ídem, pero identificando por el JWT del proveedor
// POST {action:'config', adminUser, adminPass | adminToken} → config COMPLETA (con pass), solo admin
// POST {adminUser, adminPass | adminToken, config}          → guarda la config, solo admin
//
// Quién es admin y cómo se traduce un token del proveedor a un usuario vive en _admin.js,
// compartido con ingresos.js y comisiones.js.
const { esAdmin, emailDelToken, usuarioPorEmail, usuarioPorPass, BOOTSTRAP } = require('./_admin');
const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const KEY = 'cfg:usuarios';

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
// `email` entra en la lista: el perfil viaja al browser con una lista FIJA de campos,
// así que un campo que no esté acá se guarda en el KV pero nunca llega al monitor.
const perfilDe = u => ({ name: u.name, admin: !!u.admin, cuenta: u.cuenta || null, acceso: u.acceso || { bdi: {}, zattia: {} }, funcion: Array.isArray(u.funcion) ? u.funcion : [], email: u.email || null });


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
        let u = usuarioPorPass(cfg, user, pass);
        if (!u && BOOTSTRAP[user] && BOOTSTRAP[user] === pass) u = { name: user, admin: true };
        if (!u) return res.status(200).json({ ok: false });
        return res.status(200).json({ ok: true, perfil: perfilDe(u) });
      }

      // Login con Google: la identidad la pone el proveedor, el acceso lo pone el KV.
      // Autenticar bien pero no tener fila acá NO es un error: es "no tenés acceso a
      // este sistema", y el monitor lo muestra como tal.
      if (action === 'login-google') {
        const email = await emailDelToken(body.token);
        if (!email) return res.status(200).json({ ok: false, error: 'token' });
        const cfg = await leerCfg();
        const u = usuarioPorEmail(cfg, email);
        if (!u) return res.status(200).json({ ok: false, error: 'sin-acceso', email });
        return res.status(200).json({ ok: true, perfil: perfilDe(u) });
      }

      // Config completa (con contraseñas) solo para administradores — pantalla de gestión
      if (action === 'config') {
        const cfg = await leerCfg();
        if (!(await esAdmin(body, cfg))) return res.status(403).json({ error: 'Necesitás ser administrador.' });
        return res.status(200).json({ ok: true, config: cfg });
      }

      // Guardar config (solo admin)
      const { config } = body;
      if (!config || !Array.isArray(config.users)) return res.status(400).json({ error: 'config inválida' });
      const actual = await leerCfg();
      if (!(await esAdmin(body, actual))) return res.status(403).json({ error: 'Necesitás ser administrador para guardar.' });
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
