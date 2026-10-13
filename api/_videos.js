// ---------------------------------------------------------------------------
// LOS VIDEOS DE CADA DISEÑO (para mandarle al mayorista lo que compró)
//
// Los videos viven en el Drive, en "09_MAYORISTAS+MELI": una carpeta por
// colección y, adentro, una carpeta por diseño con el MISMO nombre que el
// producto en Gestión Nube ("SHINY CASE", "POP CASE PINK"…). Ese nombre es el
// cruce: el renglón del pedido dice "SHINY CASE" y la carpeta también.
//
// La carpeta está abierta con "cualquiera con el link puede ver", así que se
// lee con la vista pública de Drive (embeddedfolderview), sin cuentas ni
// claves. Si algún día la vuelven a cerrar, esto devuelve vacío y el panel lo
// dice; no rompe nada más.
//
// Un video es de un diseño, no de un modelo: el que llevó Shiny para el 13
// recibe el mismo video que el que lo llevó para el 16.
// ---------------------------------------------------------------------------

const CARPETA_RAIZ = '1uRPAm2H2aSlWNl-v8fEfhIVU624RSUjH'; // 09_MAYORISTAS+MELI
const PROFUNDIDAD = 3; // raíz → colección → diseño (→ por si alguien mete una subcarpeta)
const EN_PARALELO = 50; // ~45 carpetas de diseño: de a 10 tardaba 10 s, el límite de la función

/** Nombre comparable: mayúsculas, sin tildes ni espacios de más. */
function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

const desescapar = (s) => s
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Lo que hay adentro de una carpeta pública: [{id, nombre, esCarpeta, esVideo}]. */
async function leerCarpeta(id) {
  // Con ~45 pedidos juntos, Drive a veces no contesta alguno y ese diseño se
  // perdía en silencio (pasó con Velvet). Se reintenta; si igual falla, se tira
  // el error para que el mapa quede marcado como incompleto.
  let html;
  for (let intento = 0; intento < 3; intento++) {
    try {
      const r = await fetch('https://drive.google.com/embeddedfolderview?id=' + encodeURIComponent(id));
      if (r.ok) { html = await r.text(); if (html.includes('flip-entries')) break; }
    } catch (e) { /* reintenta */ }
    html = null;
    await new Promise(ok => setTimeout(ok, 400 * (intento + 1)));
  }
  if (!html) throw new Error('Drive no contestó la carpeta ' + id);
  const out = [];
  // Cada renglón: <div class="flip-entry" id="entry-ID"> … <a href="…"> … <div class="flip-entry-title">NOMBRE</div>
  const re = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const href = m[2];
    const nombre = desescapar(m[3]);
    const esCarpeta = href.includes('/drive/folders/');
    out.push({
      id: m[1],
      nombre,
      esCarpeta,
      esVideo: !esCarpeta && /\.(mp4|mov|m4v|webm)$/i.test(nombre),
    });
  }
  return out;
}

/**
 * Recorre la carpeta y devuelve { videos: { "SHINY CASE": [{nombre, url}], … }, fallidas }:
 * cada video queda anotado con el nombre de la carpeta que lo contiene.
 */
async function mapaDeVideos() {
  const videos = {};
  let fallidas = 0;
  let nivel = [{ id: CARPETA_RAIZ, nombre: '' }];
  for (let p = 0; p < PROFUNDIDAD && nivel.length; p++) {
    const siguiente = [];
    for (let i = 0; i < nivel.length; i += EN_PARALELO) {
      const tramo = nivel.slice(i, i + EN_PARALELO);
      const leidos = await Promise.all(tramo.map(c => leerCarpeta(c.id).catch(() => { fallidas++; return []; })));
      leidos.forEach((hijos, j) => {
        const padre = tramo[j];
        hijos.forEach(h => {
          if (h.esCarpeta) siguiente.push({ id: h.id, nombre: h.nombre });
          else if (h.esVideo && padre.nombre) {
            const k = normalizar(padre.nombre);
            (videos[k] = videos[k] || []).push({
              nombre: h.nombre,
              url: 'https://drive.google.com/file/d/' + h.id + '/view',
            });
          }
        });
      });
    }
    nivel = siguiente;
  }
  // `fallidas` > 0: faltan diseños. Quien llama no lo guarda, así no queda media hora sin ellos.
  return { videos, fallidas };
}

module.exports = { mapaDeVideos, normalizar, CARPETA_RAIZ };
