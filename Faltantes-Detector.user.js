// ==UserScript==
// @name         Faltantes - Detector de entregas (Rappi / PedidosYa)
// @namespace    faltantes-delivery
// @version      1.2.7
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
  var VERSION = '1.2.7';
  var PUENTE = 'http://localhost:8787/api/activos';
  var host = (location.host || '');
  var PLATAFORMA = /rappi/i.test(host) ? 'Rappi' : (/restaurant-partners/i.test(host) ? 'PedidosYa' : '');

  var ultimaFirma = null;
  var secuencia = 0, ultimaLectura = 0, consultando = false;
  var tpl = null;        // plantilla para re-consultar: { url, headers, fromVal }
  var track = {};        // pk -> { keys:[...], misses:N }. Un pedido se quita solo si falta en varias lecturas seguidas.
  var terminados = {}, consultasDetalle = 0;
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
        data: JSON.stringify({ platform: PLATAFORMA, keys: claves, handedKeys: entregados, cancelledKeys: cancelados }), timeout: 4000,
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

  // Guarda/actualiza la plantilla de re-consulta. Para PeYa conserva la de ventana mas amplia (from mas antiguo).
  function guardarPlantilla(url, headers, metodo, body) {
    var fromVal = getFrom(url);
    var limpias = limpiarHeaders(headers);
    var m = metodo || 'GET'; var b = (body != null ? body : null);
    if (PLATAFORMA === 'PedidosYa') {
      if (!tpl || (fromVal && (!tpl.fromVal || fromVal < tpl.fromVal))) { tpl = { url: url, headers: limpias, fromVal: fromVal, metodo: m, body: b }; }
      else if (tpl && getFrom(url) === tpl.fromVal) { tpl.headers = limpias; tpl.url = url; tpl.metodo = m; tpl.body = b; }
    } else {
      tpl = { url: url, headers: limpias, fromVal: fromVal, metodo: m, body: b };
    }
  }
  // Procesa una respuesta como AUTORITATIVA (solo la llamada mas amplia en PeYa).
  function procesarAutoritativa(url, texto, lectura) {
    if (PLATAFORMA === 'PedidosYa' && tpl && getFrom(url) !== tpl.fromVal) return; // ignora llamadas filtradas (subconjuntos)
    if (lectura <= ultimaLectura) return; // una respuesta vieja no pisa una mas reciente
    var activos = calcular(texto);
    if (activos === null) return; // respuesta ilegible: no tocar nada
    ultimaLectura = lectura;
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
    for (var pk in track) { if (Object.prototype.hasOwnProperty.call(track, pk) && !presentes[pk]) { track[pk].misses++; if (PLATAFORMA !== 'PedidosYa' && track[pk].misses > 8) delete track[pk]; } }
    emitirSeguimiento();
    if (PLATAFORMA === 'PedidosYa') {
      for (var pendiente in track) if (Object.prototype.hasOwnProperty.call(track, pendiente) && track[pendiente].misses >= UMBRAL) confirmarDetalle(pendiente);
    }
  }

  function emitirSeguimiento() {
    var send = [], entregados = [], cancelados = [], cantidad = 0;
    for (var pk in track) {
      if (!Object.prototype.hasOwnProperty.call(track, pk)) continue;
      // En PeYa una ausencia no prueba entrega: mantenerlo hasta consultar el detalle.
      if (PLATAFORMA !== 'PedidosYa' && track[pk].misses >= UMBRAL) continue;
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

  // PedidosYa tambien verifica /1/deliveries/{id} cuando falta un pedido en deliveries-win.
  // Un 404, error, respuesta incompleta o ACCEPTED conserva el pedido; nunca infiere entrega.
  function confirmarDetalle(pk) {
    var pedido = track[pk], base = tpl && String(tpl.url).match(/^(.*)\/2\/deliveries-win(?:[?#]|$)/i);
    if (!pedido || !pedido.detailId || !base || pedido.checking || consultasDetalle >= 2 || (pedido.retryAt || 0) > Date.now()) return;
    pedido.checking = true; consultasDetalle++;
    function finalizar() { pedido.checking = false; pedido.retryAt = Date.now() + 10000; consultasDetalle--; }
    try {
      GM_xmlhttpRequest({
        method: 'GET', url: base[1] + '/1/deliveries/' + encodeURIComponent(pedido.detailId),
        headers: limpiarHeaders(tpl.headers), timeout: 7000,
        onload: function (r) {
          finalizar();
          if (track[pk] !== pedido || r.status < 200 || r.status >= 300) return;
          try {
            var p = JSON.parse(r.responseText);
            if (!p || String(p.id) !== pedido.detailId || String(p.externalId) !== pk) return;
            var estado = estadoPeYa(p);
            if (estado === 'open') return;
            delete track[pk]; terminados[pk] = { keys: pedido.keys, kind: estado };
            emitirSeguimiento();
          } catch (e) {}
        },
        onerror: finalizar, ontimeout: finalizar
      });
    } catch (e) { finalizar(); }
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
        var lectura = ++secuencia;
        return _fetch.apply(this, args).then(function (r) {
          try { var u = (r && r.url) || url; if (r.status >= 200 && r.status < 300 && coincide(u)) { guardarPlantilla(u, hdrs, metodo, body); r.clone().text().then(function (t) { procesarAutoritativa(u, t, lectura); }).catch(function(){}); } } catch (e) {}
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
          guardarPlantilla(self.__u, self.__h || {}, self.__m, self.__b);
          var cuerpo = null;
          try { cuerpo = self.responseText; } catch (e) { cuerpo = null; }
          if (!cuerpo && self.response != null) { cuerpo = (typeof self.response === 'string') ? self.response : JSON.stringify(self.response); }
          if (cuerpo) procesarAutoritativa(self.__u, cuerpo, lectura);
        } catch (e) {}
      });
      return _send.apply(this, arguments);
    };
  } catch (e) {}

  // ---- Re-consulta propia cada 5s: dos ausencias confirmadas sin recargar la pagina ----
  function reconsultar() {
    if (consultando) return;
    if (!tpl || !tpl.url) { log('re-consulta: aun sin plantilla'); return; }
    consultando = true;
    try {
      var lectura = ++secuencia, urlOrigen = tpl.url;
      var esGet = String(tpl.metodo || 'GET').toUpperCase() === 'GET';
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
    setInterval(reconsultar, 5000);
  }
  if (document.body) iniciar();
  else document.addEventListener('DOMContentLoaded', iniciar);
})();
