// Lectura/escritura de la config del catálogo en el KV.
//
// Vivía suelta adentro de config.js. La sacamos acá porque ahora el proxy también
// necesita leer la config (para descontar los topes de stock antes de crear una
// venta) y no queremos dos copias de las mismas 8 líneas desincronizándose.
//
// Los archivos de api/ que empiezan con "_" NO son rutas: Vercel los ignora para el
// filesystem routing y no cuentan contra el límite de 12 funciones del plan Hobby
// (el repo está justo en 12). Ver la nota larga en _auth.js.

const KV_URL = process.env.KV_REST_API_URL || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const CONFIG_KEY = process.env.CONFIG_KEY || 'catalog-config';

async function kvGet() {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${CONFIG_KEY}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}

// Un comando suelto contra el KV (formato de Upstash: ["SET", clave, valor, ...]).
// Devuelve `null` —y NO revienta— cuando el KV no está configurado, para que quien
// llama pueda distinguir "el KV no está" de "el KV contestó que no".
async function kvCmd(cmd) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return r.json();
}

async function kvSet(value) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV no configurado');
  return kvCmd(['SET', CONFIG_KEY, JSON.stringify(value)]);
}

module.exports = { kvGet, kvSet, kvCmd };
