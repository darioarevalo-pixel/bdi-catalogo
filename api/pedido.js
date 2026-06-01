const KV_URL = process.env.KV_REST_API_URL || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;

const TTL_SECONDS = 90 * 24 * 60 * 60; // 90 días: pasado ese plazo el link se borra solo.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Normaliza el id para que la clave en KV sea siempre segura.
function clave(id) {
  return 'pedido:' + String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

async function kvCmd(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'Almacenamiento no configurado' });

  try {
    // Leer un pedido para mostrarlo en la página /pedido/<id>
    if (req.method === 'GET') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta el número de pedido' });
      const d = await kvCmd(['GET', clave(id)]);
      if (!d || !d.result) return res.status(404).json({ error: 'Pedido no encontrado o vencido' });
      return res.json(JSON.parse(d.result));
    }

    // Guardar un pedido cuando el cliente confirma
    if (req.method === 'POST') {
      const pedido = req.body || {};
      if (!pedido.id) return res.status(400).json({ error: 'Falta el número de pedido' });
      await kvCmd(['SET', clave(pedido.id), JSON.stringify(pedido), 'EX', String(TTL_SECONDS)]);
      return res.json({ ok: true });
    }

    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
