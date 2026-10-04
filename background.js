const BILI = {
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  folders: 'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
  resources: 'https://api.bilibili.com/x/v3/fav/resource/list',
  deal: 'https://api.bilibili.com/x/v3/fav/resource/deal',
  view: 'https://api.bilibili.com/x/web-interface/view'
};

const ALLOWED_VIDEO_HOSTS = new Set(['bilibili.com', 'www.bilibili.com']);
const BILI_PAGE_PATTERNS = [
  'https://www.bilibili.com/*',
  'https://space.bilibili.com/*'
];

function isAllowedVideoUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (_) {
    return false;
  }
  if (url.protocol !== 'https:' || !ALLOWED_VIDEO_HOSTS.has(url.hostname.toLowerCase())) return false;
  return /^\/video\/(?:BV[0-9A-Za-z]+|av\d+)(?:\/|$)/i.test(url.pathname);
}

function normalizeFavEvent(event, source = 'unknown', requireFolderIds = false) {
  if (!event || !['add', 'del'].includes(event.action)) return null;
  const aid = Number(event.aid ?? event.rid);
  if (!Number.isSafeInteger(aid) || aid <= 0) return null;

  const folderIds = [...new Set(
    (Array.isArray(event.folderIds) ? event.folderIds : [])
      .map(value => String(value).trim())
      .filter(value => /^\d+$/.test(value) && value !== '0')
  )].slice(0, 100);
  if (requireFolderIds && !folderIds.length) return null;

  const bvid = /^BV[0-9A-Za-z]+$/i.test(String(event.bvid || ''))
    ? String(event.bvid)
    : '';
  return {
    action: event.action,
    aid,
    bvid,
    folderIds,
    source,
    ts: Date.now()
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const API_TIMEOUT_MS = 20000;
const activeRequestTabs = new Map();
const activeRequestControllers = new Map();

function timeoutError() {
  const error = new Error('B站请求超时，请检查网络或稍后重试。');
  error.code = 'TIMEOUT';
  return error;
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  } catch (_) {}
});

chrome.runtime.onStartup?.addListener(async () => {
  try {
    await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  } catch (_) {}
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel?.open) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (_) {}
});

function formatHttp412() {
  return 'B站返回 412：请求触发风控。先打开/刷新一个 bilibili.com 页面，等一会再慢速同步；收藏夹很大时不要连续快速刷新。';
}

async function findBiliTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: BILI_PAGE_PATTERNS });
  if (active?.id) return active;
  const tabs = await chrome.tabs.query({ url: BILI_PAGE_PATTERNS });
  return tabs.find(t => t.id && !t.discarded) || null;
}

async function fetchViaPage(url, options = {}) {
  const tab = await findBiliTab();
  if (!tab?.id || !chrome.scripting?.executeScript) throw new Error('没有可用的 bilibili.com 页面，请先打开或刷新一个 B 站页面。');
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || API_TIMEOUT_MS));
  const requestId = String(options.requestId || '');
  if (requestId) activeRequestTabs.set(requestId, tab.id);

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (requestUrl, requestOptions, requestTimeoutMs, requestKey) => {
        const registry = globalThis.__BFS_FETCH_CONTROLLERS__ || (globalThis.__BFS_FETCH_CONTROLLERS__ = new Map());
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
        if (requestKey) registry.set(requestKey, controller);
        try {
          const res = await fetch(requestUrl, {
            method: requestOptions.method || 'GET',
            credentials: 'include',
            headers: requestOptions.headers || {},
            body: requestOptions.body || undefined,
            signal: controller.signal
          });
          return {
            ok: res.ok,
            status: res.status,
            text: await res.text()
          };
        } catch (error) {
          if (error?.name === 'AbortError') return { ok: false, status: 0, text: '', timedOut, aborted: !timedOut };
          throw error;
        } finally {
          clearTimeout(timer);
          if (requestKey && registry.get(requestKey) === controller) registry.delete(requestKey);
        }
      },
      args: [url, options, timeoutMs, requestId]
    });
    if (result?.timedOut) throw timeoutError();
    if (result?.aborted) {
      const error = new Error('请求已取消');
      error.code = 'ABORTED';
      throw error;
    }
    return result;
  } finally {
    if (requestId) activeRequestTabs.delete(requestId);
  }
}

async function fetchDirect(url, options = {}) {
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || API_TIMEOUT_MS));
  const controller = new AbortController();
  const requestId = String(options.requestId || '');
  const entry = { controller, cancelled: false };
  if (requestId) activeRequestControllers.set(requestId, entry);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      credentials: 'include',
      headers: options.headers || {},
      body: options.body || undefined,
      signal: controller.signal
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (entry.cancelled) {
        const cancelled = new Error('请求已取消');
        cancelled.code = 'ABORTED';
        throw cancelled;
      }
      throw timeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (requestId && activeRequestControllers.get(requestId) === entry) activeRequestControllers.delete(requestId);
  }
}

async function apiRequest(url, options = {}) {
  let response;
  try {
    response = await fetchViaPage(url, options);
  } catch (pageError) {
    if (pageError?.code === 'TIMEOUT' || pageError?.code === 'ABORTED') throw pageError;
    response = await fetchDirect(url, options);
  }

  if (!response.ok) {
    if (response.status === 412) throw new Error(formatHttp412());
    throw new Error(`网络错误：HTTP ${response.status}`);
  }

  let json;
  try {
    json = JSON.parse(response.text || '{}');
  } catch (_) {
    throw new Error('B站接口返回了非 JSON 数据');
  }

  if (json.code !== 0) {
    if (json.code === -412 || json.code === 412) throw new Error(formatHttp412());
    throw new Error(json.message || `B站接口返回 code=${json.code}`);
  }
  return json.data;
}

async function apiGet(url, extra = {}) {
  return apiRequest(url, {
    ...extra,
    method: extra.method || 'GET',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      ...(extra.headers || {})
    }
  });
}

async function apiPost(url, body) {
  return apiRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/plain, */*'
    },
    body
  });
}

async function getNav() {
  const data = await apiGet(BILI.nav);
  if (!data.isLogin) throw new Error('请先在 Edge 中登录 bilibili.com');
  return { mid: data.mid, uname: data.uname, face: data.face };
}

async function getFavFolders() {
  const nav = await getNav();
  const url = `${BILI.folders}?up_mid=${encodeURIComponent(nav.mid)}&type=2`;
  const data = await apiGet(url);
  return { user: nav, folders: data.list || [], updatedAt: Date.now() };
}

async function getFavItemsPage(mediaId, pn = 1, order = 'mtime', ps = 20, requestId = '') {
  const url = new URL(BILI.resources);
  url.searchParams.set('media_id', mediaId);
  url.searchParams.set('pn', String(pn));
  url.searchParams.set('ps', String(ps));
  url.searchParams.set('order', order);
  url.searchParams.set('type', '0');
  url.searchParams.set('platform', 'web');
  const data = await apiGet(url.toString(), { requestId });
  return {
    info: data.info || null,
    medias: data.medias || [],
    hasMore: Boolean(data.has_more)
  };
}

async function getCsrf() {
  const cookie = await chrome.cookies.get({
    url: 'https://www.bilibili.com/',
    name: 'bili_jct'
  });
  if (!cookie?.value) throw new Error('没有找到 bili_jct，请确认已登录 B 站');
  return cookie.value;
}

async function getAidFromBvid(bvid) {
  const url = `${BILI.view}?bvid=${encodeURIComponent(bvid)}`;
  const data = await apiGet(url);
  if (!data?.aid) throw new Error('无法解析当前视频 aid');
  return data.aid;
}

async function getViewInfoByBvid(bvid) {
  const url = `${BILI.view}?bvid=${encodeURIComponent(bvid)}`;
  return apiGet(url);
}

async function getFavFolderStates(aid) {
  const nav = await getNav();
  const url = `${BILI.folders}?up_mid=${encodeURIComponent(nav.mid)}&type=2&rid=${encodeURIComponent(aid)}`;
  const data = await apiGet(url);
  return data.list || [];
}

async function changeFavResource(aid, folderIds, mode) {
  const csrf = await getCsrf();
  const ids = (folderIds || []).map(String).filter(Boolean);
  if (!ids.length) throw new Error(mode === 'del' ? '没有可取消的收藏夹' : '没有可恢复的收藏夹');
  const params = {
    rid: String(aid),
    type: '2',
    csrf
  };
  if (mode === 'del') params.del_media_ids = ids.join(',');
  else params.add_media_ids = ids.join(',');

  const body = new URLSearchParams(params);
  await apiPost(BILI.deal, body.toString());
  await broadcastFavChange({ action: mode, aid: Number(aid), folderIds: ids, source: 'extension', ts: Date.now() });
  return { aid: Number(aid), folderIds: ids, action: mode };
}

async function unfavResource(aid, options = {}) {
  let folderIds = [];
  if (options.scope === 'all') {
    const folders = await getFavFolderStates(aid);
    folderIds = folders.filter(f => Number(f.fav_state) === 1).map(f => String(f.id));
  } else if (Array.isArray(options.folderIds)) {
    folderIds = options.folderIds;
  } else if (options.folderId) {
    folderIds = [options.folderId];
  }
  return changeFavResource(aid, folderIds, 'del');
}

async function favResource(aid, folderIds = []) {
  return changeFavResource(aid, folderIds, 'add');
}

function extractBvid(url = '') {
  return url.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] || null;
}

async function notifyTab(tabId, text, type = 'info') {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'BILI_FAV_SORTER_TOAST', text, toastType: type });
  } catch (_) {
    await chrome.action.setBadgeText({ text: type === 'error' ? 'ERR' : 'OK' });
    await chrome.action.setBadgeBackgroundColor({ color: type === 'error' ? '#d93025' : '#1a73e8' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
  }
}

async function addPendingFavEvent(event) {
  const { pendingFavEvents = [] } = await chrome.storage.local.get(['pendingFavEvents']);
  const next = [...pendingFavEvents.slice(-49), event];
  await chrome.storage.local.set({ pendingFavEvents: next });
}

async function broadcastFavChange(event) {
  const eventData = normalizeFavEvent(event, event?.source || 'unknown', true);
  if (!eventData) return false;
  const normalized = { type: 'BILI_FAV_CHANGED', event: eventData };
  await addPendingFavEvent(eventData);
  try { chrome.runtime.sendMessage(normalized); } catch (_) {}
  return true;
}

function extractBvidFromAnyUrl(url = '') {
  return String(url || '').match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] || null;
}

async function getTabPlaybackRate(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'BILI_SHELF_GET_PLAYBACK_RATE' });
    const rate = Number(response?.rate || 0);
    if (Number.isFinite(rate) && rate >= 0.25 && rate <= 16) return rate;
  } catch (_) {}
  try {
    const { biliShelfLastPlaybackRate } = await chrome.storage.local.get(['biliShelfLastPlaybackRate']);
    const rate = Number(biliShelfLastPlaybackRate || 0);
    if (Number.isFinite(rate) && rate >= 0.25 && rate <= 16) return rate;
  } catch (_) {}
  return 0;
}


async function getTabPlayerLayout(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'BILI_SHELF_GET_PLAYER_LAYOUT' });
    if (response?.layout) return response.layout;
  } catch (_) {}
  try {
    const { biliShelfLastPlayerLayout } = await chrome.storage.local.get(['biliShelfLastPlayerLayout']);
    if (biliShelfLastPlayerLayout && Date.now() - Number(biliShelfLastPlayerLayout.ts || 0) < 10 * 60 * 1000) return biliShelfLastPlayerLayout;
  } catch (_) {}
  return null;
}

async function focusPageWhenReady(tabId) {
  const tryFocus = async () => {
    try { await chrome.tabs.sendMessage(tabId, { type: 'BILI_SHELF_FOCUS_PAGE' }); } catch (_) {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try { window.focus(); } catch (_) {}
          try { document.activeElement?.blur?.(); } catch (_) {}
          try {
            document.documentElement.setAttribute('tabindex', '-1');
            document.documentElement.focus({ preventScroll: true });
          } catch (_) {}
          try {
            document.body?.setAttribute?.('tabindex', '-1');
            document.body?.focus?.({ preventScroll: true });
          } catch (_) {}
        }
      });
    } catch (_) {}
  };

  setTimeout(tryFocus, 500);
  setTimeout(tryFocus, 1800);
  setTimeout(tryFocus, 3500);

  const listener = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);
    setTimeout(tryFocus, 250);
    setTimeout(tryFocus, 1200);
  };
  try { chrome.tabs.onUpdated.addListener(listener); } catch (_) {}
  setTimeout(() => { try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {} }, 15000);
}

async function openInActiveTab(url) {
  if (!isAllowedVideoUrl(url)) throw new Error('只能打开 HTTPS B 站视频地址。');
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const { preserveVideoRate = true, focusPageAfterOpen = true, preservePlayerMode = true, theaterLayout = false } = await chrome.storage.local.get(['preserveVideoRate', 'focusPageAfterOpen', 'preservePlayerMode', 'theaterLayout']);
  const targetBvid = extractBvidFromAnyUrl(url);
  let rate = 0;
  let layout = null;
  if (preservePlayerMode !== false && tab?.id) {
    layout = await getTabPlayerLayout(tab.id);
    if (layout) {
      await chrome.storage.local.set({
        pendingPlayerLayoutRestore: {
          ...layout,
          webFullscreen: theaterLayout === true || layout.webFullscreen === true,
          bvid: targetBvid || '',
          url,
          theaterLayout: theaterLayout === true,
          ts: Date.now()
        }
      });
    }
  } else if (theaterLayout === true) {
    await chrome.storage.local.set({
      pendingPlayerLayoutRestore: { bvid: targetBvid || '', url, theaterLayout: true, ts: Date.now() }
    });
  }
  if (preserveVideoRate !== false && tab?.id) {
    rate = await getTabPlaybackRate(tab.id);
    if (rate) {
      await chrome.storage.local.set({
        pendingVideoRateRestore: {
          rate,
          bvid: targetBvid || '',
          url,
          ts: Date.now()
        }
      });
    }
  }

  if (tab?.id && tab.url && !tab.url.startsWith('edge://') && !tab.url.startsWith('chrome://')) {
    await chrome.tabs.update(tab.id, { url, active: true });
    if (tab.windowId) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
    }
    if (focusPageAfterOpen !== false) focusPageWhenReady(tab.id);
    return { updated: true, tabId: tab.id, preservedRate: rate || 0, preservedLayout: layout || null };
  }
  const created = await chrome.tabs.create({ url, active: true });
  if (focusPageAfterOpen !== false) focusPageWhenReady(created.id);
  return { updated: false, tabId: created.id, preservedRate: rate || 0, preservedLayout: layout || null };
}

async function cancelApiRequest(requestId) {
  const id = String(requestId || '');
  if (!id) return { cancelled: false };
  let cancelled = false;
  const direct = activeRequestControllers.get(id);
  if (direct) {
    direct.cancelled = true;
    direct.controller.abort();
    cancelled = true;
  }
  const tabId = activeRequestTabs.get(id);
  if (tabId && chrome.scripting?.executeScript) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: requestKey => {
          const controller = globalThis.__BFS_FETCH_CONTROLLERS__?.get(requestKey);
          if (!controller) return false;
          controller.abort();
          return true;
        },
        args: [id]
      });
      cancelled = cancelled || result === true;
    } catch (_) {}
  }
  return { cancelled };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_NAV':
        return await getNav();
      case 'GET_FOLDERS':
        return await getFavFolders();
      case 'GET_ITEMS_PAGE':
        return await getFavItemsPage(message.mediaId, message.pn || 1, message.order || 'mtime', message.ps || 20, message.requestId || '');
      case 'CANCEL_API_REQUEST':
        return await cancelApiRequest(message.requestId);
      case 'UNFAV_AID':
        return await unfavResource(message.aid, { folderId: message.folderId, folderIds: message.folderIds, scope: message.scope });
      case 'FAV_AID':
        return await favResource(message.aid, message.folderIds || (message.folderId ? [message.folderId] : []));
      case 'BVID_TO_AID':
        return { aid: await getAidFromBvid(message.bvid) };
      case 'GET_VIEW_BY_BVID':
        return await getViewInfoByBvid(message.bvid);
      case 'OPEN_IN_ACTIVE_TAB':
        if (!isAllowedVideoUrl(message.url)) throw new Error('只能打开 HTTPS B 站视频地址。');
        return await openInActiveTab(message.url);
      case 'GET_ACTIVE_VIDEO_INFO': {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const bvid = extractBvidFromAnyUrl(tab?.url || '');
        return { bvid, url: tab?.url || '', tabId: tab?.id || 0 };
      }
      case 'APPLY_ACTIVE_LAYOUT_SETTINGS': {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: BILI_PAGE_PATTERNS });
        if (tab?.id) {
          try { await chrome.tabs.sendMessage(tab.id, { type: 'BILI_SHELF_APPLY_LAYOUT_SETTINGS' }); } catch (_) {}
        }
        return { applied: Boolean(tab?.id) };
      }
      case 'UNFAV_CURRENT_VIDEO': {
        const tab = sender.tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        const bvid = message.bvid || extractBvid(tab?.url || '');
        if (!bvid) throw new Error('当前页面不是 B 站视频页');
        const { selectedFolderId, shortcutScope = 'selected' } = await chrome.storage.local.get(['selectedFolderId', 'shortcutScope']);
        const aid = await getAidFromBvid(bvid);
        const result = await unfavResource(aid, { folderId: selectedFolderId, scope: shortcutScope });
        await notifyTab(tab.id, shortcutScope === 'all' ? '已从所有收藏夹取消收藏' : '已从选中收藏夹取消收藏', 'success');
        return { ...result, bvid };
      }
      case 'BILI_PAGE_FAV_CHANGED': {
        const ev = normalizeFavEvent(message.event, 'bilibili-page', true);
        if (!ev) return { received: false };
        await broadcastFavChange(ev);
        return { received: true };
      }
      case 'GET_PENDING_FAV_EVENTS': {
        const { pendingFavEvents = [] } = await chrome.storage.local.get(['pendingFavEvents']);
        await chrome.storage.local.set({ pendingFavEvents: [] });
        return { events: pendingFavEvents };
      }
      default:
        throw new Error('未知请求');
    }
  })()
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
