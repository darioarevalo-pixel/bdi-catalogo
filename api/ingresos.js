// Ingresos proyectados (importaciones por llegar) — compartido en el KV, por marca.
// GET  ?store=bdi|zattia            → { ok, ingresos: [...] }
// POST {store, ingresos, adminUser, adminPass} → guarda (solo administradores)
//
// También sirve la config de REPOSICIÓN (vía rewrite /api/reposicion → ?kind=reposicion),
// para no superar el límite de 12 funciones del plan. La reposición es baja sensibilidad
// (mínimos + apagados) → guardado directo sin contraseña.
// GET  ?kind=reposicion&store=...           → { ok, config: {mins, apagados, defaultMin, reservaDeposito} }
// POST ?kind=reposicion {store, config}     → guarda (sin contraseña)
//
// También sirve los teléfonos del CRM (?kind=crmtel) y el seguimiento del CRM
// (?kind=crmseg → mapa id_cliente -> { cadencia, ultimo_contacto, proximo_manual, notas }).
const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const BOOTSTRAP = { 'Bruno Arevalo': 'BDI123456', 'Dario Arevalo': 'BDI123456' };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
async function kvCmd(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json();
  return d.result;
}
const keyFor = b => `ingresos:${b === 'zattia' ? 'zattia' : 'bdi'}`;

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV no configurado' });

  try {
    const store = (req.query?.store || req.body?.store || 'bdi').toLowerCase(); // POST manda store en el body

    // --- Config de reposición (mínimos por categoría + apagados) — baja sensibilidad, sin contraseña ---
    if (req.query?.kind === 'reposicion') {
      const repoKey = `reposicion:${store === 'zattia' ? 'zattia' : 'bdi'}`;
      if (req.method === 'GET') {
        const raw = await kvCmd(['GET', repoKey]);
        return res.status(200).json({ ok: true, config: raw ? JSON.parse(raw) : { mins: {}, apagados: [], defaultMin: 4, reservaDeposito: 1 } });
      }
      if (req.method === 'POST') {
        const { config } = req.body || {};
        if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config inválida' });
        await kvCmd(['SET', repoKey, JSON.stringify(config)]);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'método no permitido' });
    }

    // --- Override de teléfonos del CRM (mapa id_cliente -> teléfono, completado desde el export de GN) ---
    if (req.query?.kind === 'crmtel') {
      const telKey = `crm:tel:${store === 'zattia' ? 'zattia' : 'bdi'}`;
      if (req.method === 'GET') {
        const raw = await kvCmd(['GET', telKey]);
        return res.status(200).json({ ok: true, map: raw ? JSON.parse(raw) : {} });
      }
      if (req.method === 'POST') {
        const { map } = req.body || {};
        if (!map || typeof map !== 'object') return res.status(400).json({ error: 'map inválido' });
        await kvCmd(['SET', telKey, JSON.stringify(map)]);
        return res.status(200).json({ ok: true, total: Object.keys(map).length });
      }
      return res.status(405).json({ error: 'método no permitido' });
    }

    // --- Seguimiento del CRM (mapa id_cliente -> { cadencia, ultimo_contacto, proximo_manual, notas }) ---
    if (req.query?.kind === 'crmseg') {
      const segKey = `crm:seg:${store === 'zattia' ? 'zattia' : 'bdi'}`;
      if (req.method === 'GET') {
        const raw = await kvCmd(['GET', segKey]);
        return res.status(200).json({ ok: true, map: raw ? JSON.parse(raw) : {} });
      }
      if (req.method === 'POST') {
        const { map } = req.body || {};
        if (!map || typeof map !== 'object') return res.status(400).json({ error: 'map inválido' });
        await kvCmd(['SET', segKey, JSON.stringify(map)]);
        return res.status(200).json({ ok: true, total: Object.keys(map).length });
      }
      return res.status(405).json({ error: 'método no permitido' });
    }

    // --- Leads del CRM (prospectos cargados a mano: mapa id_lead -> { nombre, telefono, instagram, ciudad, estado, cadencia, ultimo_contacto, proximo_manual, notas, creado }) ---
    if (req.query?.kind === 'crmleads') {
      const leadsKey = `crm:leads:${store === 'zattia' ? 'zattia' : 'bdi'}`;
      if (req.method === 'GET') {
        const raw = await kvCmd(['GET', leadsKey]);
        return res.status(200).json({ ok: true, map: raw ? JSON.parse(raw) : {} });
      }
      if (req.method === 'POST') {
        const { map } = req.body || {};
        if (!map || typeof map !== 'object') return res.status(400).json({ error: 'map inválido' });
        await kvCmd(['SET', leadsKey, JSON.stringify(map)]);
        return res.status(200).json({ ok: true, total: Object.keys(map).length });
      }
      return res.status(405).json({ error: 'método no permitido' });
    }

    // --- Banco de mensajes del CRM (array de grupos {grupo, mensajes:[...]}) ---
    if (req.query?.kind === 'mensajes') {
      const msgKey = `mensajes:${store === 'zattia' ? 'zattia' : 'bdi'}`;
      if (req.method === 'GET') {
        const raw = await kvCmd(['GET', msgKey]);
        return res.status(200).json({ ok: true, bank: raw ? JSON.parse(raw) : null });
      }
      if (req.method === 'POST') {
        const { bank } = req.body || {};
        if (!Array.isArray(bank)) return res.status(400).json({ error: 'bank inválido' });
        await kvCmd(['SET', msgKey, JSON.stringify(bank)]);
        return res.status(200).json({ ok: true, total: bank.length });
      }
      return res.status(405).json({ error: 'método no permitido' });
    }

    // --- Tablas de talles vinculadas a productos (map id_producto_TN -> {tipo, talles, gtData, diagramaUrl, html}) ---
    if (req.query?.kind === 'talles') {
      const tallesKey = `talles:${store === 'zattia' ? 'zattia' : 'bdi'}`;
      if (req.method === 'GET') {
        const raw = await kvCmd(['GET', tallesKey]);
        return res.status(200).json({ ok: true, map: raw ? JSON.parse(raw) : {} });
      }
      if (req.method === 'POST') {
        const { map } = req.body || {};
        if (!map || typeof map !== 'object') return res.status(400).json({ error: 'map inválido' });
        await kvCmd(['SET', tallesKey, JSON.stringify(map)]);
        return res.status(200).json({ ok: true, total: Object.keys(map).length });
      }
      return res.status(405).json({ error: 'método no permitido' });
    }

    // --- Solicitudes para sesión de fotos (array de solicitudes) — baja sensibilidad, sin contraseña ---
    if (req.query?.kind === 'sesionfotos') {
      const sfKey = `sesionfotos:${store === 'zattia' ? 'zattia' : 'bdi'}`;
      if (req.method === 'GET') {
        const raw = await kvCmd(['GET', sfKey]);
        return res.status(200).json({ ok: true, list: raw ? JSON.parse(raw) : [] });
      }
      if (req.method === 'POST') {
        const { list } = req.body || {};
        if (!Array.isArray(list)) return res.status(400).json({ error: 'list inválida' });
        await kvCmd(['SET', sfKey, JSON.stringify(list)]);
        return res.status(200).json({ ok: true, total: list.length });
      }
      return res.status(405).json({ error: 'método no permitido' });
    }

    // --- Cupones por marca (array de cupones para aplicar en el local) — baja sensibilidad, sin contraseña ---
    if (req.query?.kind === 'cupones') {
      const cupKey = `cupones:${store === 'zattia' ? 'zattia' : 'bdi'}`;
      if (req.method === 'GET') {
        const raw = await kvCmd(['GET', cupKey]);
        return res.status(200).json({ ok: true, cupones: raw ? JSON.parse(raw) : [] });
      }
      if (req.method === 'POST') {
        const { cupones } = req.body || {};
        if (!Array.isArray(cupones)) return res.status(400).json({ error: 'cupones inválida' });
        await kvCmd(['SET', cupKey, JSON.stringify(cupones)]);
        return res.status(200).json({ ok: true, total: cupones.length });
      }
      return res.status(405).json({ error: 'método no permitido' });
    }

    // --- Solicitudes internas de productos (retiros con motivo/aprobación) por marca — baja sensibilidad ---
    if (req.query?.kind === 'solicitudesinternas') {
      const siKey = `solicitudesinternas:${store === 'zattia' ? 'zattia' : 'bdi'}`;
      if (req.method === 'GET') {
        const raw = await kvCmd(['GET', siKey]);
        return res.status(200).json({ ok: true, list: raw ? JSON.parse(raw) : [] });
      }
      if (req.method === 'POST') {
        const { list } = req.body || {};
        if (!Array.isArray(list)) return res.status(400).json({ error: 'list inválida' });
        await kvCmd(['SET', siKey, JSON.stringify(list)]);
        return res.status(200).json({ ok: true, total: list.length });
      }
      return res.status(405).json({ error: 'método no permitido' });
    }

    if (req.method === 'GET') {
      const raw = await kvCmd(['GET', keyFor(store)]);
      return res.status(200).json({ ok: true, ingresos: raw ? JSON.parse(raw) : [] });
    }
    if (req.method === 'POST') {
      const { ingresos, adminUser, adminPass } = req.body || {};
      if (!Array.isArray(ingresos)) return res.status(400).json({ error: 'ingresos inválidos' });
      // Validar que sea administrador (config de usuarios en KV, o admins de arranque)
      const cfgRaw = await kvCmd(['GET', 'cfg:usuarios']);
      const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
      let esAdmin = false;
      if (cfg && Array.isArray(cfg.users)) esAdmin = cfg.users.some(u => u.admin && u.name === adminUser && u.pass === adminPass);
      else esAdmin = BOOTSTRAP[adminUser] && BOOTSTRAP[adminUser] === adminPass;
      if (!esAdmin) return res.status(403).json({ error: 'Necesitás ser administrador para editar ingresos.' });
      await kvCmd(['SET', keyFor(store), JSON.stringify(ingresos)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
