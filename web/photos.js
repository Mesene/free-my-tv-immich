/*
 * Your Immich photos as the home screen's background (Samsung and LG builds with immich_server in config.properties).
 *
 * The photos of one album (immich_album, or every album shared with the account when it's empty) are kept on the TV,
 * in IndexedDB, so the home screen opens with one at once, without waiting for the network. Every few hours, while the
 * home screen is on, the copy is brought up to date: photos no longer in the album go, new ones come, up to MAX.
 * The background changes every immich_minutes minutes and each time the home screen comes back.
 *
 * Immich takes the account's email and password (immich_email, immich_password): use an account made for the TV,
 * not an administrator, with only the album shared with it. They are built into the package, so keep it to yourself.
 */
var Photos = (function () {
  'use strict';

  var C = window.CONFIG || {};
  var SERVER = (C.immichServer || '').replace(/\/+$/, '');
  var ON = !!(SERVER && C.immichEmail && C.immichPassword && window.indexedDB);
  var MAX = 60;                                   // photos kept on the TV (Immich's preview: ~150-400 KB each)
  var PER_REFRESH = 20;                           // new photos fetched at most per refresh
  var REFRESH_MS = 6 * 3600000;                   // how often the copy is brought up to date
  var EVERY_MS = Math.max(1, parseInt(C.immichMinutes, 10) || 10) * 60000;

  var db = null, ids = [], current = null, shown = null, timer = 0, busy = false, onShow = null;

  function log(msg) { try { console.log('[Photos] ' + msg); } catch (e) {} }
  function stored(key) { try { return localStorage.getItem('fmtv.immich.' + key); } catch (e) { return null; } }
  function store(key, v) { try { localStorage.setItem('fmtv.immich.' + key, String(v)); } catch (e) {} }

  // MARK: - The copy on the TV (IndexedDB: {id, blob, at})

  function open(done) {
    var req;
    try { req = window.indexedDB.open('fmtv-immich', 1); } catch (e) { done(e); return; }
    req.onupgradeneeded = function () { req.result.createObjectStore('photos', {keyPath: 'id'}); };
    req.onsuccess = function () { db = req.result; done(null); };
    req.onerror = function () { done(req.error || new Error('IndexedDB')); };
  }

  function tx(mode) { return db.transaction('photos', mode).objectStore('photos'); }

  /** Every photo's id, oldest first. */
  function listIds(done) {
    var out = [], req = tx('readonly').openCursor();
    req.onsuccess = function () {
      var c = req.result;
      if (c) { out.push({id: c.value.id, at: c.value.at || 0}); c['continue'](); return; }
      out.sort(function (a, b) { return a.at - b.at; });
      done(out.map(function (o) { return o.id; }));
    };
    req.onerror = function () { done([]); };
  }

  function getBlob(id, done) {
    var req = tx('readonly').get(id);
    req.onsuccess = function () { done(req.result ? req.result.blob : null); };
    req.onerror = function () { done(null); };
  }

  function put(id, blob, done) {
    var req = tx('readwrite').put({id: id, blob: blob, at: Date.now()});
    req.onsuccess = function () { done(true); };
    req.onerror = function () { done(false); };
  }

  function remove(list, done) {
    if (!list.length) { done(); return; }
    var s = tx('readwrite'), left = list.length;
    for (var i = 0; i < list.length; i++) {
      var r = s['delete'](list[i]);
      r.onsuccess = r.onerror = function () { if (--left === 0) done(); };
    }
  }

  // MARK: - Showing them

  /** Another photo than the one on screen, at random. */
  function pickOther() {
    if (!ids.length) return null;
    if (ids.length === 1) return ids[0];
    var id;
    do { id = ids[Math.floor(Math.random() * ids.length)]; } while (id === current);
    return id;
  }

  function show(id) {
    if (!id || !db) return;
    getBlob(id, function (blob) {
      if (!blob) return;
      var url = URL.createObjectURL(blob), old = shown;
      current = id;
      shown = url;
      store('last', id);
      if (onShow) onShow(url);
      // The previous one stays until the new one has faded in over it.
      if (old) setTimeout(function () { URL.revokeObjectURL(old); }, 4000);
    });
  }

  function next() {
    if (!ON || !db) return;
    show(pickOther());
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (document.hidden) { schedule(); return; }   // behind another app: nothing to change, nobody sees it
      next();
      refresh(false);   // only does something every REFRESH_MS
    }, EVERY_MS);
  }

  // MARK: - Immich

  function request(method, path, token, body, type, done) {
    var x = new XMLHttpRequest(), over = false;
    x.open(method, SERVER + path, true);
    x.timeout = 30000;
    if (type) x.responseType = type;
    if (token) x.setRequestHeader('Authorization', 'Bearer ' + token);
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || over) return;
      over = true;
      if (x.status < 200 || x.status >= 300) { done(new Error(method + ' ' + path + ': HTTP ' + x.status)); return; }
      if (type === 'blob') { done(null, x.response); return; }
      var json;
      try { json = JSON.parse(x.responseText); } catch (e) { done(e); return; }
      done(null, json);
    };
    x.ontimeout = x.onerror = function () { if (!over) { over = true; done(new Error(method + ' ' + path + ': no connection')); } };
    x.send(body ? JSON.stringify(body) : null);
  }

  function login(done) {
    request('POST', '/api/auth/login', null, {email: C.immichEmail, password: C.immichPassword}, null, function (err, r) {
      if (err || !r || !r.accessToken) { done(err || new Error('login: no token')); return; }
      done(null, r.accessToken);
    });
  }

  /** The album(s) to show: the one named immich_album, or every album shared with the account. */
  function albums(token, done) {
    request('GET', '/api/albums?shared=true', token, null, null, function (err, shared) {
      if (err) { done(err); return; }
      request('GET', '/api/albums', token, null, null, function (err2, own) {
        var all = (shared || []).concat(err2 ? [] : own || []), seen = {}, out = [];
        var want = (C.immichAlbum || '').toLowerCase().replace(/^\s+|\s+$/g, '');
        for (var i = 0; i < all.length; i++) {
          var a = all[i];
          if (!a || seen[a.id]) continue;
          seen[a.id] = true;
          if (!want || (a.albumName || '').toLowerCase().replace(/^\s+|\s+$/g, '') === want) out.push(a.id);
        }
        done(out.length ? null : new Error(want ? 'no album named "' + C.immichAlbum + '"' : 'no albums shared'), out);
      });
    });
  }

  function isPhoto(a) { return a && a.id && (a.type || 'IMAGE') === 'IMAGE'; }

  /**
   * An album's photos' ids. Older Immich puts them in the album itself; newer ones only through the search, whose
   * answer has had a few shapes.
   */
  function albumPhotos(token, albumId, done) {
    request('GET', '/api/albums/' + albumId + '?withoutAssets=false', token, null, null, function (err, album) {
      if (!err && album && album.assets && album.assets.length) {
        done(null, album.assets.filter(isPhoto).map(function (a) { return a.id; }));
        return;
      }
      var out = [], page = 1;
      (function more() {
        request('POST', '/api/search/metadata', token, {albumIds: [albumId], type: 'IMAGE', size: 1000, page: page}, null,
          function (e, r) {
            if (e) { done(out.length ? null : e, out); return; }
            var box = r && r.assets ? r.assets : r, items = box && box.items ? box.items : box;
            if (!items || typeof items.length !== 'number') { done(out.length ? null : new Error('search: odd answer'), out); return; }
            for (var i = 0; i < items.length; i++) if (isPhoto(items[i])) out.push(items[i].id);
            var nextPage = box && box.nextPage ? parseInt(box.nextPage, 10) : 0;
            if (nextPage > page && page < 20) { page = nextPage; more(); } else done(null, out);
          });
      })();
    });
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /** Brings the copy up to date with the album: what left it goes, new photos come (PER_REFRESH at a time). */
  function refresh(force) {
    if (!ON || !db || busy) return;
    var last = parseInt(stored('refreshed') || '0', 10);
    if (!force && ids.length && Date.now() - last < REFRESH_MS) return;
    busy = true;
    function end(msg) { busy = false; if (msg) log(msg); }
    login(function (err, token) {
      if (err) { end(err.message); return; }
      albums(token, function (err2, list) {
        if (err2) { end(err2.message); return; }
        var inAlbum = {}, all = [], k = 0;
        (function each() {
          if (k < list.length) {
            albumPhotos(token, list[k++], function (e, photoIds) {
              if (e) log(e.message);
              for (var i = 0; i < (photoIds || []).length; i++) {
                if (!inAlbum[photoIds[i]]) { inAlbum[photoIds[i]] = true; all.push(photoIds[i]); }
              }
              each();
            });
            return;
          }
          if (!all.length) { end('the album has no photos'); return; }
          var gone = ids.filter(function (id) { return !inAlbum[id]; });
          remove(gone, function () {
            var kept = {};
            ids = ids.filter(function (id) { kept[id] = !!inAlbum[id]; return inAlbum[id]; });
            var fresh = shuffle(all.filter(function (id) { return !kept[id]; })).slice(0, PER_REFRESH);
            download(token, fresh, function (added) {
              // Past MAX, the oldest go first, so the copy keeps turning over the whole album.
              var over = Math.max(0, ids.length - MAX), old = ids.slice(0, over);
              remove(old, function () {
                ids = ids.slice(over);
                store('refreshed', Date.now());
                end(added + ' new, ' + gone.length + ' gone, ' + ids.length + ' on the TV');
                if (!current && ids.length) next();   // the very first ones: show one now
              });
            });
          });
        })();
      });
    });
  }

  function download(token, list, done) {
    var added = 0, i = 0;
    (function one() {
      if (i >= list.length) { done(added); return; }
      var id = list[i++];
      request('GET', '/api/assets/' + id + '/thumbnail?size=preview', token, null, 'blob', function (err, blob) {
        if (err || !blob || !blob.size) { one(); return; }
        put(id, blob, function (ok) {
          if (ok) { added++; ids.push(id); if (!current) next(); }
          one();
        });
      });
    })();
  }

  // MARK: - Start

  /** Opens the copy and shows a photo from it at once; then, a little later, brings the copy up to date. */
  function start(showFn) {
    onShow = showFn;
    if (!ON) return;
    open(function (err) {
      if (err) { log('IndexedDB: ' + (err.message || err)); ON = false; return; }
      listIds(function (list) {
        ids = list;
        if (ids.length) {
          // A different one than the last time the TV was on.
          current = stored('last');
          next();
        }
        setTimeout(function () { refresh(false); }, ids.length ? 20000 : 1000);
      });
    });
  }

  /** A random photo's own address (the screensaver's: whoever takes it lets it go with URL.revokeObjectURL). */
  var lastRandom = null;
  function random(done) {
    if (!ON || !db || !ids.length) { done(null); return; }
    var id;
    do { id = ids[Math.floor(Math.random() * ids.length)]; } while (ids.length > 1 && id === lastRandom);
    lastRandom = id;
    getBlob(id, function (blob) { done(blob ? URL.createObjectURL(blob) : null); });
  }

  return {
    enabled: function () { return ON; },
    /** Whether a photo of yours is on the background now. */
    active: function () { return ON && !!shown; },
    start: start,
    next: next,
    random: random,
    refresh: refresh,
    count: function () { return ids.length; }
  };
})();
