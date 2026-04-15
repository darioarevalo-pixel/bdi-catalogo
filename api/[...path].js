const API_BASE = 'https://www.gestionnube.com/api/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-token',
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();

  const token = req.headers['x-api-token'];
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  const parts = Array.isArray(req.query.path) ? req.query.path : [req.query.path];
  const pathStr = '/' + parts.join('/');
  const qsObj = Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'path'));
  const qs = new URLSearchParams(qsObj);
  const url = API_BASE + pathStr + (qs.toString() ? '?' + qs.toString() : '');
  console.log('[proxy] url:', url);

  try {
    const opts = {
      method: req.method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    };
    if (req.body && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      opts.body = JSON.stringify(req.body);
    }
    const r = await fetch(url, opts);
    const data = await r.text();
    console.log('[proxy] status:', r.status);
    res.status(r.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
