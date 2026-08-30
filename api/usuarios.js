// Configuración de usuarios y permisos del monitor (guardada en el KV compartido).
// El login se valida ACÁ (server-side): las contraseñas nunca se descargan al navegador.
//
// GET (con credencial)                    → config SIN contraseñas (para visibilidad/perfiles)
// POST {action:'login', user, pass}       → valida y devuelve { ok, perfil } (sin pass)
// POST {action:'login-google', token}     → ídem, pero identificando por el JWT del proveedor
// POST {action:'config', adminUser, adminPass | adminToken} → config sin contraseñas (con
//                                                             `tienePass` por usuario), solo admin
// POST {adminUser, adminPass | adminToken, config}          → guarda la config, solo admin.
//        `pass` por usuario solo si se está poniendo una NUEVA; vacío = no tocarla.
//
// Quién es admin y cómo se traduce un token del proveedor a un usuario vive en _admin.js,
// compartido con ingresos.js y comisiones.js.
const { esAdmin, emailDelToken, estaHasheada, hashearPass, usuarioPorEmail, usuarioPorPass } = require('./_admin');
const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const KEY = 'cfg:usuarios';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // `x-monitor-auth` es el sobre con el que el Monitor manda su credencial. Sin esto en
  // la lista, el preflight del GET falla y el navegador ni manda la request.
  'Access-Control-Allow-Headers': 'Content-Type, x-monitor-auth',
};

/**
 * La credencial que manda el Monitor en el header, para los pedidos sin body (el GET).
 * Mismo sobre que usa `monitor-areben/api/_auth.js`: base64(JSON) con `{user, pass}` o
 * `{token}` adentro. En base64 porque los valores de header son latin-1 y una contraseña
 * con "ñ" reventaría el fetch del lado del cliente.
 */
function credencialDeHeader(req) {
  const raw = (req.headers || {})['x-monitor-auth'];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

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
//
// `apodo` y `cumple` son los dos campos humanos: el Monitor recibe a cada uno por su nombre
// («Hola, Mari!») y `name` no sirve para eso —es el usuario de login, y en los puestos
// compartidos es `bdilocal`—. `cumple` va como `MM-DD`, sin año: no hace falta la edad.
//
// `horasExtras` y `horasLink` son el interruptor de las horas extras: el tilde decide a quién le
// llega la rutina de fin de mes (destino `{tipo:'horas-extras'}` en la Agenda del Monitor) y el
// link es el `/horas/<token>` del dashboard, que se pega a mano porque son dos bases distintas y
// los empleados no tienen usuario allá. ⚠️ El link es de UNA persona y viaja SÓLO en su propio
// perfil: el GET del padrón (`config`) lo devuelve junto al resto, pero el recorte para no-admins
// del Monitor (`Companero`) se queda con el booleano y NUNCA con el link.
const perfilDe = u => ({ name: u.name, admin: !!u.admin, cuenta: u.cuenta || null, acceso: u.acceso || { bdi: {}, zattia: {} }, funcion: Array.isArray(u.funcion) ? u.funcion : [], email: u.email || null, apodo: u.apodo || null, cumple: u.cumple || null, horasExtras: !!u.horasExtras, horasLink: u.horasLink || null });

/**
 * Los cumpleaños del equipo, para que el Monitor pueda saludar. Sale con el login porque el
 * padrón entero es admin-only y esto lo tiene que ver todo el mundo.
 *
 * Va **sólo apodo y `MM-DD`**: ni mail, ni permisos, ni quién es admin, ni el año de
 * nacimiento. Y van todos, sin recortar a una ventana de días, porque **el día lo decide el
 * navegador**: el server corre en UTC y a las 21:00 de Argentina ya es mañana. Son ~20 filas
 * de dos campos: filtrar acá costaría un bug y no ahorraría nada.
 */
const cumplesDe = cfg => (cfg?.users || []).filter(u => u.cumple).map(u => ({ apodo: u.apodo || u.name, cumple: u.cumple }));


/**
 * Resuelve la contraseña de cada usuario al guardar.
 *
 * La pantalla ya no conoce las contraseñas, así que manda `pass` solo cuando el admin
 * escribió una nueva; vacío significa "no la toques". Este merge es el que evita que
 * guardar un cambio de permisos borre la contraseña de todo el mundo.
 *
 * El registro previo se busca por `nameOriginal` (el nombre con el que la fila llegó al
 * navegador) y no por `name`: si en la misma tanda se renombra a alguien sin tocarle la
 * contraseña, buscar por el nombre nuevo no encontraría nada y la perdería.
 */
function fusionarPass(nuevos, previos) {
  const porNombre = new Map(previos.map(u => [u.name, u]));
  return nuevos.map(u => {
    const { nameOriginal, tienePass, pass, ...resto } = u;
    if (pass) return { ...resto, pass: hashearPass(pass) };
    const previo = porNombre.get(nameOriginal || resto.name);
    return previo && previo.pass ? { ...resto, pass: previo.pass } : resto;
  });
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV no configurado' });

  try {
    if (req.method === 'GET') {
      // Config SIN contraseñas (para construir la visibilidad de quien está logueado).
      //
      // Hasta acá esto respondía a cualquiera: con CORS '*' y sin credencial, la nómina
      // completa del equipo —nombres, permisos por marca, quién es admin— se bajaba desde
      // afuera con un curl. Ahora hay que estar logueado en el Monitor, de cualquiera de
      // las dos formas. Sigue sin devolver contraseñas: eso es solo para admins, por POST.
      const cfg = await leerCfg();
      const cred = credencialDeHeader(req) || {};
      const yo = cred.token
        ? usuarioPorEmail(cfg, await emailDelToken(cred.token))
        : usuarioPorPass(cfg, cred.user, cred.pass);
      if (!yo) return res.status(403).json({ error: 'Necesitás estar logueado en el Monitor.' });
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
        const u = usuarioPorPass(cfg, user, pass);
        if (!u) return res.status(200).json({ ok: false });
        // Migración silenciosa: si esta contraseña todavía estaba en texto plano, se
        // guarda hasheada ahora que sabemos que es la correcta. Pasa una sola vez por
        // usuario y no cambia nada de lo que ve quien entra. Si la escritura falla, el
        // login sigue siendo bueno: se reintenta en el próximo.
        if (!estaHasheada(u.pass)) {
          try {
            u.pass = hashearPass(pass);
            await kvCmd(['SET', KEY, JSON.stringify(cfg)]);
          } catch {
            /* que no se caiga un login por esto */
          }
        }
        return res.status(200).json({ ok: true, perfil: perfilDe(u), cumples: cumplesDe(cfg) });
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
        return res.status(200).json({ ok: true, perfil: perfilDe(u), cumples: cumplesDe(cfg) });
      }

      // Config para administradores — pantalla de gestión.
      //
      // Ya NO devuelve contraseñas: están hasheadas y un hash no se puede volver a leer.
      // En su lugar va `tienePass`, que es lo único que la pantalla necesita saber
      // (si esa cuenta puede entrar con contraseña o solo con Google).
      if (action === 'config') {
        const cfg = await leerCfg();
        if (!(await esAdmin(body, cfg))) return res.status(403).json({ error: 'Necesitás ser administrador.' });
        const users = ((cfg && cfg.users) || []).map(({ pass, ...u }) => ({ ...u, tienePass: !!pass }));
        return res.status(200).json({ ok: true, config: { ...(cfg || {}), users } });
      }

      // Guardar config (solo admin)
      const { config } = body;
      if (!config || !Array.isArray(config.users)) return res.status(400).json({ error: 'config inválida' });
      const actual = await leerCfg();
      if (!(await esAdmin(body, actual))) return res.status(403).json({ error: 'Necesitás ser administrador para guardar.' });
      if (!config.users.some(u => u.admin)) return res.status(400).json({ error: 'Tiene que quedar al menos un administrador.' });
      config.users = fusionarPass(config.users, (actual && actual.users) || []);
      config.updatedAt = Date.now();
      await kvCmd(['SET', KEY, JSON.stringify(config)]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
