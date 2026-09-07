(function () {
  'use strict';

  var CAT = {
    fire:       { label: 'Fire',        color: '#e0562f' },
    storm:      { label: 'Storm',       color: '#4a9ec9' },
    derelict:   { label: 'Derelict',    color: '#b8a37e' },
    demolished: { label: 'Demolished',  color: '#8a7f9c' },
    business:   { label: 'Business closed', color: '#a883e0' },
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

  // Data files change often. Revalidate them with the server rather than
  // letting a stale copy sit in the browser cache showing old counts.
  var FRESH = { cache: 'no-cache' };

  var markers = {};   // id -> L.Marker
  var map, layer;

  // second, uncurated layer: the government's own derelict-site register
  var registerLayer, registerMeta = null, registerCount = 0, registerOn = false;
  var registerPoints = [];
  var nearCircle = null;   // the radius drawn on the map

  // third layer: Canmore, the national record
  var canmoreLayer, canmoreRenderer, canmoreMeta = null;
  var canmorePoints = { wartime: [], township: [], unverified: [] };
  var canmoreOn = {};   // seeded from CANMORE_GROUPS once they are defined

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
    // All the bulk layers share ONE canvas. They used to have a canvas each so
    // that a CSS glow filter could be applied per pane, but each canvas covers
    // the whole map, so the topmost one swallowed every click and the layers
    // underneath were dead. The glow is drawn into the canvas instead, as a
    // wide translucent stroke in the dot's own colour.
    map.createPane('bulk');
    map.getPane('bulk').style.zIndex = 392;

    // tolerance gives every dot a few pixels of click slack — a 3px dot with a
    // halo looks bigger than its hit area, so without it people miss
    var bulk = L.canvas({ pane: 'bulk', padding: .3, tolerance: 6 });
    canmoreRenderer = { township: bulk, wartime: bulk, unverified: bulk, register: bulk };

    canmoreLayer = {};
    Object.keys(CANMORE_GROUPS).forEach(function (g) {
      canmoreLayer[g] = L.layerGroup();
      canmoreOn[g] = CANMORE_GROUPS[g].on;
    });
    registerLayer = L.layerGroup();   // land, not buildings: off until asked for
    layer = L.layerGroup().addTo(map);

    // Hand any popup carrying a photo slot its picture once Commons answers.
    // The coordinates come off the popup itself rather than from the marker,
    // because this fires before the marker's own popupopen listener.
    map.on('popupopen', function (e) {
      var ll = e.popup.getLatLng(), el = e.popup.getElement();
      if (!ll || !el) return;
      var title = el.querySelector('.pop-title');
      hydratePhoto(el, +ll.lat.toFixed(5), +ll.lng.toFixed(5),
                   title ? title.textContent : '', e.popup);
    });
  }

  // ---------- Canmore: the national record of the historic environment ------

  // The first two are records whose text confirms something survives. The third
  // is everything Canmore simply does not describe: it may be a bunker, it may
  // be a field. Off by default, and labelled so nobody is misled.
  var CANMORE_GROUPS = {
    wartime:    { label: 'Wartime remains', color: '#e8894a', on: true },
    township:   { label: 'Deserted settlements', color: '#5fb0a8', on: true },
    unverified: { label: 'Condition unknown', color: '#7c7f86', on: false }
  };

  function loadCanmore() {
    return fetch('data/canmore.json', FRESH)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.sites) return;
        canmoreMeta = data.meta;

        data.sites.forEach(function (s) {
          var key = s.k ? s.g : 'unverified';
          var g = CANMORE_GROUPS[key];
          if (!g) return;
          var m = L.circleMarker([s.lat, s.lng], {
            renderer: canmoreRenderer[key],
            radius: 2.8,
            fillColor: g.color, fillOpacity: .95,
            color: g.color, weight: 5, opacity: .28   // the halo
          });
          m.bindTooltip(esc(s.n), { direction: 'top', offset: [0, -4], className: 'site-tip' });
          m.bindPopup(function () {
            return '<div class="photo-slot"></div>' +
              '<h3 class="pop-title">' + esc(s.n) + '</h3>' +
              '<p class="pop-meta"><span style="color:' + g.color + '">' + esc(g.label) + '</span>' +
                ' &middot; ' + esc(s.s) + (s.r ? ' &middot; ' + esc(s.r) : '') + '</p>' +
              mapLinks(s.lat, s.lng) +
              '<p class="pop-flag">' +
                (s.k
                  ? 'Canmore records remains surviving here. '
                  : 'Canmore does not state what survives here. ') +
                'Positioned to the nearest ' + (s.p === 1 ? '1 metre' : '10 metres') + '. ' +
                (s.u ? '<a href="https://www.trove.scot/place/' + s.u +
                       '" target="_blank" rel="noopener noreferrer">Read the record</a> ' : '') +
                'for the description. Any photograph is one taken near these coordinates, ' +
                'not necessarily of this site.</p>';
          });
          canmorePoints[key].push({ lat: s.lat, lng: s.lng, m: m });
          canmoreLayer[key].addLayer(m);
        });

        Object.keys(canmoreLayer).forEach(function (g) {
          if (canmoreOn[g]) map.addLayer(canmoreLayer[g]);
        });
      })
      .catch(function () { /* the rest of the map works without it */ });
  }

  function setCanmore(group, on) {
    canmoreOn[group] = on;
    if (on) map.addLayer(canmoreLayer[group]); else map.removeLayer(canmoreLayer[group]);
    var row = els.legend.querySelector('.lg-row[data-layer="' + group + '"]');
    if (row) {
      row.classList.toggle('off', !on);
      row.setAttribute('aria-pressed', String(on));
    }
  }

  function applyCanmoreFilter() {
    var n = state.near, shown = 0;
    Object.keys(canmorePoints).forEach(function (g) {
      canmoreLayer[g].clearLayers();
      canmorePoints[g].forEach(function (p) {
        if (n && distKm(n.lat, n.lng, p.lat, p.lng) > n.km) return;
        canmoreLayer[g].addLayer(p.m);
        shown++;
      });
      if (!canmoreOn[g]) map.removeLayer(canmoreLayer[g]);
    });
    return shown;
  }

  // Rows straight from the Scottish Vacant and Derelict Land Survey. No
  // write-up and no photo: what the government publishes is all there is.
  function loadRegister() {
    return fetch('data/register.json', FRESH)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.sites) return;
        registerMeta = data.meta;
        registerCount = data.sites.length;

        data.sites.forEach(function (s) {
          // sites the register says still have buildings on them are worth
          // more than a bare plot, so they read a little stronger
          var m = L.circleMarker([s.lat, s.lng], {
            renderer: canmoreRenderer.register,
            radius: s.b ? 3.4 : 2.6,
            color: s.b ? '#c9b28a' : '#9c8d7c',
            fillColor: s.b ? '#c9b28a' : '#9c8d7c',
            weight: 4, opacity: .2,                  // the halo
            fillOpacity: s.b ? .9 : .7
          });
          m.bindTooltip(esc(s.n), { direction: 'top', offset: [0, -4], className: 'site-tip' });
          m.bindPopup(
            '<div class="photo-slot"></div>' +
            '<h3 class="pop-title">' + esc(s.n) + '</h3>' +
            '<p class="pop-meta">' + esc(s.a || '') + (s.a ? ' &middot; ' : '') + esc(s.r) + '</p>' +
            '<p class="pop-meta">' +
              (s.b ? '<strong>Buildings still on site.</strong><br>' : '') +
              (s.p ? '<strong>Was:</strong> ' + esc(s.p) + '<br>' : '') +
              (s.t ? '<strong>Derelict since:</strong> ' + esc(s.t) + '<br>' : '') +
              (s.ha ? '<strong>Size:</strong> ' + esc(s.ha) + ' ha<br>' : '') +
              (s.o ? '<strong>Owner:</strong> ' + esc(s.o) : '') +
            '</p>' +
            mapLinks(s.lat, s.lng) +
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
    if (!registerOn) map.removeLayer(registerLayer);
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

  // ---------- photos fetched on demand ----------
  //
  // Most points have no picture stored. Rather than ship thousands of image
  // records, ask Wikimedia Commons for freely-licensed photographs taken near
  // the coordinates, and only at the moment someone opens that popup. Results
  // are cached for the session so a second look costs nothing.

  var photoCache = {};   // "lat,lng" -> {url, credit, license, page} | null

  function nearbyPhoto(lat, lng) {
    var key = lat + ',' + lng;
    if (photoCache[key] !== undefined) return Promise.resolve(photoCache[key]);

    var url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      generator: 'geosearch', ggscoord: lat + '|' + lng,
      ggsradius: '250', ggslimit: '8', ggsnamespace: '6',
      prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '480'
    });

    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var pages = (j && j.query && j.query.pages) ? Object.keys(j.query.pages).map(function (k) {
          return j.query.pages[k];
        }) : [];

        var hit = null;
        for (var i = 0; i < pages.length && !hit; i++) {
          var p = pages[i], ii = (p.imageinfo || [])[0];
          if (!ii || !ii.thumburl) continue;
          // maps, plans and diagrams are not photographs of the place
          if (/\.(svg|pdf|djvu|tif|ogv|webm)$/i.test(p.title)) continue;
          if (/(map|plan|diagram|chart|coat.of.arms|logo)/i.test(p.title)) continue;
          var em = ii.extmetadata || {};
          var txt = function (v) { return v ? String(v.value).replace(/<[^>]*>/g, '').trim() : ''; };
          hit = {
            url: ii.thumburl.split('?')[0].replace('https://thumb.wikimedia.org/', 'https://upload.wikimedia.org/'),
            credit: txt(em.Artist).replace(/\s+/g, ' ').slice(0, 60),
            license: txt(em.LicenseShortName),
            page: ii.descriptionurl,
            nearby: true
          };
        }
        photoCache[key] = hit;
        return hit;
      })
      .catch(function () { photoCache[key] = null; return null; });
  }

  // Fill the placeholder inside an open popup once the lookup comes back.
  function hydratePhoto(popupEl, lat, lng, name, popup) {
    var slot = popupEl.querySelector('.photo-slot');
    if (!slot || slot.dataset.done) return;
    slot.dataset.done = '1';

    var content = popupEl.querySelector('.leaflet-popup-content');

    // Hand the finished markup back through setContent rather than editing the
    // DOM in place: Leaflet re-renders a popup from its stored content, so an
    // injected node would be wiped the next time it measures itself.
    var publish = function (html) {
      // the popup may have been closed, or re-rendered out from under us,
      // while Commons was answering
      if (!popup || !popup.isOpen() || !content || !slot.parentNode) return;
      slot.outerHTML = html;
      popup.setContent(content.innerHTML);
    };

    nearbyPhoto(lat, lng).then(function (img) {
      if (!img) { publish(''); return; }

      // wait for the picture to decode before showing it, so the popup is
      // measured and panned once, at its real height
      var pre = new Image();
      pre.onerror = function () { publish(''); };
      pre.onload = function () {
        var credit = [img.credit, img.license].filter(Boolean).join(' · ');
        publish(
          '<figure class="pop-photo">' +
            '<img src="' + esc(img.url) + '" alt="' + esc(name) + '">' +
            '<figcaption>' +
              'Nearby on Commons' + (credit ? ' — ' : '') +
              (img.page
                ? '<a href="' + esc(img.page) + '" target="_blank" rel="noopener noreferrer">' + esc(credit) + '</a>'
                : esc(credit)) +
            '</figcaption>' +
          '</figure>');
      };
      pre.src = img.url;
    });
  }

  // Google Maps links built from the coordinates. The satellite link is the
  // useful one here: from above you can usually see whether a roof is still on.
  function mapLinks(lat, lng) {
    var q = lat + ',' + lng;
    return '<p class="pop-maps">' +
      '<a href="https://www.google.com/maps/search/?api=1&amp;query=' + q +
        '" target="_blank" rel="noopener noreferrer">Google Maps</a>' +
      '<a href="https://www.google.com/maps/@?api=1&amp;map_action=map&amp;center=' + q +
        '&amp;zoom=18&amp;basemap=satellite" target="_blank" rel="noopener noreferrer">Satellite</a>' +
      '<a href="https://www.google.com/maps/dir/?api=1&amp;destination=' + q +
        '" target="_blank" rel="noopener noreferrer">Directions</a>' +
      '<a href="https://www.openstreetmap.org/?mlat=' + lat + '&amp;mlon=' + lng +
        '#map=17/' + lat + '/' + lng + '" target="_blank" rel="noopener noreferrer">OSM</a>' +
    '</p>';
  }

  function popupHtml(s) {
    var cat = CAT[s.category] || { label: s.category, color: '#999' };
    var html =
      (s.image ? figureHtml(s, 'pop-photo') : '<div class="photo-slot"></div>') +
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
        : '') +
      mapLinks(s.lat, s.lng);

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
      var can = applyCanmoreFilter();
      els.count.textContent = items.length + ' site' + (items.length === 1 ? '' : 's') +
        ' within ' + state.near.km + ' km of ' + state.near.name;
      els.summary.textContent = items.length + ' near ' + state.near.name;
      els.nearStatus.textContent = items.length + ' mapped site' + (items.length === 1 ? '' : 's') +
        (registerCount ? ' · ' + reg + ' on the register' : '') +
        (canmoreMeta ? ' · ' + can + ' on Canmore' : '') +
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
        (registerCount || canmoreMeta
          ? '<p class="lg-head">Other layers <em>(tap to toggle)</em></p>' +
            (registerCount
              ? '<button class="lg-row off" data-layer="register" aria-pressed="false">' +
                  '<span class="lg-dot lg-dot-sm" style="background:#8d7f70"></span>' +
                  '<span class="lg-label">Derelict land register</span>' +
                  '<span class="lg-n">' + registerCount + '</span>' +
                '</button>'
              : '') +
            Object.keys(CANMORE_GROUPS).map(function (g) {
              if (!canmorePoints[g].length) return '';
              var on = canmoreOn[g];
              return '<button class="lg-row' + (on ? '' : ' off') + '" data-layer="' + g +
                       '" aria-pressed="' + on + '">' +
                '<span class="lg-dot lg-dot-sm lg-glow" style="background:' + CANMORE_GROUPS[g].color +
                  ';--glow:' + CANMORE_GROUPS[g].color + '"></span>' +
                '<span class="lg-label">' + esc(CANMORE_GROUPS[g].label) + '</span>' +
                '<span class="lg-n">' + canmorePoints[g].length + '</span>' +
              '</button>';
            }).join('')
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
      var lay = e.target.closest('.lg-row[data-layer]');
      if (lay) {
        var which = lay.dataset.layer;
        if (which === 'register') setRegister(!registerOn);
        else setCanmore(which, !canmoreOn[which]);
        return;
      }

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
      applyCanmoreFilter();
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

  fetch('data/sites.json', FRESH)
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
      // the legend needs the layer counts, so wait for them before building
      return Promise.all([loadRegister(), loadCanmore()]);
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
