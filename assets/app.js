(function () {
  'use strict';

  var CAT = {
    fire:       { label: 'Fire',        color: '#e0562f' },
    storm:      { label: 'Storm',       color: '#4a9ec9' },
    derelict:   { label: 'Derelict',    color: '#b8a37e' },
    demolished: { label: 'Demolished',  color: '#8a7f9c' },
    ruin:       { label: 'Ruin',        color: '#6f9c6a' },
    village:    { label: 'Depopulated', color: '#57a99a' }
  };

  var TYPES = {};   // filled from data.meta.types

  // how likely you are to run into a fence, a camera or a person
  var ACCESS = {
    open:      { color: '#6f9c6a' },
    private:   { color: '#b8a37e' },
    secured:   { color: '#d9822b' },
    patrolled: { color: '#e0562f' },
    gone:      { color: '#7a7069' }
  };
  var ACCESS_LABEL = {};   // filled from data.meta.access

  var state = {
    sites: [],
    active: Object.keys(CAT),   // enabled categories
    type: '',                   // '' = all types
    access: '',                 // '' = any access status
    near: null,                 // {lat, lng, name, km} once a town is searched
    query: '',
    sort: 'recent',
    selected: null
  };

  var markers = {};   // id -> L.Marker
  var map, layer;

  // second, uncurated layer: the government's own derelict-site register
  var registerLayer, registerMeta = null, registerCount = 0, registerOn = true;
  var registerPoints = [];
  var nearCircle = null;   // the radius drawn on the map

  var els = {
    list: document.getElementById('list'),
    search: document.getElementById('search'),
    filters: document.getElementById('filters'),
    sort: document.getElementById('sort'),
    type: document.getElementById('type'),
    access: document.getElementById('access'),
    accessNote: document.getElementById('access-note'),
    registerNote: document.getElementById('register-note'),
    scopeNote: document.getElementById('scope-note'),
    count: document.getElementById('count'),
    updated: document.getElementById('updated'),
    sidebar: document.getElementById('sidebar'),
    toggle: document.getElementById('toggle-sidebar'),
    legend: document.getElementById('legend'),
    handle: document.getElementById('sheet-handle'),
    summary: document.getElementById('sheet-summary'),
    nearbar: document.getElementById('nearbar'),
    nearInput: document.getElementById('near-input'),
    nearRadius: document.getElementById('near-radius'),
    nearClear: document.getElementById('near-clear'),
    nearStatus: document.getElementById('near-status')
  };

  // great-circle distance in km
  function distKm(aLat, aLng, bLat, bLng) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * rad) * Math.cos(bLat * rad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function isMobile() {
    return window.matchMedia('(max-width: 760px)').matches;
  }

  // collapsed on mobile = sheet parked at the bottom; on desktop = sidebar slid out
  function setCollapsed(on) {
    els.sidebar.classList.toggle('collapsed', on);
    els.handle.setAttribute('aria-expanded', String(!on));
    setTimeout(function () { map.invalidateSize(); }, 300);
  }

  function accessBadge(s) {
    var a = ACCESS[s.access];
    if (!a) return '';
    return '<span class="access" style="--access-color:' + a.color + '">' +
             esc(ACCESS_LABEL[s.access] || s.access) +
           '</span>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- map ----------

  function initMap() {
    map = L.map('map', { zoomControl: false }).setView([56.8, -4.2], 6);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    registerLayer = L.layerGroup().addTo(map);   // under the curated pins
    layer = L.layerGroup().addTo(map);
  }

  // Rows straight from the Scottish Vacant and Derelict Land Survey. No
  // write-up and no photo: what the government publishes is all there is.
  function loadRegister() {
    return fetch('data/register.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.sites) return;
        registerMeta = data.meta;
        registerCount = data.sites.length;

        data.sites.forEach(function (s) {
          var m = L.circleMarker([s.lat, s.lng], {
            radius: 3.5, weight: 1,
            color: '#8d7f70', fillColor: '#8d7f70',
            opacity: .65, fillOpacity: .35
          });
          m.bindTooltip(esc(s.n), { direction: 'top', offset: [0, -4], className: 'site-tip' });
          m.bindPopup(
            '<h3 class="pop-title">' + esc(s.n) + '</h3>' +
            '<p class="pop-meta">' + esc(s.a || '') + (s.a ? ' &middot; ' : '') + esc(s.r) + '</p>' +
            '<p class="pop-meta">' +
              (s.p ? '<strong>Was:</strong> ' + esc(s.p) + '<br>' : '') +
              (s.t ? '<strong>Derelict since:</strong> ' + esc(s.t) + '<br>' : '') +
              (s.ha ? '<strong>Size:</strong> ' + esc(s.ha) + ' ha<br>' : '') +
              (s.o ? '<strong>Owner:</strong> ' + esc(s.o) : '') +
            '</p>' +
            '<p class="pop-flag">From the official register — no description or photo, and the pin marks the site area rather than a building. ' +
              '<a href="' + esc(registerMeta.url) + '" target="_blank" rel="noopener noreferrer">Source</a></p>'
          );
          registerPoints.push({ lat: s.lat, lng: s.lng, m: m });
          registerLayer.addLayer(m);
        });
      })
      .catch(function () { /* the curated map works without it */ });
  }

  // the register layer follows the town search too
  function applyRegisterFilter() {
    registerLayer.clearLayers();
    var n = state.near, shown = 0;
    registerPoints.forEach(function (p) {
      if (n && distKm(n.lat, n.lng, p.lat, p.lng) > n.km) return;
      registerLayer.addLayer(p.m);
      shown++;
    });
    return shown;
  }

  function setRegister(on) {
    registerOn = on;
    if (on) map.addLayer(registerLayer); else map.removeLayer(registerLayer);
    var row = els.legend.querySelector('.lg-row[data-layer="register"]');
    if (row) {
      row.classList.toggle('off', !on);
      row.setAttribute('aria-pressed', String(on));
    }
  }

  function pinIcon(cat, selected) {
    var color = (CAT[cat] || {}).color || '#999';
    return L.divIcon({
      className: '',
      html: '<div class="pin' + (selected ? ' sel' : '') + '" style="background:' + color + '"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
  }

  // photo + the credit line its licence requires
  function figureHtml(s, cls) {
    if (!s.image || !s.image.url) return '';
    var credit = [s.image.credit, s.image.license].filter(Boolean).join(' · ');
    return '<figure class="' + cls + '">' +
      '<img src="' + esc(s.image.url) + '" alt="' + esc(s.name) + '" loading="lazy" decoding="async">' +
      (credit
        ? '<figcaption>' +
            (s.image.page
              ? '<a href="' + esc(s.image.page) + '" target="_blank" rel="noopener noreferrer">' + esc(credit) + '</a>'
              : esc(credit)) +
          '</figcaption>'
        : '') +
    '</figure>';
  }

  // what you get for hovering a pin: the photo if there is one, else just the name
  function tooltipHtml(s) {
    var cat = CAT[s.category] || { label: s.category, color: '#999' };
    return figureHtml(s, 'tip-photo') +
      '<p class="tip-name">' + esc(s.name) + '</p>' +
      '<p class="tip-meta"><span style="color:' + cat.color + '">' + esc(cat.label) + '</span>' +
        ' · ' + esc(s.region) + '</p>';
  }

  function popupHtml(s) {
    var cat = CAT[s.category] || { label: s.category, color: '#999' };
    var html =
      figureHtml(s, 'pop-photo') +
      '<h3 class="pop-title">' + esc(s.name) + '</h3>' +
      '<p class="pop-meta">' +
        '<span class="tag" style="color:' + cat.color + '">' + esc(cat.label) + '</span>' +
        ' &middot; ' + esc(TYPES[s.type] || s.type) +
        ' &middot; ' + esc(s.region) +
        (s.year ? ' &middot; ' + esc(s.year) : '') +
      '</p>' +
      '<p class="pop-body">' + esc(s.summary) + '</p>' +
      '<p class="pop-meta"><strong>Status:</strong> ' + esc(s.status) + '</p>' +
      '<p class="pop-access">' + accessBadge(s) +
        (s.accessNote ? '<span class="access-why">' + esc(s.accessNote) + '</span>' : '') +
      '</p>' +
      (s.partlyOccupied
        ? '<p class="pop-occupied"><strong>Part of this site is in use.</strong> ' +
            esc(s.partlyOccupied) + ' The pin covers the whole site, not just the empty part.</p>'
        : '');

    if (s.source) {
      html += '<p class="pop-src">Source: <a href="' + esc(s.source) + '" target="_blank" rel="noopener noreferrer">' +
              esc(s.sourceName || s.source) + '</a></p>';
    }
    if (s.confidence === 'approximate') {
      html += '<span class="pop-flag">Location approximate — pinned to the site area, not an exact address.</span>';
    }
    return html;
  }

  function buildMarkers() {
    state.sites.forEach(function (s) {
      var m = L.marker([s.lat, s.lng], { icon: pinIcon(s.category, false) });
      m.bindPopup(popupHtml(s));

      // hover preview. Leaflet builds tooltip content on open, so the photo is
      // only fetched when someone actually points at the pin.
      m.bindTooltip(tooltipHtml(s), {
        direction: 'top',
        offset: [0, -12],
        opacity: 1,
        className: 'site-tip' + (s.image ? ' has-photo' : '')
      });
      m.on('click', function () { select(s.id, false); });
      markers[s.id] = m;
    });
  }

  // ---------- filtering ----------

  function visible() {
    var q = state.query.trim().toLowerCase();
    var out = state.sites.filter(function (s) {
      if (state.active.indexOf(s.category) === -1) return false;
      if (state.type && s.type !== state.type) return false;
      if (state.access && s.access !== state.access) return false;
      if (state.near) {
        s._km = distKm(state.near.lat, state.near.lng, s.lat, s.lng);
        if (s._km > state.near.km) return false;
      }
      if (!q) return true;
      return (s.name + ' ' + s.region + ' ' + s.summary + ' ' + s.status + ' ' +
              s.category + ' ' + s.type + ' ' + (TYPES[s.type] || '') + ' ' +
              s.access + ' ' + (ACCESS_LABEL[s.access] || '') + ' ' + (s.accessNote || ''))
        .toLowerCase().indexOf(q) !== -1;
    });

    // a town search overrides the sort: nearest first is the only useful order
    if (state.near) {
      out.sort(function (a, b) { return a._km - b._km; });
      return out;
    }

    if (state.sort === 'name') {
      out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    } else if (state.sort === 'region') {
      out.sort(function (a, b) { return a.region.localeCompare(b.region) || a.name.localeCompare(b.name); });
    } else {
      out.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
    }
    return out;
  }

  function render() {
    var items = visible();

    layer.clearLayers();
    items.forEach(function (s) { layer.addLayer(markers[s.id]); });

    if (state.near) {
      var reg = applyRegisterFilter();
      els.count.textContent = items.length + ' site' + (items.length === 1 ? '' : 's') +
        ' within ' + state.near.km + ' km of ' + state.near.name;
      els.summary.textContent = items.length + ' near ' + state.near.name;
      els.nearStatus.textContent = items.length + ' mapped site' + (items.length === 1 ? '' : 's') +
        (registerCount ? ' · ' + reg + ' on the official register' : '') +
        ' within ' + state.near.km + ' km';
      els.nearStatus.classList.remove('err');
    } else {
      els.count.textContent = items.length + ' of ' + state.sites.length + ' sites shown';
      els.summary.textContent = items.length === state.sites.length
        ? items.length + ' sites'
        : items.length + ' of ' + state.sites.length + ' sites';
    }

    if (!items.length) {
      els.list.innerHTML = '<li class="empty">Nothing matches those filters.</li>';
      return;
    }

    els.list.innerHTML = items.map(function (s) {
      var cat = CAT[s.category] || { label: s.category, color: '#999' };
      return '<li data-id="' + esc(s.id) + '"' + (s.id === state.selected ? ' class="active"' : '') + '>' +
        '<p class="item-title">' + esc(s.name) + '</p>' +
        '<div class="item-meta">' +
          '<span class="tag" style="color:' + cat.color + '">' +
            '<span class="dot" style="background:' + cat.color + '"></span>' + esc(cat.label) +
          '</span>' +
          '<span>' + esc(TYPES[s.type] || s.type) + '</span>' +
          '<span>' + esc(s.region) + '</span>' +
          (state.near ? '<span class="km">' + (s._km < 10 ? s._km.toFixed(1) : Math.round(s._km)) + ' km</span>' : '') +
          (s.year ? '<span>' + esc(s.year) + '</span>' : '') +
          accessBadge(s) +
          (s.partlyOccupied ? '<span class="occupied">Partly in use</span>' : '') +
        '</div>' +
      '</li>';
    }).join('');
  }

  function select(id, fly) {
    state.selected = id;
    var s = state.sites.find(function (x) { return x.id === id; });
    if (!s) return;

    Object.keys(markers).forEach(function (k) {
      markers[k].setIcon(pinIcon(
        state.sites.find(function (x) { return x.id === k; }).category,
        k === id
      ));
    });

    if (fly) {
      var go = function () {
        map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 12), { duration: .7 });
        markers[id].openPopup();
      };
      // on a phone the sheet covers the map, so park it first
      if (isMobile()) {
        setCollapsed(true);
        setTimeout(go, 300);
      } else {
        go();
      }
    }

    Array.prototype.forEach.call(els.list.children, function (li) {
      li.classList.toggle('active', li.dataset.id === id);
    });
  }

  // ---------- controls ----------

  function buildFilters() {
    els.filters.innerHTML = Object.keys(CAT).map(function (key) {
      var c = CAT[key];
      var n = state.sites.filter(function (s) { return s.category === key; }).length;
      return '<button class="chip on" data-cat="' + key + '" style="--chip-color:' + c.color + '" aria-pressed="true">' +
        '<span class="dot"></span>' + esc(c.label) + ' <span>' + n + '</span></button>';
    }).join('');

    els.filters.addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (btn) toggleCategory(btn.dataset.cat);
    });
  }

  // The panel is closed by default, so the legend has to carry the category
  // filter as well as explain the colours.
  function buildLegend() {
    var counts = {};
    state.sites.forEach(function (s) { counts[s.category] = (counts[s.category] || 0) + 1; });

    var cats = Object.keys(CAT).map(function (k) {
      return '<button class="lg-row" data-cat="' + k + '" aria-pressed="true" ' +
               'title="Show or hide these">' +
        '<span class="lg-dot" style="background:' + CAT[k].color + '"></span>' +
        '<span class="lg-label">' + esc(CAT[k].label) + '</span>' +
        '<span class="lg-n">' + (counts[k] || 0) + '</span>' +
      '</button>';
    }).join('');

    var acc = Object.keys(ACCESS_LABEL).map(function (k) {
      return '<span class="lg-row static">' +
        '<span class="lg-dot" style="background:' + ((ACCESS[k] || {}).color || '#999') + '"></span>' +
        '<span class="lg-label">' + esc(ACCESS_LABEL[k]) + '</span>' +
      '</span>';
    }).join('');

    els.legend.innerHTML =
      '<button id="legend-toggle" aria-expanded="true" aria-controls="legend-body">' +
        '<span>Legend</span><span class="lg-chevron">–</span>' +
      '</button>' +
      '<div id="legend-body">' +
        '<p class="lg-head">Pin colour — what happened <em>(tap to filter)</em></p>' + cats +
        (registerCount
          ? '<p class="lg-head">Second layer</p>' +
            '<button class="lg-row" data-layer="register" aria-pressed="true" ' +
              'title="Show or hide the official register">' +
              '<span class="lg-dot lg-dot-sm" style="background:#8d7f70"></span>' +
              '<span class="lg-label">Official register</span>' +
              '<span class="lg-n">' + registerCount + '</span>' +
            '</button>'
          : '') +
        '<p class="lg-head">Badge colour — access</p>' + acc +
      '</div>';

    els.legend.addEventListener('click', function (e) {
      if (e.target.closest('#legend-toggle')) {
        var open = els.legend.classList.toggle('closed') === false;
        els.legend.querySelector('#legend-toggle').setAttribute('aria-expanded', String(open));
        els.legend.querySelector('.lg-chevron').textContent = open ? '–' : '+';
        return;
      }
      var lay = e.target.closest('.lg-row[data-layer="register"]');
      if (lay) { setRegister(!registerOn); return; }

      var row = e.target.closest('.lg-row[data-cat]');
      if (row) toggleCategory(row.dataset.cat);
    });
  }

  // ---------- search near a town ----------

  // Nominatim, bounded to Scotland. Only fired on submit, never per keystroke:
  // it is a free service run for everyone and their policy asks for restraint.
  function geocode(q) {
    var url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q: q + ', Scotland', format: 'json', limit: '1',
      countrycodes: 'gb', bounded: '1', viewbox: '-9,61,0,54.5'
    });
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (j) {
        if (!j.length) return null;
        var hit = j[0];
        return {
          lat: parseFloat(hit.lat),
          lng: parseFloat(hit.lon),
          name: String(hit.display_name).split(',')[0]
        };
      });
  }

  function drawNear() {
    if (nearCircle) { map.removeLayer(nearCircle); nearCircle = null; }
    if (!state.near) return;
    nearCircle = L.circle([state.near.lat, state.near.lng], {
      radius: state.near.km * 1000,
      color: '#d9822b', weight: 1, opacity: .55,
      fillColor: '#d9822b', fillOpacity: .05, interactive: false
    }).addTo(map);
    map.fitBounds(nearCircle.getBounds(), { padding: [40, 40] });
  }

  function setNear(near) {
    state.near = near;
    els.nearClear.hidden = !near;
    drawNear();
    render();
    if (!near) {
      applyRegisterFilter();
      els.nearStatus.textContent = '';
      els.nearStatus.classList.remove('err');
    }
  }

  function runNearSearch() {
    var q = els.nearInput.value.trim();
    if (!q) { setNear(null); return; }

    els.nearStatus.textContent = 'Looking up ' + q + '…';
    els.nearStatus.classList.remove('err');
    els.nearbar.classList.add('busy');

    geocode(q).then(function (hit) {
      els.nearbar.classList.remove('busy');
      if (!hit) {
        els.nearStatus.textContent = 'No place in Scotland matched “' + q + '”.';
        els.nearStatus.classList.add('err');
        return;
      }
      hit.km = parseInt(els.nearRadius.value, 10) || 25;
      setNear(hit);
    }).catch(function () {
      els.nearbar.classList.remove('busy');
      els.nearStatus.textContent = 'Place lookup is unavailable right now.';
      els.nearStatus.classList.add('err');
    });
  }

  function toggleCategory(cat) {
    if (!CAT[cat]) return;
    var i = state.active.indexOf(cat);
    if (i === -1) state.active.push(cat); else state.active.splice(i, 1);
    syncCategoryControls();
    render();
  }

  // chips in the panel and rows in the legend are two views of one filter
  function syncCategoryControls() {
    var mark = function (el, on, cls) {
      el.classList.toggle(cls, on);
      el.setAttribute('aria-pressed', String(cls === 'on' ? on : !on));
    };
    Array.prototype.forEach.call(els.filters.querySelectorAll('.chip'), function (b) {
      mark(b, state.active.indexOf(b.dataset.cat) !== -1, 'on');
    });
    Array.prototype.forEach.call(els.legend.querySelectorAll('.lg-row[data-cat]'), function (b) {
      mark(b, state.active.indexOf(b.dataset.cat) === -1, 'off');
    });
  }

  // an "all" option plus one per value actually present, with its count.
  // byCount keeps the type list ordered by size; access keeps its own order,
  // which runs from freely accessible to actively guarded.
  function fillSelect(el, field, labels, allLabel, byCount) {
    var counts = {};
    state.sites.forEach(function (s) { counts[s[field]] = (counts[s[field]] || 0) + 1; });

    var keys = Object.keys(labels).filter(function (k) { return counts[k]; });
    if (byCount) {
      keys.sort(function (a, b) { return counts[b] - counts[a] || labels[a].localeCompare(labels[b]); });
    }

    el.innerHTML = '<option value="">' + esc(allLabel) + ' (' + state.sites.length + ')</option>' +
      keys.map(function (k) {
        return '<option value="' + esc(k) + '">' + esc(labels[k]) + ' (' + counts[k] + ')</option>';
      }).join('');
  }

  function wire() {
    els.nearbar.addEventListener('submit', function (e) {
      e.preventDefault();
      runNearSearch();
    });

    els.nearRadius.addEventListener('change', function () {
      if (!state.near) return;
      state.near.km = parseInt(els.nearRadius.value, 10) || 25;
      drawNear();
      render();
    });

    els.nearClear.addEventListener('click', function () {
      els.nearInput.value = '';
      setNear(null);
    });

    els.type.addEventListener('change', function () {
      state.type = els.type.value;
      render();
    });

    els.access.addEventListener('change', function () {
      state.access = els.access.value;
      render();
    });

    els.search.addEventListener('input', function () {
      state.query = els.search.value;
      render();
    });

    els.sort.addEventListener('change', function () {
      state.sort = els.sort.value;
      render();
    });

    els.list.addEventListener('click', function (e) {
      var li = e.target.closest('li[data-id]');
      if (li) select(li.dataset.id, true);
    });

    els.toggle.addEventListener('click', function () {
      setCollapsed(!els.sidebar.classList.contains('collapsed'));
    });

    els.handle.addEventListener('click', function () {
      setCollapsed(!els.sidebar.classList.contains('collapsed'));
    });

    // keep the sheet from getting stuck in a state that only makes sense
    // on the other layout when the device is rotated or the window resized
    var wasMobile = isMobile();
    window.addEventListener('resize', function () {
      var now = isMobile();
      if (now !== wasMobile) {
        wasMobile = now;
        setCollapsed(now);
      } else {
        map.invalidateSize();
      }
    });
  }

  // ---------- boot ----------

  initMap();

  fetch('data/sites.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      state.sites = data.sites || [];
      TYPES = (data.meta && data.meta.types) || {};

      // the dataset decides which categories exist; drop any chip with nothing behind it
      var cats = (data.meta && data.meta.categories) || {};
      Object.keys(CAT).forEach(function (k) { if (!cats[k]) delete CAT[k]; });
      state.active = Object.keys(CAT);

      ACCESS_LABEL = (data.meta && data.meta.access) || {};
      if (data.meta && data.meta.scope) {
        els.scopeNote.innerHTML = '<strong>What is listed:</strong> ' + esc(data.meta.scope);
      }
      if (data.meta && data.meta.accessNote) {
        els.accessNote.textContent = data.meta.accessNote;
      }
      if (data.meta && data.meta.updated) {
        els.updated.textContent = 'Dataset updated ' + data.meta.updated + ' · ' + state.sites.length + ' entries.';
      }
      // the legend needs the register count, so wait for it before building
      return loadRegister();
    })
    .then(function () {
      if (registerMeta) {
        els.registerNote.innerHTML = '<strong>Second layer:</strong> ' + esc(registerMeta.note) +
          ' Source: <a href="' + esc(registerMeta.url) + '" target="_blank" rel="noopener noreferrer">' +
          esc(registerMeta.source) + '</a>, ' + esc(registerMeta.licence) + '.';
      }
      buildMarkers();
      buildFilters();
      buildLegend();
      fillSelect(els.type, 'type', TYPES, 'All types', true);
      fillSelect(els.access, 'access', ACCESS_LABEL, 'Any access status', false);
      wire();
      render();
      // the map is the point: it opens full-screen with the panel put away
      els.sidebar.classList.add('collapsed');
      els.handle.setAttribute('aria-expanded', 'false');
      // on a phone the legend would cover half the map, so it starts folded
      if (isMobile()) {
        els.legend.classList.add('closed');
        els.legend.querySelector('#legend-toggle').setAttribute('aria-expanded', 'false');
        els.legend.querySelector('.lg-chevron').textContent = '+';
      }
      setTimeout(function () { map.invalidateSize(); }, 320);
    })
    .catch(function (err) {
      els.list.innerHTML = '<li class="empty">Could not load data/sites.json (' + esc(err.message) +
        ').<br><br>If you opened this file directly from disk, run a local server instead:<br><code>python -m http.server 8000</code></li>';
    });

})();
