const API_BASE = 'https://www.gestionnube.com/api/v1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-token',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const token = event.headers['x-api-token'];
  if (!token) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Token requerido' }) };
  }

  const path = event.path.replace('/.netlify/functions/proxy', '').replace('/api', '') || '/';
  const qs = event.rawQuery ? '?' + event.rawQuery : '';
  const url = API_BASE + path + qs;

  try {
    const fetchOpts = {
      method: event.httpMethod,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      }
    };

    if (event.body && ['POST', 'PUT', 'PATCH'].includes(event.httpMethod)) {
      fetchOpts.body = event.body;
    }

    const res = await fetch(url, fetchOpts);
    const data = await res.text();

    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: data
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: e.message })
    };
  }
};
