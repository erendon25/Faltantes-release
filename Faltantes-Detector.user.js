// ==UserScript==
// @name         Faltantes - Detector de entregas (Rappi / PedidosYa)
// @namespace    faltantes-delivery
// @version      1.2.11
// @description  Lee que pedidos siguen activos en Rappi y PedidosYa y le avisa a Faltantes para retirar solos los ya entregados.
// @author       Erick R.
// @match        https://aliados.rappi.com/*
// @match        https://web.us.restaurant-partners.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      rappi.pe
// @connect      restaurant-partners.com
// @connect      *
// @downloadURL  https://raw.githubusercontent.com/erendon25/Faltantes-release/main/Faltantes-Detector.user.js
// @updateURL    https://raw.githubusercontent.com/erendon25/Faltantes-release/main/Faltantes-Detector.user.js
// ==/UserScript==
(function () {
  'use strict';
  var VERSION = '1.2.11';
  var PUENTE = 'http://localhost:8787/api/activos';
  var host = (location.host || '');
  var PLATAFORMA = /rappi/i.test(host) ? 'Rappi' : (/restaurant-partners/i.test(host) ? 'PedidosYa' : '');

  var ultimaFirma = null;
  var secuencia = 0, ultimaLectura = 0, consultando = false;
  var tpl = null;        // plantilla para re-consultar: { url, headers, fromVal }
  var track = {};        // pk -> { keys:[...], misses:N }. Un pedido se quita solo si falta en varias lecturas seguidas.
  var terminados = {}, consultasDetalle = 0;
  var huboLectura = false; // hubo lectura autoritativa desde el ultimo tic (la propia pagina ya esta leyendo)
  var UMBRAL = 2;        // lecturas seguidas sin aparecer antes de darlo por salido (evita borrar por 1 lectura mala)
  function log(){ try{ console.log.apply(console, ['[Faltantes]'].concat([].slice.call(arguments))); }catch(e){} }

  // ---- Distintivo visible ----
  var badge;
  function badgeTxt(t, color){ try{ if(badge){ badge.textContent = 'Faltantes v' + VERSION + ': ' + t; badge.style.background = color; } }catch(e){} }
  function ponerBadge(){
    try{
      if (badge || !document.body) return;
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;z-index:2147483647;right:10px;bottom:10px;font:12px/1.2 Segoe UI,system-ui,sans-serif;color:#fff;background:#6b746b;padding:5px 9px;border-radius:8px;opacity:.85;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none';
      badge.textContent = 'Faltantes: iniciando…';
      document.body.appendChild(badge);
    }catch(e){}
  }

  function enviar(claves, entregados, cancelados, cantidad) {
    if (!PLATAFORMA) return;
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: PUENTE, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ platform: PLATAFORMA, keys: claves, handedKeys: entregados, cancelledKeys: cancelados }), timeout: 10000,
        onload: function (r) {
          var ok = false;
          try { ok = r.status >= 200 && r.status < 300 && JSON.parse(r.responseText).ok === true; } catch (e) {}
          badgeTxt(ok ? 'conectado (' + cantidad + ' activos)' : 'el puente no acepto la lectura', ok ? '#2f7d4f' : '#b3402a');
        },
        onerror: function () { badgeTxt('no encuentra el puente', '#b3402a'); },
        ontimeout: function () { badgeTxt('sin respuesta del puente', '#b3402a'); }
      });
    } catch (e) { badgeTxt('error (Tampermonkey)', '#b3402a'); }
  }
  function registrar(claves, entregados, cancelados, cantidad) {
    var firma = JSON.stringify([claves.slice().sort(), entregados.slice().sort(), cancelados.slice().sort()]);
    if (ultimaFirma !== firma) log('activos', PLATAFORMA, '=', claves.length, claves);
    ultimaFirma = firma;
    // Cada lectura real renueva la senal y reintenta si el puente estaba desconectado.
    // Nunca renovar con datos guardados: conexion al puente no equivale a lectura fresca.
    enviar(claves, entregados, cancelados, cantidad);
  }

  function estadoPeYa(p) {
    var estado = String(p.state || '').trim().toUpperCase();
    if (estado === 'PICKED_UP' || estado === 'CLOSED') return 'handed';
    if (/^(CANCELLED(_BY_PLATFORM|_BY_TRANSPORT)?|REJECTED|EXPIRED|MISSED)$/.test(estado)) return 'cancelled';
    return 'open';
  }

  // ---- Calcular el set de ACTIVOS desde una respuesta ----
  // Rappi: leer exclusivamente orders del endpoint del tablero /partner/status/v2.
  // El campo partner_order_state es el que usa el tablero para clasificar pedidos.
  // delivered_to_rt confirma entrega al repartidor aunque no se lo haya visto activo.
  // Los estados desconocidos se conservan como activos para no retirar pedidos por error.
  // Devuelve [{pk, keys, handed?}], o null si no se pudo leer la respuesta.
  function calcular(texto) {
    try {
      if (PLATAFORMA === 'Rappi') {
        var j = JSON.parse(texto); var data = j && j.orders; var out = [];
        if (!Array.isArray(data)) return null;
        for (var i = 0; i < data.length; i++) {
          var o = data[i]; if (!o || o.id == null || !String(o.id).trim()) return null;
          var id = String(o.id);
          out.push({ pk: id, keys: [id], handed: String(o.partner_order_state || '').trim().toLowerCase() === 'delivered_to_rt' });
        }
        return out;
      } else {
        var arr = JSON.parse(texto); if (!Array.isArray(arr)) return null; var out2 = [];
        for (var k = 0; k < arr.length; k++) {
          var p = arr[k]; if (!p || p.externalId == null || !String(p.externalId).trim()) return null;
          var pk = String(p.externalId); var keys = [pk]; if (p.shortCode != null) keys.push(String(p.shortCode));
          var estado = estadoPeYa(p);
          out2.push({ pk: pk, keys: keys, detailId: p.id == null ? '' : String(p.id), handed: estado === 'handed', cancelled: estado === 'cancelled' });
        }
        return out2;
      }
    } catch (e) { return null; }
  }

  function absoluta(u) {
    var v = String(u || '');
    if (/^https?:\/\//i.test(v)) return v;
    var proto = (location && location.protocol) || 'https:';
    if (v.indexOf('//') === 0) return proto + v;
    if (v.charAt(0) === '/') return proto + '//' + location.host + v;
    return v;
  }
  function getFrom(url){ try{ var m = String(url).match(/[?&]from=([^&]+)/i); return m ? decodeURIComponent(m[1]) : ''; }catch(e){ return ''; } }
  function coincide(url){
    var value = String(url);
    // No aceptar coincidencias por nombre: orders-live tambien existe en soporte/chat
    // y puede incluir pedidos de otros locales que no aparecen en el tablero.
    if (PLATAFORMA === 'Rappi') return /^(?:https?:\/\/[^/?#]+)?\/api\/rs-aliados-gateway\/orders\/partner\/status\/v2\/?(?:[?#]|$)/i.test(value);
    return /deliveries-win/i.test(value);
  }
  // Quita cabeceras que el navegador maneja solo (si las forzamos, la re-consulta puede fallar).
  function limpiarHeaders(h){ var out = {}; if (!h) return out; var mal = /^(host|content-length|origin|referer|user-agent|cookie|connection|accept-encoding)$/i; for (var k in h){ if (Object.prototype.hasOwnProperty.call(h, k) && !mal.test(k)) out[k] = h[k]; } return out; }

  function hayCabeceras(h) { for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) return true; } return false; }
  // Guarda/actualiza la plantilla de re-consulta. Para PeYa conserva la de ventana mas amplia (from mas antiguo).
  function guardarPlantilla(url, headers, metodo, body, via, cred) {
    var fromVal = getFrom(url);
    var limpias = limpiarHeaders(headers);
    var m = metodo || 'GET'; var b = (body != null ? body : null);
    if (PLATAFORMA === 'PedidosYa') {
      var ahora = Date.now();
      // Si la pagina dejo de usar la ventana guardada (p. ej. cambio el dia), adoptar la que usa ahora.
      // Es seguro: en PeYa una ausencia solo dispara la confirmacion por ID, nunca retira por si sola.
      var abandonada = tpl && fromVal !== tpl.fromVal && (ahora - (tpl.visto || 0)) > 180000;
      if (!tpl || (fromVal && (!tpl.fromVal || fromVal < tpl.fromVal)) || abandonada) { tpl = { url: url, headers: limpias, fromVal: fromVal, metodo: m, body: b, visto: ahora, via: via, cred: cred }; }
      else if (fromVal === tpl.fromVal) { if (hayCabeceras(limpias)) tpl.headers = limpias; tpl.url = url; tpl.metodo = m; tpl.body = b; tpl.visto = ahora; tpl.via = via; tpl.cred = cred; }
      else if (hayCabeceras(limpias)) { tpl.headers = limpias; } // credenciales frescas de la app
    } else {
      tpl = { url: url, headers: limpias, fromVal: fromVal, metodo: m, body: b, via: via, cred: cred };
    }
  }
  // Procesa una respuesta como AUTORITATIVA (solo la llamada mas amplia en PeYa).
  function procesarAutoritativa(url, texto, lectura) {
    if (PLATAFORMA === 'PedidosYa' && tpl && getFrom(url) !== tpl.fromVal) return; // ignora llamadas filtradas (subconjuntos)
    if (lectura <= ultimaLectura) return; // una respuesta vieja no pisa una mas reciente
    var activos = calcular(texto);
    if (activos === null) return; // respuesta ilegible: no tocar nada
    ultimaLectura = lectura; huboLectura = true;
    var presentes = {};
    for (var i = 0; i < activos.length; i++) {
      var a = activos[i];
      if (a.handed || a.cancelled) {
        delete track[a.pk];
        terminados[a.pk] = { keys: a.keys, kind: a.handed ? 'handed' : 'cancelled' };
      } else {
        delete terminados[a.pk];
        track[a.pk] = { keys: a.keys, detailId: a.detailId, misses: 0 }; presentes[a.pk] = true;
      }
    }
    for (var pk in track) {
      if (Object.prototype.hasOwnProperty.call(track, pk) && !presentes[pk]) {
        track[pk].misses++;
        // Rappi: la ausencia retira; limpiamos el track tras un margen para no crecer sin fin.
        // PeYa: NUNCA se retira por ausencia (el puente lo exige); se conserva hasta confirmar por ID.
        if (PLATAFORMA !== 'PedidosYa' && track[pk].misses > 8) delete track[pk];
      }
    }
    emitirSeguimiento();
  }

  function emitirSeguimiento() {
    var send = [], entregados = [], cancelados = [], cantidad = 0;
    for (var pk in track) {
      if (!Object.prototype.hasOwnProperty.call(track, pk)) continue;
      if (PLATAFORMA === 'PedidosYa') {
        // PeYa: el puente NUNCA retira por ausencia; exige confirmacion por ID.
        // Apenas falta, se pide su detalle; mientras tanto sigue activo.
        if (track[pk].misses >= 1) confirmarDetalle(pk);
      } else if (track[pk].misses >= UMBRAL) continue; // Rappi: la ausencia basta (el puente la toma como entrega)
      send = send.concat(track[pk].keys); cantidad++;
    }
    for (var terminado in terminados) {
      if (!Object.prototype.hasOwnProperty.call(terminados, terminado)) continue;
      var t = terminados[terminado];
      // Confirmar por ID externo completo: el numero corto puede reutilizarse otro dia.
      if (t.kind === 'handed') entregados.push(terminado);
      else cancelados.push(terminado);
    }
    registrar(send, entregados, cancelados, cantidad);
  }

  // PeYa: las consultas salen DESDE LA PROPIA PAGINA (mismo origen, cookies y cabeceras de la app),
  // iguales a las que hace la app. Desde Tampermonkey (fuera de la pagina) PeYa las marca como robot.
  function pedirPeYa(metodo, url, headers, body, timeoutMs, cb) {
    var hecho = false, via = (tpl && tpl.via) || 'xhr', cred = (tpl && tpl.cred) || '';
    url = absoluta(url);
    metodo = metodo || 'GET';
    var conCuerpo = body != null && String(metodo).toUpperCase() !== 'GET';
    function terminar(status, texto, motivo) { if (hecho) return; hecho = true; try { cb(status, texto || '', motivo || ''); } catch (e) {} }
    // Respaldo (como en versiones anteriores) solo si la consulta desde la pagina no pudo salir.
    function porGM(motivoPagina) {
      try {
        GM_xmlhttpRequest({ method: metodo, url: url, headers: headers || {}, data: conCuerpo ? body : undefined, timeout: timeoutMs,
          onload: function (r) { if (r.status) log('PedidosYa: respondio por respaldo (Tampermonkey)', r.status); terminar(r.status, r.responseText, motivoPagina); },
          onerror: function () { terminar(0, '', motivoPagina + ' / respaldo: error de red'); },
          ontimeout: function () { terminar(0, '', motivoPagina + ' / respaldo: tiempo agotado'); },
          onabort: function () { terminar(0, '', motivoPagina + ' / respaldo: cancelado'); } });
      } catch (e) { terminar(0, '', motivoPagina + ' / respaldo: ' + (e && e.message)); }
    }
    function listo(status, texto, motivo) {
      if (status) { terminar(status, texto); return; }
      log('PedidosYa: la consulta desde la pagina no salio (' + motivo + ')', via, url);
      porGM(motivo);
    }
    // Desde la propia pagina, IGUAL que la app: mismo mecanismo (XHR o fetch), mismas credenciales.
    if (via === 'fetch' && typeof _fetch === 'function') {
      var hechoF = false;
      var fin = function (st, tx, mo) { if (hechoF) return; hechoF = true; listo(st, tx, mo); };
      try {
        var timer = setTimeout(function () { fin(0, '', 'fetch: tiempo agotado'); }, timeoutMs);
        var init = { method: metodo, headers: headers || {}, cache: 'no-store' };
        if (cred) init.credentials = cred;
        if (conCuerpo) init.body = body;
        _fetch(url, init).then(function (r) {
          return (r.text ? r.text() : r.clone().text()).then(function (t) { clearTimeout(timer); fin(r.status, t); });
        }).catch(function (e) { clearTimeout(timer); fin(0, '', 'fetch: ' + ((e && e.message) || 'error')); });
      } catch (e) { fin(0, '', 'fetch: ' + ((e && e.message) || 'error')); }
      return;
    }
    try {
      var x = new XMLHttpRequest(), hechoX = false;
      var finX = function (st, tx, mo) { if (hechoX) return; hechoX = true; listo(st, tx, mo); };
      _open.call(x, metodo, url, true);
      try { x.withCredentials = (cred === 'include'); } catch (e) {}
      try { x.timeout = timeoutMs; } catch (e) {}
      for (var k in (headers || {})) { if (Object.prototype.hasOwnProperty.call(headers, k)) { try { _setH.call(x, k, headers[k]); } catch (e) {} } }
      x.onload = function () { var t = ''; try { t = x.responseText; } catch (e) {} if (!t && x.response != null) t = (typeof x.response === 'string') ? x.response : JSON.stringify(x.response); finX(x.status, t, 'xhr: respuesta vacia'); };
      x.onerror = function () { finX(0, '', 'xhr: error de red'); };
      x.ontimeout = function () { finX(0, '', 'xhr: tiempo agotado'); };
      x.onabort = function () { finX(0, '', 'xhr: cancelado'); };
      _send.call(x, conCuerpo ? body : null);
    } catch (e) { listo(0, '', 'xhr: ' + ((e && e.message) || 'error')); }
  }
  function avisoHttp(status, motivo) {
    log('PedidosYa respondio', status || 'sin conexion', motivo || '');
    badgeTxt(status ? 'PedidosYa respondio HTTP ' + status + ' (reintenta)' : 'PedidosYa sin respuesta: ' + (motivo || 'desconocido') + ' (reintenta)', '#b8741a');
  }

  // PedidosYa verifica /1/deliveries/{id} cuando falta un pedido en deliveries-win.
  // Un 404, error, respuesta incompleta o ACCEPTED conserva el pedido; nunca infiere entrega.
  function confirmarDetalle(pk) {
    var pedido = track[pk], base = tpl && String(tpl.url).match(/^(.*)\/2\/deliveries-win(?:[?#]|$)/i);
    if (!pedido || !pedido.detailId || !base || pedido.checking || consultasDetalle >= 2 || (pedido.retryAt || 0) > Date.now()) return;
    pedido.checking = true; consultasDetalle++;
    pedirPeYa('GET', base[1] + '/1/deliveries/' + encodeURIComponent(pedido.detailId), limpiarHeaders(tpl.headers), null, 8000, function (status, texto, motivo) {
      // Espera creciente si sigue sin confirmarse: 20s, 40s, 80s... hasta 5 min (no insistir como robot).
      pedido.intentos = (pedido.intentos || 0) + 1;
      pedido.checking = false; consultasDetalle--;
      pedido.retryAt = Date.now() + Math.min(300000, 20000 * Math.pow(2, pedido.intentos - 1));
      if (status < 200 || status >= 300) { if (status !== 404) avisoHttp(status, motivo); return; }
      if (track[pk] !== pedido) return;
      try {
        var p = JSON.parse(texto);
        if (!p || String(p.id) !== pedido.detailId || String(p.externalId) !== pk) return;
        var estado = estadoPeYa(p);
        if (estado === 'open') return;
        delete track[pk]; terminados[pk] = { keys: pedido.keys, kind: estado };
        emitirSeguimiento();
      } catch (e) {}
    });
  }

  // ---- Interceptar fetch (captura plantilla + procesa) ----
  try {
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function () {
        var args = arguments, url = ('' + (args[0] && args[0].url ? args[0].url : args[0]));
        var hdrs = {};
        try { var hi = (args[1] && args[1].headers) || (args[0] && args[0].headers); if (hi) { if (hi.forEach) hi.forEach(function(v,k){ hdrs[k]=v; }); else Object.keys(hi).forEach(function(k){ hdrs[k]=hi[k]; }); } } catch(e){}
        var metodo = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
        var body = (args[1] && args[1].body) || null;
        var cred = (args[1] && args[1].credentials) || (args[0] && typeof args[0] === 'object' && args[0].credentials) || '';
        var lectura = ++secuencia;
        return _fetch.apply(this, args).then(function (r) {
          try { var u = (r && r.url) || url; if (r.status >= 200 && r.status < 300 && coincide(u)) { guardarPlantilla(u, hdrs, metodo, body, 'fetch', cred); r.clone().text().then(function (t) { procesarAutoritativa(u, t, lectura); }).catch(function(){}); } } catch (e) {}
          return r;
        });
      };
    }
  } catch (e) {}

  // ---- Interceptar XMLHttpRequest (captura cabeceras + procesa) ----
  try {
    var _open = XMLHttpRequest.prototype.open, _setH = XMLHttpRequest.prototype.setRequestHeader, _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__m = m; this.__h = {}; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = v; } catch(e){} return _setH.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      var self = this; self.__b = body;
      var lectura = ++secuencia;
      this.addEventListener('load', function () {
        try {
          if (self.status < 200 || self.status >= 300 || !coincide(self.__u || '')) return;
          guardarPlantilla(self.__u, self.__h || {}, self.__m, self.__b, 'xhr', self.withCredentials ? 'include' : '');
          var cuerpo = null;
          try { cuerpo = self.responseText; } catch (e) { cuerpo = null; }
          if (!cuerpo && self.response != null) { cuerpo = (typeof self.response === 'string') ? self.response : JSON.stringify(self.response); }
          if (cuerpo) procesarAutoritativa(self.__u, cuerpo, lectura);
        } catch (e) {}
      });
      return _send.apply(this, arguments);
    };
  } catch (e) {}

  // ---- Re-consulta propia (Rappi ~12s; PeYa solo si la pagina no leyo nada en el ultimo tic) ----
  function reconsultar() {
    if (consultando) return;
    if (!tpl || !tpl.url) { log('re-consulta: aun sin plantilla'); return; }
    consultando = true;
    try {
      var lectura = ++secuencia, urlOrigen = tpl.url;
      var esGet = String(tpl.metodo || 'GET').toUpperCase() === 'GET';
      if (PLATAFORMA === 'PedidosYa') {
        pedirPeYa(tpl.metodo || 'GET', tpl.url, limpiarHeaders(tpl.headers), esGet ? null : tpl.body, 8000, function (status, t, motivo) {
          consultando = false;
          log('re-consulta', PLATAFORMA, 'HTTP', status, 'len', t.length);
          if (status >= 200 && status < 300 && t) { try { procesarAutoritativa(urlOrigen, t, lectura); } catch (e) { log('re-consulta parse err', e); } }
          else avisoHttp(status, motivo);
        });
        return;
      }
      var url = tpl.url;
      if (esGet) url += (url.indexOf('?') >= 0 ? '&' : '?') + '__fcb=' + Date.now(); // rompe cache: trae la lista fresca
      var cab = {}; for (var k in (tpl.headers || {})) { if (Object.prototype.hasOwnProperty.call(tpl.headers, k)) cab[k] = tpl.headers[k]; }
      cab['Cache-Control'] = 'no-cache'; cab['Pragma'] = 'no-cache';
      var opt = {
        method: tpl.metodo || 'GET', url: url, headers: cab, timeout: 7000,
        onload: function (r) {
          consultando = false;
          var t = r.responseText || '';
          log('re-consulta', PLATAFORMA, 'HTTP', r.status, 'len', t.length);
          try { if (r.status >= 200 && r.status < 300 && t) procesarAutoritativa(urlOrigen, t, lectura); } catch (e) { log('re-consulta parse err', e); }
        },
        onerror: function (e) { consultando = false; badgeTxt('sin lectura de ' + PLATAFORMA, '#b3402a'); log('re-consulta ERROR', PLATAFORMA, (e && (e.error || e.statusText)) || ''); },
        ontimeout: function () { consultando = false; badgeTxt('sin lectura de ' + PLATAFORMA, '#b3402a'); log('re-consulta TIMEOUT', PLATAFORMA); }
      };
      if (!esGet && tpl.body != null) opt.data = tpl.body;
      GM_xmlhttpRequest(opt);
    } catch (e) { consultando = false; log('re-consulta excepcion', e); }
  }

  function iniciar() {
    ponerBadge();
    log('detector cargado en', PLATAFORMA || host);
    badgeTxt('esperando lectura de ' + PLATAFORMA, '#6b746b');
    // El inicio y los errores no son listas vacias: solo se envia tras leer la app.
    if (PLATAFORMA === 'PedidosYa') {
      // PeYa refresca su lista sola y esas lecturas se interceptan gratis. Solo consultamos si en el
      // ultimo tic (~15-20s) no hubo ninguna lectura: como mucho ~2 por minuto y desde la pagina.
      var cada = 15000 + Math.floor(Math.random() * 5000);
      setInterval(function () { try { if (huboLectura) { huboLectura = false; return; } reconsultar(); } catch (e) {} }, cada);
    } else {
      // Rappi usa Firebase y no re-pide la lista sola: necesita la re-consulta.
      var base = 12000, jitter = Math.floor(Math.random() * Math.round(base * 0.3));
      setInterval(function () { try { reconsultar(); } catch (e) {} }, base + jitter);
    }
  }
  if (document.body) iniciar();
  else document.addEventListener('DOMContentLoaded', iniciar);
})();
