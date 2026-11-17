// ==UserScript==
// @name         Faltantes - Detector de entregas (Rappi / PedidosYa)
// @namespace    faltantes-delivery
// @version      1.2.2
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
  var PUENTE = 'http://localhost:8787/api/activos';
  var host = (location.host || '');
  var PLATAFORMA = /rappi/i.test(host) ? 'Rappi' : (/restaurant-partners/i.test(host) ? 'PedidosYa' : '');

  var ultimaFirma = null, ultimasClaves = [];
  var tpl = null;        // plantilla para re-consultar: { url, headers, fromVal }
  function log(){ try{ console.log.apply(console, ['[Faltantes]'].concat([].slice.call(arguments))); }catch(e){} }

  // ---- Distintivo visible ----
  var badge;
  function badgeTxt(t, color){ try{ if(badge){ badge.textContent = 'Faltantes: ' + t; badge.style.background = color; } }catch(e){} }
  function ponerBadge(){
    try{
      if (badge || !document.body) return;
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;z-index:2147483647;right:10px;bottom:10px;font:12px/1.2 Segoe UI,system-ui,sans-serif;color:#fff;background:#6b746b;padding:5px 9px;border-radius:8px;opacity:.85;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none';
      badge.textContent = 'Faltantes: iniciando…';
      document.body.appendChild(badge);
    }catch(e){}
  }

  function enviar(claves) {
    if (!PLATAFORMA) return;
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: PUENTE, headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ platform: PLATAFORMA, keys: claves }), timeout: 4000,
        onload: function () { badgeTxt('conectado (' + claves.length + ' activos)', '#2f7d4f'); },
        onerror: function () { badgeTxt('no encuentra el puente', '#b3402a'); },
        ontimeout: function () { badgeTxt('sin respuesta del puente', '#b3402a'); }
      });
    } catch (e) { badgeTxt('error (Tampermonkey)', '#b3402a'); }
  }
  function registrar(claves) {
    ultimasClaves = claves;
    var firma = JSON.stringify(claves.slice().sort());
    if (ultimaFirma === firma) return;
    ultimaFirma = firma;
    log('activos', PLATAFORMA, '=', claves.length, claves);
    enviar(claves);
  }

  // ---- Calcular el set de ACTIVOS desde una respuesta ----
  // Rappi: activo = sigue en orders-live (cualquier estado). Si no aparece => ya salio.
  // PeYa: activo = aparece con estado ACCEPTED. Entregado => desaparece de la lista. Cancelado => aparece con otro estado.
  function calcular(texto) {
    try {
      if (PLATAFORMA === 'Rappi') {
        var j = JSON.parse(texto); var data = (j && j.data) || []; var cl = [];
        for (var i = 0; i < data.length; i++) { var o = data[i]; if (o && o.id != null) cl.push(String(o.id)); }
        return cl;
      } else {
        var arr = JSON.parse(texto); if (!Array.isArray(arr)) return null; var c2 = [];
        for (var k = 0; k < arr.length; k++) { var p = arr[k]; if (!p || p.state !== 'ACCEPTED') continue; if (p.externalId != null) c2.push(String(p.externalId)); if (p.shortCode != null) c2.push(String(p.shortCode)); }
        return c2;
      }
    } catch (e) { return null; }
  }

  function getFrom(url){ try{ var m = String(url).match(/[?&]from=([^&]+)/i); return m ? decodeURIComponent(m[1]) : ''; }catch(e){ return ''; } }
  function coincide(url){ return /orders-live|deliveries-win/i.test(String(url)); }
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
  function procesarAutoritativa(url, texto) {
    if (PLATAFORMA === 'PedidosYa' && tpl && getFrom(url) !== tpl.fromVal) return; // ignora llamadas filtradas (subconjuntos)
    var claves = calcular(texto);
    if (claves !== null) registrar(claves);
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
        return _fetch.apply(this, args).then(function (r) {
          try { var u = (r && r.url) || url; if (coincide(u)) { guardarPlantilla(u, hdrs, metodo, body); r.clone().text().then(function (t) { procesarAutoritativa(u, t); }).catch(function(){}); } } catch (e) {}
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
      this.addEventListener('load', function () {
        try {
          if (!coincide(self.__u || '')) return;
          guardarPlantilla(self.__u, self.__h || {}, self.__m, self.__b);
          var cuerpo = null;
          try { cuerpo = self.responseText; } catch (e) { cuerpo = null; }
          if (!cuerpo && self.response != null) { cuerpo = (typeof self.response === 'string') ? self.response : JSON.stringify(self.response); }
          if (cuerpo) procesarAutoritativa(self.__u, cuerpo);
        } catch (e) {}
      });
      return _send.apply(this, arguments);
    };
  } catch (e) {}

  // ---- Re-consulta propia cada 12s: asegura que detectemos entregas aunque la pagina no refresque sola ----
  function reconsultar() {
    if (!tpl || !tpl.url) { log('re-consulta: aun sin plantilla'); return; }
    try {
      var esGet = String(tpl.metodo || 'GET').toUpperCase() === 'GET';
      var url = tpl.url;
      if (esGet) url += (url.indexOf('?') >= 0 ? '&' : '?') + '__fcb=' + Date.now(); // rompe cache: trae la lista fresca
      var cab = {}; for (var k in (tpl.headers || {})) { if (Object.prototype.hasOwnProperty.call(tpl.headers, k)) cab[k] = tpl.headers[k]; }
      cab['Cache-Control'] = 'no-cache'; cab['Pragma'] = 'no-cache';
      var opt = {
        method: tpl.metodo || 'GET', url: url, headers: cab, timeout: 7000,
        onload: function (r) {
          var t = r.responseText || '';
          log('re-consulta', PLATAFORMA, 'HTTP', r.status, 'len', t.length, '|', t.slice(0, 180));
          try { if (r.status >= 200 && r.status < 300 && t) procesarAutoritativa(tpl.url, t); } catch (e) { log('re-consulta parse err', e); }
        },
        onerror: function (e) { log('re-consulta ERROR', PLATAFORMA, (e && (e.error || e.statusText)) || ''); },
        ontimeout: function () { log('re-consulta TIMEOUT', PLATAFORMA); }
      };
      if (!esGet && tpl.body != null) opt.data = tpl.body;
      GM_xmlhttpRequest(opt);
    } catch (e) { log('re-consulta excepcion', e); }
  }

  function iniciar() {
    ponerBadge();
    log('detector cargado en', PLATAFORMA || host);
    enviar([]); // saludo: aparece en http://localhost:8787/api/activos aunque aun no haya pedidos
    setInterval(reconsultar, 12000);
    setInterval(function () { enviar(ultimasClaves); }, 20000); // latido: mantiene fresca la senal
  }
  if (document.body) iniciar();
  else document.addEventListener('DOMContentLoaded', iniciar);
})();
