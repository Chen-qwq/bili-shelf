(() => {
  if (globalThis.__BILI_SHELF_CONTENT_V056__) return;
  globalThis.__BILI_SHELF_CONTENT_V056__ = true;

  let previewBox = null;
  let previewTimer = null;
  let hoverTimer = null;
  let leaveTimer = null;
  let currentBvid = null;
  let currentAnchor = null;
  let settingsCache = null;
  let settingsLoadedAt = 0;
  let pageHookTokenCache = '';
  let shortcutBusy = false;

  const DEFAULT_SETTINGS = {
    previewEnabled: true,
    previewMuted: true,
    previewRequireAlt: true,
    previewHoverDelay: 2000,
    previewRate: 4,
    previewVolume: 70,
    shortcutKey: 'u',
    preserveVideoRate: true,
    focusPageAfterOpen: true,
    preservePlayerMode: true,
    theaterLayout: false
  };

  function extractBvid(url = '') {
    return url.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] || null;
  }

  function videoUrl(bvid) {
    return `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;
  }

  function createPageHookToken() {
    try {
      if (crypto.randomUUID) return crypto.randomUUID();
      if (crypto.getRandomValues) {
        return Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-');
      }
    } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function pageHookToken() {
    const root = document.documentElement;
    if (!root) return '';
    if (!pageHookTokenCache) {
      pageHookTokenCache = createPageHookToken();
      root.dataset.biliShelfHookToken = pageHookTokenCache;
    }
    return pageHookTokenCache;
  }

  function normalizePageFavEvent(event) {
    if (!event || !['add', 'del'].includes(event.action)) return null;
    const aid = Number(event.aid);
    if (!Number.isSafeInteger(aid) || aid <= 0) return null;
    const folderIds = [...new Set(
      (Array.isArray(event.folderIds) ? event.folderIds : [])
        .map(value => String(value).trim())
        .filter(value => /^\d+$/.test(value) && value !== '0')
    )].slice(0, 100);
    if (!folderIds.length) return null;
    return { action: event.action, aid, folderIds };
  }

  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, response => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.ok) return reject(new Error(response?.error || '未知错误'));
        resolve(response.data);
      });
    });
  }

  async function getSettings(force = false) {
    const now = Date.now();
    if (!force && settingsCache && now - settingsLoadedAt < 1200) return settingsCache;
    try {
      const s = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
      settingsCache = { ...DEFAULT_SETTINGS, ...s };
      if (!settingsCache.shortcutKey) settingsCache.shortcutKey = 'u';
      settingsLoadedAt = now;
      return settingsCache;
    } catch (_) {
      return DEFAULT_SETTINGS;
    }
  }


  function getCurrentVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    return videos.find(v => Number.isFinite(v.duration) && v.duration > 30) || videos[0] || null;
  }

  function validPlaybackRate(rate) {
    const n = Number(rate);
    return Number.isFinite(n) && n >= 0.25 && n <= 16;
  }

  let recordRateTimer = 0;
  async function recordPlaybackRate(video = getCurrentVideo()) {
    const bvid = extractBvid(location.href);
    if (!bvid || !video) return;
    const rate = Number(video.playbackRate || 1);
    if (!validPlaybackRate(rate)) return;
    clearTimeout(recordRateTimer);
    recordRateTimer = setTimeout(async () => {
      try {
        await chrome.storage.local.set({
          biliShelfLastPlaybackRate: rate,
          biliShelfLastPlaybackBvid: bvid,
          biliShelfLastPlaybackRateAt: Date.now()
        });
      } catch (_) {}
    }, 120);
  }

  function applyPlaybackRate(rate) {
    if (!validPlaybackRate(rate)) return false;
    const videos = Array.from(document.querySelectorAll('video'));
    let applied = false;
    for (const video of videos) {
      try {
        video.defaultPlaybackRate = Number(rate);
        video.playbackRate = Number(rate);
        applied = true;
      } catch (_) {}
    }
    return applied;
  }

  function focusPageForKeyboard() {
    try { window.focus(); } catch (_) {}
    try {
      const active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === 'function') active.blur();
    } catch (_) {}
    try {
      document.documentElement.setAttribute('tabindex', '-1');
      document.documentElement.focus({ preventScroll: true });
    } catch (_) {}
    try {
      if (document.body) {
        document.body.setAttribute('tabindex', '-1');
        document.body.focus({ preventScroll: true });
      }
    } catch (_) {}
  }
  const THEATER_STYLE_ID = 'bili-shelf-theater-layout-style';

  function isVideoPage() {
    return Boolean(extractBvid(location.href));
  }

  function ensureTheaterStyle() {
    if (document.getElementById(THEATER_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = THEATER_STYLE_ID;
    style.textContent = `
      html.bili-shelf-theater-layout,
      html.bili-shelf-theater-layout body {
        background: #000 !important;
      }
      html.bili-shelf-theater-layout .bili-header,
      html.bili-shelf-theater-layout .bili-header__bar,
      html.bili-shelf-theater-layout .mini-header,
      html.bili-shelf-theater-layout .international-header,
      html.bili-shelf-theater-layout #biliMainHeader,
      html.bili-shelf-theater-layout .right-container,
      html.bili-shelf-theater-layout .recommend-container,
      html.bili-shelf-theater-layout .recommend-list,
      html.bili-shelf-theater-layout .recommend-list-v1,
      html.bili-shelf-theater-layout .video-page-card-small,
      html.bili-shelf-theater-layout .video-info-container,
      html.bili-shelf-theater-layout .video-desc-container,
      html.bili-shelf-theater-layout .video-toolbar-container,
      html.bili-shelf-theater-layout .video-tag-container,
      html.bili-shelf-theater-layout .left-container-under-player,
      html.bili-shelf-theater-layout #commentapp,
      html.bili-shelf-theater-layout .comment-m,
      html.bili-shelf-theater-layout .comment,
      html.bili-shelf-theater-layout .reply-warp,
      html.bili-shelf-theater-layout .video-note-sidebar-panel,
      html.bili-shelf-theater-layout .video-note-sidebar-chapter-layer,
      html.bili-shelf-theater-layout .video-note-sidebar-chapter-portal,
      html.bili-shelf-theater-layout .ad-report,
      html.bili-shelf-theater-layout #bannerAd,
      html.bili-shelf-theater-layout #right-bottom-banner {
        display: none !important;
      }
      html.bili-shelf-theater-layout,
      html.bili-shelf-theater-layout body {
        min-width: 0 !important;
        max-width: 100% !important;
        overflow-x: hidden !important;
      }
      html.bili-shelf-theater-layout #app,
      html.bili-shelf-theater-layout .video-container-v1,
      html.bili-shelf-theater-layout .video-container,
      html.bili-shelf-theater-layout .left-container,
      html.bili-shelf-theater-layout .left-container-v1,
      html.bili-shelf-theater-layout .video-left-container,
      html.bili-shelf-theater-layout .player-wrap,
      html.bili-shelf-theater-layout .player-wrap-v1,
      html.bili-shelf-theater-layout #bilibili-player,
      html.bili-shelf-theater-layout .bpx-player-container {
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
      }
      html.bili-shelf-theater-layout .player-wrap,
      html.bili-shelf-theater-layout .player-wrap-v1,
      html.bili-shelf-theater-layout #bilibili-player,
      html.bili-shelf-theater-layout .bpx-player-container {
        height: auto !important;
        min-height: 0 !important;
      }
      html.bili-shelf-theater-layout .video-container-v1 {
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
      html.bili-shelf-theater-layout .left-container,
      html.bili-shelf-theater-layout .left-container-v1,
      html.bili-shelf-theater-layout .video-left-container {
        flex: 0 0 100% !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  async function applyTheaterLayoutFromSettings({ fresh = false } = {}) {
    if (!isVideoPage()) return;
    const settings = await getSettings(fresh);
    if (settings.theaterLayout === true) {
      ensureTheaterStyle();
      document.documentElement.classList.add('bili-shelf-theater-layout');
      ensureTheaterWebFullscreen();
    } else {
      document.documentElement.classList.remove('bili-shelf-theater-layout');
      clearInterval(theaterWebFullscreenInterval);
    }
    try {
      const notifyResize = () => window.dispatchEvent(new Event('resize'));
      requestAnimationFrame(notifyResize);
      setTimeout(notifyResize, 120);
      setTimeout(notifyResize, 600);
      setTimeout(notifyResize, 1600);
    } catch (_) {}
  }

  function playerContainer() {
    return document.querySelector('.bpx-player-container, #bilibili-player, .bilibili-player, .player-wrap, .player-wrap-v1');
  }

  function classBlob() {
    const nodes = [document.documentElement, document.body, playerContainer(), document.querySelector('.bpx-player-container')].filter(Boolean);
    return nodes.map(n => String(n.className || '')).join(' ').toLowerCase();
  }

  function textBlob(el) {
    return [el?.className, el?.title, el?.ariaLabel, el?.getAttribute?.('aria-label'), el?.getAttribute?.('data-title')].map(v => String(v || '')).join(' ').toLowerCase();
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect?.();
    const style = getComputedStyle(el);
    return rect && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isWideMode() {
    const blob = classBlob();
    return /wide|widescreen|wide-screen|mode-wide/.test(blob) || Boolean(document.querySelector('.bpx-player-ctrl-wide-leave'));
  }

  function isWebFullscreenMode() {
    const blob = classBlob();
    return /webscreen|web-fullscreen|webfullscreen|mode-web/.test(blob) || Boolean(document.querySelector('.bpx-player-ctrl-web-leave'));
  }

  function isBrowserFullscreenMode() {
    return Boolean(document.fullscreenElement) || /mode-fullscreen|full-screen|fullscreen/.test(classBlob());
  }

  function getPlayerLayout() {
    return {
      bvid: extractBvid(location.href) || '',
      wide: isWideMode(),
      webFullscreen: isWebFullscreenMode(),
      fullscreen: isBrowserFullscreenMode(),
      theaterLayout: document.documentElement.classList.contains('bili-shelf-theater-layout'),
      ts: Date.now()
    };
  }

  function findPlayerButton(kind) {
    const candidates = Array.from(document.querySelectorAll('button, div, span'));
    const patterns = kind === 'web'
      ? [/bpx-player-ctrl-web/, /网页全屏/]
      : kind === 'wide'
        ? [/bpx-player-ctrl-wide/, /宽屏/]
        : [/bpx-player-ctrl-full/, /(?<!网页)全屏/];
    const filtered = candidates.filter(el => isVisible(el) && patterns.some(re => re.test(textBlob(el))));
    const enter = filtered.find(el => !/退出|leave|exit|off/.test(textBlob(el)));
    return enter || filtered[0] || null;
  }

  function clickPlayerButton(kind) {
    const btn = findPlayerButton(kind);
    if (!btn) return false;
    try {
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      btn.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  let theaterWebFullscreenInterval = 0;
  function ensureTheaterWebFullscreen() {
    clearInterval(theaterWebFullscreenInterval);
    if (!document.documentElement.classList.contains('bili-shelf-theater-layout')) return;
    const apply = () => {
      if (!document.documentElement.classList.contains('bili-shelf-theater-layout')) {
        clearInterval(theaterWebFullscreenInterval);
        return;
      }
      if (isWebFullscreenMode()) {
        clearInterval(theaterWebFullscreenInterval);
        recordPlayerLayout();
        return;
      }
      if (clickPlayerButton('web')) recordPlayerLayout();
    };
    apply();
    const start = Date.now();
    theaterWebFullscreenInterval = setInterval(() => {
      if (Date.now() - start > 12000 || isWebFullscreenMode()) {
        clearInterval(theaterWebFullscreenInterval);
        return;
      }
      apply();
    }, 900);
  }

  let layoutRecordTimer = 0;
  async function recordPlayerLayout() {
    if (!isVideoPage()) return;
    clearTimeout(layoutRecordTimer);
    layoutRecordTimer = setTimeout(async () => {
      try { await chrome.storage.local.set({ biliShelfLastPlayerLayout: getPlayerLayout() }); } catch (_) {}
    }, 180);
  }

  let layoutRestoreInterval = 0;
  async function restorePendingPlayerLayout() {
    if (!isVideoPage()) return;
    await applyTheaterLayoutFromSettings();
    let data;
    try {
      data = await chrome.storage.local.get(['preservePlayerMode', 'pendingPlayerLayoutRestore', 'theaterLayout']);
    } catch (_) {
      return;
    }
    const pending = data.pendingPlayerLayoutRestore || {};
    if (pending.theaterLayout === true || data.theaterLayout === true) {
      ensureTheaterStyle();
      document.documentElement.classList.add('bili-shelf-theater-layout');
    }
    if (data.preservePlayerMode === false) return;
    const bvid = extractBvid(location.href);
    if (pending.bvid && pending.bvid !== bvid) return;
    if (Date.now() - Number(pending.ts || 0) > 90_000) return;

    const apply = () => {
      try {
        if (pending.webFullscreen && !isWebFullscreenMode()) clickPlayerButton('web');
        else if (pending.wide && !isWideMode() && !isWebFullscreenMode()) clickPlayerButton('wide');
        // 浏览器真正全屏通常需要用户手势，这里只记录，不强行触发。
        recordPlayerLayout();
      } catch (_) {}
    };
    apply();
    clearInterval(layoutRestoreInterval);
    const start = Date.now();
    layoutRestoreInterval = setInterval(() => {
      if (Date.now() - start > 12000) {
        clearInterval(layoutRestoreInterval);
        return;
      }
      apply();
    }, 900);
  }

  function setupPlayerModeTracking() {
    if (!isVideoPage()) return;
    const record = () => recordPlayerLayout();
    document.addEventListener('click', record, true);
    document.addEventListener('fullscreenchange', record, true);
    let mutationTimer = 0;
    const scheduleRecord = () => {
      if (mutationTimer) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = 0;
        record();
      }, 500);
    };
    const target = document.querySelector('#bilibili-player, .bpx-player-container, .bilibili-player, .player-wrap, .player-wrap-v1') || document.body;
    const obs = new MutationObserver(scheduleRecord);
    try { obs.observe(target || document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class'] }); } catch (_) {}
    setTimeout(record, 1000);
    setTimeout(restorePendingPlayerLayout, 500);
    setTimeout(restorePendingPlayerLayout, 1800);
    setTimeout(restorePendingPlayerLayout, 3600);
  }


  let restoreInterval = 0;
  async function restorePendingPlaybackRate({ focus = false } = {}) {
    const bvid = extractBvid(location.href);
    if (!bvid) return;
    let data;
    try {
      data = await chrome.storage.local.get(['preserveVideoRate', 'pendingVideoRateRestore']);
    } catch (_) {
      return;
    }
    if (data.preserveVideoRate === false) return;
    const pending = data.pendingVideoRateRestore || {};
    if (!validPlaybackRate(pending.rate)) return;
    if (pending.bvid && pending.bvid !== bvid) return;
    if (Date.now() - Number(pending.ts || 0) > 90_000) return;

    if (focus) focusPageForKeyboard();
    const rate = Number(pending.rate);
    applyPlaybackRate(rate);
    try {
      await chrome.storage.local.set({
        biliShelfLastPlaybackRate: rate,
        biliShelfLastPlaybackBvid: bvid,
        biliShelfLastPlaybackRateAt: Date.now()
      });
    } catch (_) {}

    clearInterval(restoreInterval);
    const start = Date.now();
    restoreInterval = setInterval(() => {
      if (Date.now() - start > 12000) {
        clearInterval(restoreInterval);
        return;
      }
      applyPlaybackRate(rate);
    }, 700);
  }

  function setupPlaybackRateTracking() {
    if (!extractBvid(location.href)) return;
    const bind = video => {
      if (!video || video.dataset.biliShelfRateBound === '1') return;
      video.dataset.biliShelfRateBound = '1';
      video.addEventListener('ratechange', () => recordPlaybackRate(video), true);
      video.addEventListener('play', () => recordPlaybackRate(video), true);
      video.addEventListener('loadedmetadata', () => {
        restorePendingPlaybackRate({ focus: false });
        recordPlaybackRate(video);
      }, true);
      recordPlaybackRate(video);
    };
    document.querySelectorAll('video').forEach(bind);
    const pendingNodes = new Set();
    let bindTimer = 0;
    const flushPendingNodes = () => {
      bindTimer = 0;
      const nodes = [...pendingNodes];
      pendingNodes.clear();
      for (const node of nodes) {
        if (node.matches?.('video')) bind(node);
        node.querySelectorAll?.('video').forEach(bind);
      }
    };
    const queueAddedNode = node => {
      if (node?.nodeType !== 1) return;
      pendingNodes.add(node);
      if (!bindTimer) bindTimer = setTimeout(flushPendingNodes, 120);
    };
    const obs = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) queueAddedNode(node);
      }
    });
    obs.observe(document.body || document.documentElement || document, { childList: true, subtree: true });
    restorePendingPlaybackRate({ focus: true });
  }

  function showToast(text, type = 'info') {
    const old = document.querySelector('.bfs-toast');
    if (old) old.remove();
    const div = document.createElement('div');
    div.className = `bfs-toast bfs-${type}`;
    div.textContent = text;
    Object.assign(div.style, {
      position: 'fixed',
      zIndex: 2147483647,
      right: '22px',
      top: '22px',
      maxWidth: '360px',
      padding: '10px 12px',
      borderRadius: '10px',
      color: '#fff',
      background: type === 'error' ? '#d93025' : '#1a73e8',
      fontSize: '14px',
      boxShadow: '0 8px 24px rgba(0,0,0,.2)'
    });
    document.documentElement.appendChild(div);
    setTimeout(() => div.remove(), 2600);
  }

  function closePreview() {
    currentBvid = null;
    currentAnchor = null;
    clearTimeout(previewTimer);
    clearTimeout(hoverTimer);
    clearTimeout(leaveTimer);
    if (previewBox) {
      try {
        const iframe = previewBox.querySelector('iframe');
        if (iframe) iframe.src = 'about:blank';
      } catch (_) {}
      previewBox.remove();
      previewBox = null;
    }
  }

  function intersects(a, b, margin = 10) {
    return !(
      a.left >= b.right + margin ||
      a.right <= b.left - margin ||
      a.top >= b.bottom + margin ||
      a.bottom <= b.top - margin
    );
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function choosePreviewPosition(sourceRect, width, height) {
    const gap = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const candidates = [
      { name: 'right', left: sourceRect.right + gap, top: sourceRect.top },
      { name: 'left', left: sourceRect.left - width - gap, top: sourceRect.top },
      { name: 'bottom', left: sourceRect.left, top: sourceRect.bottom + gap },
      { name: 'top', left: sourceRect.left, top: sourceRect.top - height - gap },
      { name: 'bottom-right', left: vw - width - gap, top: vh - height - gap },
      { name: 'bottom-left', left: gap, top: vh - height - gap },
      { name: 'top-right', left: vw - width - gap, top: gap },
      { name: 'top-left', left: gap, top: gap }
    ].map(c => ({
      ...c,
      left: clamp(c.left, gap, vw - width - gap),
      top: clamp(c.top, gap, vh - height - gap)
    }));

    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      const rect = { left: c.left, top: c.top, right: c.left + width, bottom: c.top + height };
      const inside = c.left >= gap && c.top >= gap && c.left + width <= vw - gap && c.top + height <= vh - gap;
      const noOverlap = !intersects(rect, sourceRect, 12);
      const distance = Math.hypot(c.left - sourceRect.left, c.top - sourceRect.top);
      const score = (inside ? 1000 : 0) + (noOverlap ? 600 : -800) - distance * 0.02;
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  }

  async function makePreview(bvid, rect) {
    closePreview();
    const settings = await getSettings();
    currentBvid = bvid;

    const width = Math.min(440, Math.max(320, Math.round(window.innerWidth * 0.28)));
    const height = Math.round(width * 9 / 16) + 34;
    const pos = choosePreviewPosition(rect, width, height);

    previewBox = document.createElement('div');
    previewBox.className = 'bfs-preview-box';
    Object.assign(previewBox.style, {
      position: 'fixed',
      zIndex: 2147483646,
      left: `${pos.left}px`,
      top: `${pos.top}px`,
      width: `${width}px`,
      height: `${height}px`,
      background: '#0b0b0b',
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: '0 12px 40px rgba(0,0,0,.35)',
      border: '1px solid rgba(255,255,255,.18)',
      cursor: 'pointer'
    });

    const bar = document.createElement('div');
    bar.textContent = `${settings.previewRate || 4}x 悬停预览 · 点击进入详情页${settings.previewMuted ? '' : ' · 声音开启'}`;
    Object.assign(bar.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      top: '0',
      zIndex: '3',
      height: '30px',
      padding: '7px 10px',
      color: '#fff',
      fontSize: '12px',
      fontWeight: '650',
      background: 'linear-gradient(rgba(0,0,0,.7), rgba(0,0,0,0))',
      pointerEvents: 'none'
    });

    const iframe = document.createElement('iframe');
    const muted = settings.previewMuted ? '1' : '0';
    const rate = encodeURIComponent(String(settings.previewRate || 4));
    iframe.src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=1&autoplay=1&muted=${muted}&t=0&danmaku=0&high_quality=0&as_wide=1&bfs_preview=1&bfs_rate=${rate}&bfs_speed=${rate}&bfs_volume=${encodeURIComponent(settings.previewVolume ?? 70)}`;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.referrerPolicy = 'origin-when-cross-origin';
    Object.assign(iframe.style, {
      width: '100%',
      height: '100%',
      border: '0',
      display: 'block'
    });

    const clickLayer = document.createElement('div');
    Object.assign(clickLayer.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '4',
      background: 'transparent'
    });
    clickLayer.title = '点击进入视频详情页';
    clickLayer.addEventListener('click', () => { window.location.href = videoUrl(bvid); });

    previewBox.appendChild(iframe);
    previewBox.appendChild(bar);
    previewBox.appendChild(clickLayer);
    previewBox.addEventListener('mouseenter', () => clearTimeout(leaveTimer));
    previewBox.addEventListener('mouseleave', () => closePreview());
    document.documentElement.appendChild(previewBox);
  }

  function getVideoAnchor(target) {
    const a = target.closest?.('a[href*="/video/BV"]');
    if (a) return a;
    const card = target.closest?.('.small-item, .fav-video-list li, .video-card, .bili-video-card, .bili-video-card__wrap, .list-item, li, article');
    return card?.querySelector?.('a[href*="/video/BV"]') || null;
  }

  function getCoverLikeTarget(target, anchor) {
    return target.closest?.('img, picture, .cover, .bili-video-card__cover, .b-img, .pic, .video-cover') || anchor?.querySelector?.('img, picture, .cover, .bili-video-card__cover, .b-img, .pic, .video-cover');
  }

  document.addEventListener('mouseover', async event => {
    const anchor = getVideoAnchor(event.target);
    if (!anchor) return;
    const bvid = extractBvid(anchor.href);
    if (!bvid || bvid === currentBvid) return;
    const imageTarget = getCoverLikeTarget(event.target, anchor);
    if (!imageTarget) return;

    const settings = await getSettings();
    if (!settings.previewEnabled) return;
    if (settings.previewRequireAlt !== false && !event.altKey) return;

    clearTimeout(hoverTimer);
    clearTimeout(leaveTimer);
    currentAnchor = anchor;
    const delay = Math.max(1200, Number(settings.previewHoverDelay ?? 2000));
    const tokenAnchor = anchor;
    hoverTimer = setTimeout(() => {
      if (currentAnchor !== tokenAnchor) return;
      if (!document.contains(imageTarget)) return;
      const rect = imageTarget.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 30) return;
      makePreview(bvid, rect);
    }, delay);
  }, true);

  document.addEventListener('mouseout', event => {
    const related = event.relatedTarget;
    if (previewBox?.contains(related)) return;
    if (currentAnchor?.contains?.(related)) return;
    const anchor = getVideoAnchor(event.target);
    if (anchor && !anchor.contains(related)) {
      clearTimeout(hoverTimer);
      leaveTimer = setTimeout(closePreview, 220);
    }
  }, true);

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable || Boolean(el.closest?.('[contenteditable="true"], .ql-editor, .reply-box, .bili-rich-textarea'));
  }

  document.addEventListener('keydown', async event => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) return;
    if (isTypingTarget(event.target)) return;
    const settings = await getSettings();
    const key = String(settings.shortcutKey || 'u').toLowerCase();
    if (event.key.toLowerCase() !== key) return;

    const bvid = extractBvid(location.href);
    if (!bvid) return;
    event.preventDefault();
    if (shortcutBusy) return;
    shortcutBusy = true;
    try {
      await send('UNFAV_CURRENT_VIDEO', { bvid });
    } catch (e) {
      showToast(e.message || String(e), 'error');
    } finally {
      setTimeout(() => { shortcutBusy = false; }, 800);
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'BILI_FAV_SORTER_TOAST') {
      showToast(message.text, message.toastType);
      return;
    }
    if (message?.type === 'BILI_SHELF_GET_PLAYBACK_RATE') {
      const video = getCurrentVideo();
      const rate = video?.playbackRate || 0;
      sendResponse({ ok: true, rate: validPlaybackRate(rate) ? Number(rate) : 0, bvid: extractBvid(location.href) || '' });
      return true;
    }
    if (message?.type === 'BILI_SHELF_GET_PLAYER_LAYOUT') {
      sendResponse({ ok: true, layout: getPlayerLayout() });
      return true;
    }
    if (message?.type === 'BILI_SHELF_APPLY_LAYOUT_SETTINGS') {
      applyTheaterLayoutFromSettings({ fresh: true }).then(() => restorePendingPlayerLayout()).finally(() => {
        try { sendResponse?.({ ok: true, layout: getPlayerLayout() }); } catch (_) {}
      });
      return true;
    }
    if (message?.type === 'BILI_SHELF_FOCUS_PAGE') {
      focusPageForKeyboard();
      restorePendingPlaybackRate({ focus: true });
      restorePendingPlayerLayout();
      sendResponse?.({ ok: true });
      return true;
    }
  });

  function injectPageHook() {
    pageHookToken();
    if (document.documentElement.dataset.bfsHookInjected === '1') return;
    document.documentElement.dataset.bfsHookInjected = '1';
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-hook.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'BILI_FAV_SORTER_PAGE_HOOK') return;
    if (data.token !== pageHookToken()) return;
    const eventData = normalizePageFavEvent(data.event);
    if (!eventData) return;
    chrome.runtime.sendMessage({ type: 'BILI_PAGE_FAV_CHANGED', event: eventData }, () => void chrome.runtime.lastError);
  });

  window.addEventListener('scroll', closePreview, { passive: true, capture: true });
  window.addEventListener('wheel', () => clearTimeout(hoverTimer), { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) closePreview(); });
  window.addEventListener('blur', closePreview);

  try { setupPlaybackRateTracking(); } catch (_) {}
  try { setupPlayerModeTracking(); } catch (_) {}
  try { applyTheaterLayoutFromSettings(); } catch (_) {}
  try { injectPageHook(); } catch (_) {}
})();
