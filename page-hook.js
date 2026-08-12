(() => {
  if (window.__BILI_FAV_SORTER_HOOKED__) return;
  window.__BILI_FAV_SORTER_HOOKED__ = true;

  function parseBody(body) {
    try {
      if (!body) return new URLSearchParams();
      if (typeof body === 'string') return new URLSearchParams(body);
      if (body instanceof URLSearchParams) return body;
      if (body instanceof FormData) {
        const p = new URLSearchParams();
        for (const [k, v] of body.entries()) p.append(k, String(v));
        return p;
      }
    } catch (_) {}
    return new URLSearchParams();
  }

  function emitFavChange(url, body) {
    try {
      if (!String(url || '').includes('/x/v3/fav/resource/deal')) return;
      const p = parseBody(body);
      const rid = p.get('rid');
      if (!rid) return;
      const del = p.get('del_media_ids');
      const add = p.get('add_media_ids');
      const action = del ? 'del' : (add ? 'add' : '');
      const folderIds = String(del || add || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!action || !folderIds.length) return;
      window.postMessage({
        source: 'BILI_FAV_SORTER_PAGE_HOOK',
        event: {
          action,
          aid: Number(rid),
          folderIds,
          source: 'bilibili-page',
          ts: Date.now()
        }
      }, '*');
    } catch (_) {}
  }

  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function(input, init = {}) {
      try {
        const url = typeof input === 'string' ? input : input?.url;
        const body = init?.body;
        const promise = rawFetch.apply(this, arguments);
        promise.then(res => {
          try { if (res && res.ok) emitFavChange(url, body); } catch (_) {}
        }).catch(() => {});
        return promise;
      } catch (_) {
        return rawFetch.apply(this, arguments);
      }
    };
  }

  const RawXHR = window.XMLHttpRequest;
  if (RawXHR && RawXHR.prototype) {
    const rawOpen = RawXHR.prototype.open;
    const rawSend = RawXHR.prototype.send;
    RawXHR.prototype.open = function(method, url) {
      this.__bfs_url = url;
      return rawOpen.apply(this, arguments);
    };
    RawXHR.prototype.send = function(body) {
      try {
        this.addEventListener('load', () => {
          try { if (this.status >= 200 && this.status < 300) emitFavChange(this.__bfs_url, body); } catch (_) {}
        });
      } catch (_) {}
      return rawSend.apply(this, arguments);
    };
  }
})();
