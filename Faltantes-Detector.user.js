// ==UserScript==
// @name         Faltantes - Detector de entregas (Rappi / PedidosYa)
// @namespace    faltantes-delivery
// @version      1.0.0
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

  // Estados que significan que el pedido YA salio (no cuenta como activo) en PedidosYa.
  var PEYA_FUERA = /CANCEL|DELIVER|CLOSED|PICKED|DISPATCH|COMPLET|REJECT|VOID|EXPIRE/i;

  var ultimaFirma = {};   // plataforma -> firma de las claves (para no repetir envios iguales)
  var ultimasClaves = {}; // plataforma -> ultimas claves enviadas (para el latido)

  function enviar(plataforma, claves) {
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: PUENTE,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ platform: plataforma, keys: claves }),
        timeout: 4000,
        onload: function () {}, onerror: function () {}, ontimeout: function () {}
      });
    } catch (e) {}
  }

  function registrar(plataforma, claves) {
    var firma = JSON.stringify(claves.slice().sort());
    if (ultimaFirma[plataforma] === firma) return; // sin cambios: el latido lo reenvia
    ultimaFirma[plataforma] = firma;
    ultimasClaves[plataforma] = claves;
    enviar(plataforma, claves);
  }

  function procesar(url, texto) {
    try {
      if (/orders-live/i.test(url)) {
        var j = JSON.parse(texto);
        var data = (j && j.data) || [];
        var claves = [];
        for (var i = 0; i < data.length; i++) {
          var o = data[i];
          if (o && o.state === 'in_store' && o.id != null) claves.push(String(o.id)); // en tienda = aun lo debo
        }
        registrar('Rappi', claves);
      } else if (/deliveries-win/i.test(url)) {
        var arr = JSON.parse(texto);
        if (!Array.isArray(arr)) return;
        var cl = [];
        for (var k = 0; k < arr.length; k++) {
          var p = arr[k];
          if (!p) continue;
          if (PEYA_FUERA.test(String(p.state || ''))) continue; // cancelado/entregado/recogido = fuera
          if (p.externalId != null) cl.push(String(p.externalId));
          if (p.shortCode != null) cl.push(String(p.shortCode));
        }
        registrar('PedidosYa', cl);
      }
    } catch (e) {}
  }

  // Interceptar fetch
  try {
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function () {
        var args = arguments;
        return _fetch.apply(this, args).then(function (r) {
          try {
            var u = (r && r.url) || ('' + args[0]);
            if (/orders-live|deliveries-win/i.test(u)) { r.clone().text().then(function (t) { procesar(u, t); }).catch(function () {}); }
          } catch (e) {}
          return r;
        });
      };
    }
  } catch (e) {}

  // Interceptar XMLHttpRequest
  try {
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__faltUrl = u; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      this.addEventListener('load', function () {
        try { if (/orders-live|deliveries-win/i.test(self.__faltUrl || '')) procesar(self.__faltUrl, self.responseText); } catch (e) {}
      });
      return _send.apply(this, arguments);
    };
  } catch (e) {}

  // Latido: reenviar las ultimas claves cada 30s para que el puente sepa que la lectura sigue fresca.
  setInterval(function () {
    for (var p in ultimasClaves) { if (Object.prototype.hasOwnProperty.call(ultimasClaves, p)) enviar(p, ultimasClaves[p]); }
  }, 30000);
})();
