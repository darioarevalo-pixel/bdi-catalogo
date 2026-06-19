const KV_URL = process.env.KV_REST_API_URL || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bdi2024';
const CONFIG_KEY = process.env.CONFIG_KEY || 'catalog-config';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
};

const DEFAULT = { hiddenProducts: [], hiddenVariants: {}, categoryOrder: [], hideNoStock: false, minPurchase: 0, referencePrices: {} };

async function kvGet() {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${CONFIG_KEY}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}

async function kvSet(value) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV no configurado');
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', CONFIG_KEY, JSON.stringify(value)])
  });
  return r.json();
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    // Con ?verify=1 valida la contraseña y devuelve la config (para el login del admin)
    if (req.query.verify) {
      if (req.headers['x-admin-password'] !== ADMIN_PASSWORD)
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    try {
      const config = { ...DEFAULT, ...(await kvGet() || {}) };
      // Bandera de modo según el CONFIG_KEY del proyecto (no según el costo).
      // Así el catálogo no depende de que el token tenga permiso de costos.
      config.__esDistribuidor = (CONFIG_KEY === 'distribuidor-config');
      // Los códigos de cupón NO se exponen al público: solo el admin (verify con
      // contraseña correcta) los recibe. El catálogo valida vía /api/cupon.
      if (!req.query.verify) delete config.cupones;
      return res.json(config);
    } catch (e) {
      return res.json({ ...DEFAULT, __esDistribuidor: (CONFIG_KEY === 'distribuidor-config') });
    }
  }

  if (req.method === 'POST') {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD)
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    try {
      await kvSet(req.body);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).end();
};
