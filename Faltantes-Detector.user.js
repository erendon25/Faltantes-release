// ==UserScript==
// @name         Faltantes - Detector de entregas (Rappi / PedidosYa)
// @namespace    faltantes-delivery
// @version      1.1.1
// @description  Lee que pedidos siguen activos en las paginas de Rappi y PedidosYa y le avisa a Faltantes para retirar solos los ya entregados.
// @author       Erick R.
// @match        https://aliados.rappi.com/*
// @match        https://web.us.restaurant-partners.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @downloadURL  https://raw.githubusercontent.com/erendon25/Faltantes-release/main/Faltantes-Detector.user.js
// @updateURL    https://raw.githubusercontent.com/erendon25/Faltantes-release/main/Faltantes-Detector.user.js
// ==/UserScript==
(function () {
  'use strict';
  var PUENTE = 'http://localhost:8787/api/activos';
  // PeYa: solo estados FINALES (ya salio del aplicativo). NO incluye "listo"/preparado ni "en camino":
  // el pedido sigue en la plataforma hasta que se ENTREGA (o se cancela), y solo ahi se retira de Faltantes.
  var PEYA_FUERA = /CANCEL|DELIVER|CLOSED|REJECT|VOID|EXPIRE/i;

  var host = (location.host || '');
  var PLATAFORMA = /rappi/i.test(host) ? 'Rappi' : (/restaurant-partners/i.test(host) ? 'PedidosYa' : '');
  var ultimaFirma = null, ultimasClaves = [];
  function log(){ try{ console.log.apply(console, ['[Faltantes]'].concat([].slice.call(arguments))); }catch(e){} }

  // --- Distintivo visible en la esquina (para saber que esta corriendo sin abrir DevTools) ---
  var badge;
  function badgeTxt(t, color){ try{ if(!badge) return; badge.textContent = 'Faltantes: ' + t; badge.style.background = color; }catch(e){} }
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
        onerror: function () { badgeTxt('no encuentra el puente', '#b3402a'); log('error enviando (¿puente abierto?)'); },
        ontimeout: function () { badgeTxt('sin respuesta del puente', '#b3402a'); }
      });
    } catch (e) { badgeTxt('error (Tampermonkey)', '#b3402a'); log('GM_xmlhttpRequest no disponible', e); }
  }
  function registrar(claves) {
    var firma = JSON.stringify(claves.slice().sort());
    ultimasClaves = claves;
    if (ultimaFirma === firma) return;
    ultimaFirma = firma;
    log('activos en', PLATAFORMA, '=', claves.length, claves);
    enviar(claves);
  }

  function procesar(url, texto) {
    try {
      if (/orders-live/i.test(url)) {
        // Rappi: activo mientras el pedido SIGA en la lista (cualquier estado: in_store u on_the_route).
        // Solo se retira de Faltantes cuando desaparece de orders-live, o sea cuando ya no esta en la app.
        var j = JSON.parse(texto); var data = (j && j.data) || []; var cl = [];
        for (var i = 0; i < data.length; i++) { var o = data[i]; if (o && o.id != null) cl.push(String(o.id)); }
        registrar(cl);
      } else if (/deliveries-win/i.test(url)) {
        var arr = JSON.parse(texto); if (!Array.isArray(arr)) return; var c2 = [];
        for (var k = 0; k < arr.length; k++) { var p = arr[k]; if (!p) continue; if (PEYA_FUERA.test(String(p.state || ''))) continue; if (p.externalId != null) c2.push(String(p.externalId)); if (p.shortCode != null) c2.push(String(p.shortCode)); }
        registrar(c2);
      }
    } catch (e) { log('no se pudo leer respuesta', e); }
  }

  // Interceptar fetch
  try {
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function () {
        var args = arguments;
        return _fetch.apply(this, args).then(function (r) {
          try { var u = (r && r.url) || ('' + args[0]); if (/orders-live|deliveries-win/i.test(u)) { r.clone().text().then(function (t) { procesar(u, t); }).catch(function () {}); } } catch (e) {}
          return r;
        });
      };
    }
  } catch (e) {}

  // Interceptar XMLHttpRequest
  try {
    var _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__faltUrl = u; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      this.addEventListener('load', function () { try { if (/orders-live|deliveries-win/i.test(self.__faltUrl || '')) procesar(self.__faltUrl, self.responseText); } catch (e) {} });
      return _send.apply(this, arguments);
    };
  } catch (e) {}

  // Arranque: badge + saludo inmediato al puente (claves vacias) para confirmar conexion.
  function iniciar() {
    ponerBadge();
    log('detector cargado en', PLATAFORMA || host);
    enviar([]); // saludo: aparece en http://localhost:8787/api/activos aunque aun no haya pedidos
  }
  if (document.body) iniciar();
  else document.addEventListener('DOMContentLoaded', iniciar);

  // Latido: reenviar las ultimas claves cada 20s (mantiene fresca la senal en el puente).
  setInterval(function () { enviar(ultimasClaves); }, 20000);
})();
