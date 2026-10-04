const DB_NAME = 'bili-fav-sorter-db';
const DB_VERSION = 2;
const LEGACY_DB_NAME = 'bili-fav-sorter-cache';
const CACHE_PS = 20;
const TRASH_DISPLAY_LIMIT = 50;

const state = {
  user: null,
  folders: [],
  items: [],
  info: null,
  selectedFolderId: null,
  previewBox: null,
  previewTimer: null,
  hoverTimer: null,
  leaveTimer: null,
  renderLimit: 80,
  currentHighlightBvid: '',
  selectedIndex: -1,
  sortedCache: [],
  sortedCacheKey: '',
  itemsRevision: 0,
  randomSortedItems: null,
  randomSortedSignature: '',
  randomShuffleRevision: 0,
  keyboardBusy: false,
  syncing: false,
  syncCancelled: false,
  activeSyncRequestId: '',
  syncResumeAvailable: false
};

const criteria = [
  ['none', '不使用'],
  ['fav_time', '收藏时间'],
  ['view', '播放量'],
  ['duration', '时长'],
  ['pubtime', '发布时间'],
  ['collect', '视频收藏数'],
  ['danmaku', '弹幕数'],
  ['title', '标题'],
  ['up', 'UP主']
];

const DEFAULT_SETTINGS = {
  selectedFolderId: '',
  sort1: 'fav_time', sort2: 'view', sort3: 'duration',
  dir1: 'desc', dir2: 'desc', dir3: 'desc',
  randomSort: false,
  shortcutScope: 'selected', shortcutKey: 'u',
  previewEnabled: true, previewMuted: true, previewRequireAlt: true, previewHoverDelay: 2000, previewRate: 4, previewVolume: 70,
  preserveVideoRate: true, focusPageAfterOpen: false, preservePlayerMode: true, theaterLayout: false,
  sideKeyboardEnabled: true,
  renderBatchSize: 80
};

const $ = sel => document.querySelector(sel);
const els = {
  userStatus: $('#userStatus'), refreshBtn: $('#refreshBtn'), folderSelect: $('#folderSelect'),
  openCacheBtn: $('#openCacheBtn'), syncBtn: $('#syncBtn'), clearCacheBtn: $('#clearCacheBtn'),
  progressBox: $('#progressBox'), progressText: $('#progressText'), progressPercent: $('#progressPercent'), progressBar: $('#progressBar'),
  sort1: $('#sort1'), sort2: $('#sort2'), sort3: $('#sort3'), dir1: $('#dir1'), dir2: $('#dir2'), dir3: $('#dir3'), keyword: $('#keyword'), sortFields: $('#sortFields'), randomSort: $('#randomSort'), randomReshuffleBtn: $('#randomReshuffleBtn'),
  shortcutScope: $('#shortcutScope'), shortcutKey: $('#shortcutKey'), previewEnabled: $('#previewEnabled'), previewSound: $('#previewSound'), previewRequireAlt: $('#previewRequireAlt'), previewHoverDelay: $('#previewHoverDelay'), previewRate: $('#previewRate'), previewVolume: $('#previewVolume'), preserveVideoRate: $('#preserveVideoRate'), focusPageAfterOpen: $('#focusPageAfterOpen'), preservePlayerMode: $('#preservePlayerMode'), theaterLayout: $('#theaterLayout'), sideKeyboardEnabled: $('#sideKeyboardEnabled'), renderBatchSize: $('#renderBatchSize'),
  exportJsonBtn: $('#exportJsonBtn'), exportCsvBtn: $('#exportCsvBtn'), refreshTrashBtn: $('#refreshTrashBtn'), clearTrashBtn: $('#clearTrashBtn'), trashList: $('#trashList'),
  trashPanel: $('#trashPanel'),
  message: $('#message'), list: $('#list'), loadMoreBtn: $('#loadMoreBtn'), scrollTopBtn: $('#scrollTopBtn'), gotoCurrentBtn: $('#gotoCurrentBtn'), tpl: $('#itemTpl')
};

function send(type, payload = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(5000, Number(options.timeoutMs || 30000));
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`请求超时：${type}`));
    }, timeoutMs);
    chrome.runtime.sendMessage({ type, ...payload }, response => {
      if (settled) return;
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || '未知错误'));
      resolve(response.data);
    });
  });
}

function msg(text) { els.message.textContent = text || ''; }
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function waitForSyncDelay(ms) {
  return new Promise(resolve => {
    const endAt = Date.now() + Math.max(0, Number(ms) || 0);
    let timer = 0;
    const check = () => {
      if (state.syncCancelled) {
        if (timer) clearTimeout(timer);
        resolve(false);
        return;
      }
      const remaining = endAt - Date.now();
      if (remaining <= 0) {
        resolve(true);
        return;
      }
      timer = setTimeout(check, Math.min(250, remaining));
    };
    check();
  });
}

function isRetryableSyncError(error) {
  const text = String(error?.message || error || '');
  return /412|429|超时|网络错误|HTTP 5\d\d|Failed to fetch/i.test(text);
}

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return `sync-${globalThis.crypto.randomUUID()}`;
  return `sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cancelActiveSyncRequest() {
  const requestId = state.activeSyncRequestId;
  if (!requestId) return;
  send('CANCEL_API_REQUEST', { requestId }, { timeoutMs: 3000 }).catch(() => {});
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'mediaId' });
      if (!db.objectStoreNames.contains('trash')) db.createObjectStore('trash', { keyPath: 'trashId' });
      const trash = req.transaction.objectStore('trash');
      if (!trash.indexNames.contains('deletedAt')) trash.createIndex('deletedAt', 'deletedAt', { unique: false });
      if (!trash.indexNames.contains('aidFolder')) trash.createIndex('aidFolder', ['aid', 'folderId'], { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let req;
    try { req = fn(store); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const dbGet = (store, key) => idb(store, 'readonly', s => s.get(key));
const dbPut = (store, value) => idb(store, 'readwrite', s => s.put(value));
const dbDelete = (store, key) => idb(store, 'readwrite', s => s.delete(key));
const dbClear = store => idb(store, 'readwrite', s => s.clear());
const dbAll = store => idb(store, 'readonly', s => s.getAll());

function dbRecentTrash(limit = TRASH_DISPLAY_LIMIT) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('trash', 'readonly');
    const index = tx.objectStore('trash').index('deletedAt');
    const records = [];
    const request = index.openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || records.length >= limit) return;
      records.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(records);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

function dbTrashByAidFolder(aid, folderId) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('trash', 'readonly');
    const index = tx.objectStore('trash').index('aidFolder');
    const request = index.getAll(IDBKeyRange.only([Number(aid), String(folderId)]));
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}


function openLegacyDb() {
  return new Promise((resolve) => {
    const req = indexedDB.open(LEGACY_DB_NAME, 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

async function readLegacyKvRecords() {
  const db = await openLegacyDb();
  if (!db || !db.objectStoreNames.contains('kv')) {
    try { db?.close?.(); } catch (_) {}
    return [];
  }
  return new Promise((resolve) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
    tx.oncomplete = () => { try { db.close(); } catch (_) {} };
  });
}

async function migrateLegacyCacheIfNeeded() {
  const records = await readLegacyKvRecords();
  if (!records.length) return { folders: 0, items: 0 };

  const foldersRecord = records.find(r => r.key === 'folders');
  const folders = foldersRecord?.value?.folders || [];
  let migratedFolders = 0;
  let migratedItems = 0;

  const existingFolders = await dbGet('folders', 'all');
  if (!existingFolders && foldersRecord?.value) {
    await dbPut('folders', {
      key: 'all',
      user: foldersRecord.value.user || null,
      folders,
      updatedAt: foldersRecord.updatedAt || Date.now(),
      migratedFrom: LEGACY_DB_NAME
    });
    migratedFolders = folders.length || 1;
  }

  for (const record of records) {
    if (!String(record.key || '').startsWith('items:')) continue;
    const mediaId = String(record.key).slice('items:'.length);
    if (!mediaId) continue;
    const existing = await dbGet('items', mediaId);
    if (existing?.items?.length) continue;
    const folder = folders.find(f => String(f.id) === String(mediaId));
    await dbPut('items', {
      mediaId,
      folderTitle: folder?.title || folder?.name || `收藏夹 ${mediaId}`,
      info: record.value?.info || null,
      items: record.value?.items || [],
      partial: Boolean(record.value?.partial),
      updatedAt: record.updatedAt || Date.now(),
      migratedFrom: LEGACY_DB_NAME
    });
    migratedItems += 1;
  }

  return { folders: migratedFolders, items: migratedItems };
}

function fillCriteria() {
  [els.sort1, els.sort2, els.sort3].forEach(sel => {
    sel.innerHTML = '';
    for (const [value, label] of criteria) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
  });
}

function updateSortControls() {
  const random = els.randomSort?.checked === true;
  els.sortFields?.classList.toggle('hidden', random);
  els.randomReshuffleBtn?.classList.toggle('hidden', !random);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const legacyRandom = [stored.sort1, stored.sort2, stored.sort3].includes('random');
  const s = { ...DEFAULT_SETTINGS, ...stored, randomSort: stored.randomSort === true || legacyRandom };
  if (legacyRandom) {
    s.sort1 = DEFAULT_SETTINGS.sort1;
    s.sort2 = DEFAULT_SETTINGS.sort2;
    s.sort3 = DEFAULT_SETTINGS.sort3;
  }
  for (const id of ['sort1', 'sort2', 'sort3', 'dir1', 'dir2', 'dir3', 'shortcutScope']) els[id].value = s[id];
  els.shortcutKey.value = String(s.shortcutKey || 'u').slice(0, 1).toLowerCase();
  els.previewEnabled.checked = s.previewEnabled !== false;
  els.previewSound.checked = s.previewMuted === false;
  els.previewRequireAlt.checked = s.previewRequireAlt !== false;
  const hoverDelay = Number(s.previewHoverDelay ?? 2000);
  els.previewHoverDelay.value = hoverDelay <= 900 ? 2000 : hoverDelay;
  els.previewRate.value = Number(s.previewRate ?? 4);
  const storedPreviewVolume = Number(s.previewVolume ?? 70);
  if (els.previewVolume) els.previewVolume.value = Number.isFinite(storedPreviewVolume) ? Math.max(0, Math.min(100, storedPreviewVolume)) : 70;
  if (els.preserveVideoRate) els.preserveVideoRate.checked = s.preserveVideoRate !== false;
  if (els.focusPageAfterOpen) els.focusPageAfterOpen.checked = s.focusPageAfterOpen !== false;
  if (els.preservePlayerMode) els.preservePlayerMode.checked = s.preservePlayerMode !== false;
  if (els.theaterLayout) els.theaterLayout.checked = s.theaterLayout === true;
  if (els.sideKeyboardEnabled) els.sideKeyboardEnabled.checked = s.sideKeyboardEnabled !== false;
  if (els.randomSort) els.randomSort.checked = s.randomSort === true;
  updateSortControls();
  els.renderBatchSize.value = Math.max(20, Math.min(500, Number(s.renderBatchSize ?? 80)));
  state.renderLimit = Math.max(20, Math.min(500, Number(els.renderBatchSize.value || 80)));
  state.selectedFolderId = s.selectedFolderId || '';
}

async function saveSettings() {
  const shortcutKey = (els.shortcutKey.value || 'u').slice(0, 1).toLowerCase();
  const previewHoverDelay = Math.max(1200, Number(els.previewHoverDelay.value || 2000));
  const previewRate = Math.max(0.25, Math.min(16, Number(els.previewRate.value || 4)));
  const enteredPreviewVolume = Number(els.previewVolume?.value ?? 70);
  const previewVolume = Number.isFinite(enteredPreviewVolume) ? Math.max(0, Math.min(100, enteredPreviewVolume)) : 70;
  const renderBatchSize = Math.max(20, Math.min(500, Number(els.renderBatchSize.value || 80)));
  await chrome.storage.local.set({
    selectedFolderId: els.folderSelect.value || state.selectedFolderId || '',
    sort1: els.sort1.value, sort2: els.sort2.value, sort3: els.sort3.value,
    dir1: els.dir1.value, dir2: els.dir2.value, dir3: els.dir3.value,
    randomSort: els.randomSort?.checked === true,
    shortcutScope: els.shortcutScope.value,
    shortcutKey,
    previewEnabled: els.previewEnabled.checked,
    previewMuted: !els.previewSound.checked,
    previewRequireAlt: els.previewRequireAlt.checked,
    previewHoverDelay,
    previewRate,
    previewVolume,
    preserveVideoRate: els.preserveVideoRate ? els.preserveVideoRate.checked : true,
    focusPageAfterOpen: els.focusPageAfterOpen ? els.focusPageAfterOpen.checked : true,
    preservePlayerMode: els.preservePlayerMode ? els.preservePlayerMode.checked : true,
    theaterLayout: els.theaterLayout ? els.theaterLayout.checked : false,
    sideKeyboardEnabled: els.sideKeyboardEnabled ? els.sideKeyboardEnabled.checked : true,
    renderBatchSize
  });
}


function resetRenderLimit() {
  const size = Math.max(20, Math.min(500, Number(els.renderBatchSize?.value || DEFAULT_SETTINGS.renderBatchSize || 80)));
  state.renderLimit = size;
}

function fillFolderSelect() {
  els.folderSelect.innerHTML = '';
  for (const folder of state.folders) {
    const opt = document.createElement('option');
    opt.value = String(folder.id);
    opt.textContent = `${folder.title || folder.name || '未命名'}（${folder.media_count ?? 0}）`;
    els.folderSelect.appendChild(opt);
  }
  if (state.selectedFolderId && [...els.folderSelect.options].some(o => o.value === String(state.selectedFolderId))) {
    els.folderSelect.value = String(state.selectedFolderId);
  } else if (els.folderSelect.options.length) {
    els.folderSelect.selectedIndex = 0;
    state.selectedFolderId = els.folderSelect.value;
  }
}

async function loadFoldersFromCache() {
  const cache = await dbGet('folders', 'all');
  if (!cache) return false;
  state.user = cache.user || null;
  state.folders = cache.folders || [];
  fillFolderSelect();
  els.userStatus.textContent = state.user ? `缓存账号：${state.user.uname} / UID ${state.user.mid}` : '已打开收藏夹缓存';
  return true;
}

async function refreshFolders() {
  msg('正在读取收藏夹列表...');
  const data = await send('GET_FOLDERS');
  state.user = data.user;
  state.folders = data.folders || [];
  await dbPut('folders', { key: 'all', user: state.user, folders: state.folders, updatedAt: Date.now() });
  fillFolderSelect();
  await saveSettings();
  els.userStatus.textContent = `已登录：${state.user.uname} / UID ${state.user.mid}`;
  msg(`已刷新 ${state.folders.length} 个收藏夹。`);
}

function currentFolderId() { return String(els.folderSelect.value || state.selectedFolderId || ''); }
function folderTitleById(folderId) {
  const f = state.folders.find(v => String(v.id) === String(folderId));
  return f?.title || f?.name || `收藏夹 ${folderId}`;
}

async function openCacheForCurrentFolder() {
  const mediaId = currentFolderId();
  if (!mediaId) return msg('请先选择收藏夹。');
  const cache = await dbGet('items', mediaId);
  if (!cache) {
    replaceStateItems([]);
    state.info = null;
    state.syncResumeAvailable = false;
    if (!state.syncing) els.syncBtn.textContent = '慢速同步';
    render();
    return msg('当前收藏夹还没有缓存，请先慢速同步。');
  }
  replaceStateItems((cache.items || []).filter(item => Number(item.type) === 2 || item.bvid || item.bv_id));
  state.info = cache.info || null;
  state.selectedFolderId = mediaId;
  state.syncResumeAvailable = Boolean(cache.partial && cache.syncState && Number(cache.syncState.nextPage) > 1);
  if (!state.syncing) els.syncBtn.textContent = state.syncResumeAvailable ? '继续同步' : '慢速同步';
  await saveSettings();
  resetRenderLimit();
  render();
  const time = cache.updatedAt ? new Date(cache.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
  msg(`已打开缓存：${state.items.length} 个视频，更新于 ${time}${cache.partial ? '（部分缓存，可继续同步）' : ''}`);
}

function setProgress(done, total, text, isError = false) {
  els.progressBox.classList.remove('hidden');
  const percent = total ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
  els.progressText.textContent = text;
  els.progressPercent.textContent = `${percent}%`;
  els.progressBar.style.width = `${percent}%`;
  els.progressBar.classList.toggle('error', Boolean(isError));
}

function setSyncProgress(page, pages, cachedCount, total, phase, isError = false) {
  const pageNumber = Math.max(0, Number(page) || 0);
  const pageTotal = Math.max(0, Number(pages) || 0);
  const hasPageTotal = pageTotal > 0;
  const done = hasPageTotal ? Math.min(pageNumber, pageTotal) : Math.max(0, Number(cachedCount) || 0);
  const denominator = hasPageTotal ? pageTotal : Math.max(1, Number(total) || Number(cachedCount) || 1);
  const pageText = hasPageTotal ? `已读取 ${done} / ${pageTotal} 页` : `已读取 ${pageNumber} 页`;
  const cacheText = Number(total) > 0 ? `已缓存 ${cachedCount} / ${total} 个视频` : `已缓存 ${cachedCount} 个视频`;
  setProgress(done, denominator, `${phase}，${pageText}，${cacheText}`, isError);
}

function cacheItemKey(item) {
  const bvid = String(item?.bvid || item?.bv_id || '').trim();
  if (bvid) return `bvid:${bvid}`;
  const aid = Number(item?.id || item?.aid || item?.rid);
  return Number.isSafeInteger(aid) && aid > 0 ? `aid:${aid}` : '';
}

function mergeUniqueItems(existing, incoming) {
  const result = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(result.map(cacheItemKey).filter(Boolean));
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const key = cacheItemKey(item);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(item);
  }
  return result;
}

function replaceStateItems(items) {
  state.items = mergeUniqueItems([], items);
  state.itemsRevision += 1;
  state.sortedCache = [];
  state.sortedCacheKey = '';
}

async function saveItemsCache(mediaId, items, info, partial = false, syncState = null) {
  await dbPut('items', {
    mediaId: String(mediaId),
    folderTitle: folderTitleById(mediaId),
    info: info || null,
    items: mergeUniqueItems([], items),
    partial,
    syncState: partial ? syncState : null,
    updatedAt: Date.now()
  });
}

async function getSyncPageWithRetry(payload, onRetry) {
  const maxRetries = 3;
  for (let attempt = 0; ; attempt += 1) {
    if (state.syncCancelled) throw new Error('用户中断同步');
    const requestId = payload.requestId || makeRequestId();
    state.activeSyncRequestId = requestId;
    try {
      return await send('GET_ITEMS_PAGE', { ...payload, requestId }, { timeoutMs: 25000 });
    } catch (error) {
      if (state.syncCancelled) throw new Error('用户中断同步');
      if (attempt >= maxRetries || !isRetryableSyncError(error)) throw error;
      const wait = Math.min(30000, 4000 * (2 ** attempt) + jitter(500, 1500));
      onRetry?.(wait, attempt + 1, maxRetries, error);
      if (!await waitForSyncDelay(wait)) throw new Error('用户中断同步');
    } finally {
      if (state.activeSyncRequestId === requestId) state.activeSyncRequestId = '';
    }
  }
}

async function slowSync() {
  const mediaId = currentFolderId();
  if (!mediaId) return msg('请先选择收藏夹。');
  if (state.syncing) {
    state.syncCancelled = true;
    cancelActiveSyncRequest();
    msg('正在结束当前同步，已完成的分页会保留。');
    return;
  }
  await saveSettings();
  state.syncing = true;
  state.syncCancelled = false;
  state.syncResumeAvailable = false;
  els.syncBtn.disabled = false;
  els.syncBtn.textContent = '中断同步';
  els.progressBar.classList.remove('error');
  msg('开始慢速同步，期间不要连续点刷新。');
  const oldCache = await dbGet('items', mediaId);
  if (oldCache?.items?.length) {
    replaceStateItems(oldCache.items);
    state.info = oldCache.info || null;
    resetRenderLimit();
    render();
  }

  const savedSync = oldCache?.partial && oldCache.syncState && Number(oldCache.syncState.nextPage) > 1
    ? oldCache.syncState
    : null;
  let items = savedSync ? mergeUniqueItems([], oldCache.items || []) : [];
  let info = savedSync ? (oldCache.info || null) : null;
  let total = Number(savedSync?.total || info?.media_count || 0);
  let pages = Number(savedSync?.pages || (total ? Math.ceil(total / CACHE_PS) : 0));
  let nextPage = Math.max(1, Number(savedSync?.nextPage || 1));
  let checkpointItems = [...items];
  let checkpointNextPage = nextPage;
  let partial = false;
  let completed = false;
  if (savedSync) msg(`从第 ${nextPage} 页继续同步，已保留 ${items.length} 个视频。`);
  try {
    for (let pn = nextPage; pages === 0 || pn <= pages; pn++) {
      if (state.syncCancelled) throw new Error('用户中断同步');
      setSyncProgress(Math.max(0, pn - 1), pages, items.length, total, `正在请求第 ${pn}${pages ? ` / ${pages}` : ''} 页`);
      const data = await getSyncPageWithRetry(
        { mediaId, pn, ps: CACHE_PS, order: 'mtime' },
        (wait, retry, maxRetries, error) => setSyncProgress(
          Math.max(0, pn - 1), pages, items.length, total,
          `第 ${pn} 页请求失败（${error.message || '网络错误'}），${Math.round(wait / 1000)} 秒后重试 ${retry}/${maxRetries}`
        )
      );
      if (!info) {
        info = data.info || null;
        total = Number(info?.media_count || 0);
        pages = total > 0 ? Math.ceil(total / CACHE_PS) : 0;
      }
      const medias = (data.medias || []).filter(item => Number(item.type) === 2 || item.bvid || item.bv_id);
      items = mergeUniqueItems(items, medias);
      nextPage = pn + 1;
      replaceStateItems(items);
      state.info = info;
      await saveItemsCache(mediaId, items, info, true, {
        nextPage,
        total,
        pages,
        order: 'mtime',
        ps: CACHE_PS,
        pagesDone: pn,
        cachedCount: items.length
      });
      checkpointItems = [...items];
      checkpointNextPage = nextPage;
      render();
      setSyncProgress(pn, pages, items.length, total, '同步进行中');
      if (state.syncCancelled) throw new Error('用户中断同步');
      const reachedExpectedPages = pages > 0 && pn >= pages;
      const apiReportedEnd = data.hasMore === false;
      const emptyPage = (data.medias || []).length === 0;
      if (reachedExpectedPages || (apiReportedEnd && (pages === 0 || emptyPage))) {
        completed = true;
        break;
      }
      const wait = jitter(1600, 3200);
      setSyncProgress(pn, pages, items.length, total, `等待 ${Math.round(wait / 1000)} 秒后继续，避免 412`);
      if (!await waitForSyncDelay(wait)) throw new Error('用户中断同步');
    }
  } catch (e) {
    partial = !completed;
    if (checkpointItems.length) {
      await saveItemsCache(mediaId, checkpointItems, info, true, {
        nextPage: checkpointNextPage,
        total,
        pages,
        order: 'mtime',
        ps: CACHE_PS,
        pagesDone: Math.max(0, checkpointNextPage - 1),
        cachedCount: checkpointItems.length
      });
      replaceStateItems(checkpointItems);
      state.info = info;
      state.syncResumeAvailable = true;
      render();
      const cancelled = state.syncCancelled || e.message === '用户中断同步';
      setSyncProgress(
        Math.max(0, checkpointNextPage - 1), pages, checkpointItems.length, total,
        cancelled ? '同步已中断' : '同步失败，已保存断点',
        !cancelled
      );
      msg(cancelled ? '同步已中断，已保存进度；再次点击“慢速同步”即可继续。' : (e.message || String(e)));
    } else {
      setProgress(0, 1, `同步失败：${e.message}`, true);
      msg(e.message || String(e));
    }
    return;
  } finally {
    state.syncing = false;
    state.syncCancelled = false;
    els.syncBtn.disabled = false;
    els.syncBtn.textContent = state.syncResumeAvailable ? '继续同步' : '慢速同步';
  }
  if (partial) return;
  await saveItemsCache(mediaId, items, info, partial);
  setSyncProgress(pages || Math.max(0, nextPage - 1), pages, items.length, total, '同步完成');
  msg(`已同步并缓存 ${items.length} 个视频。`);
}

async function clearCurrentCache() {
  const mediaId = currentFolderId();
  if (!mediaId) return;
  await dbDelete('items', mediaId);
  replaceStateItems([]);
  state.info = null;
  state.syncResumeAvailable = false;
  els.syncBtn.textContent = '慢速同步';
  resetRenderLimit();
  render();
  setProgress(0, 1, '已清除当前收藏夹缓存');
  msg('已清除当前收藏夹缓存。');
}

function numberLike(v) { return Number(v || 0); }
function textLike(v) { return String(v || '').toLocaleLowerCase('zh-CN'); }
function randomItemKey(item) {
  return itemBvid(item) || String(item?.id || item?.aid || item?.rid || '');
}
function resetRandomShuffle() {
  state.randomSortedItems = null;
  state.randomSortedSignature = '';
  state.randomShuffleRevision += 1;
  state.sortedCacheKey = '';
}
function shuffleItems(items) {
  const signature = `${state.itemsRevision}\u0002${items.map(randomItemKey).join('\u0001')}`;
  if (state.randomSortedItems && state.randomSortedSignature === signature) return state.randomSortedItems;
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  state.randomSortedItems = shuffled;
  state.randomSortedSignature = signature;
  return shuffled;
}
function getValue(item, key) {
  switch (key) {
    case 'fav_time': return numberLike(item.fav_time || item.mtime);
    case 'view': return numberLike(item.cnt_info?.play || item.cnt_info?.view);
    case 'duration': return numberLike(item.duration);
    case 'pubtime': return numberLike(item.pubtime || item.ctime);
    case 'collect': return numberLike(item.cnt_info?.collect);
    case 'danmaku': return numberLike(item.cnt_info?.danmaku);
    case 'title': return textLike(item.title);
    case 'up': return textLike(item.upper?.name);
    default: return null;
  }
}
function compareValues(a, b, dir) {
  let r = 0;
  if (typeof a === 'string' || typeof b === 'string') r = String(a).localeCompare(String(b), 'zh-CN');
  else r = Number(a) - Number(b);
  return dir === 'asc' ? r : -r;
}
function sortedItems() {
  const rules = [[els.sort1.value, els.dir1.value], [els.sort2.value, els.dir2.value], [els.sort3.value, els.dir3.value]].filter(([k]) => k && k !== 'none');
  const kw = textLike(els.keyword.value).trim();
  const random = els.randomSort?.checked === true;
  const cacheKey = JSON.stringify([state.itemsRevision, state.randomShuffleRevision, random, kw, rules]);
  if (state.sortedCacheKey === cacheKey) return state.sortedCache;
  const filtered = [...state.items].filter(item => !kw || textLike(item.title).includes(kw) || textLike(item.upper?.name).includes(kw));
  const result = random ? shuffleItems(filtered) : filtered.sort((a, b) => {
      for (const [key, dir] of rules) {
        const r = compareValues(getValue(a, key), getValue(b, key), dir);
        if (r !== 0) return r;
      }
      return 0;
    });
  state.sortedCache = result;
  state.sortedCacheKey = cacheKey;
  return result;
}
function fmtNum(n) {
  n = Number(n || 0);
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}
function fmtDuration(sec) {
  sec = Number(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDate(ts) {
  ts = Number(ts || 0);
  if (!ts) return '未知';
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
}
function videoUrl(item) {
  if (isAllowedVideoUrl(item?.link)) return item.link;
  const bvid = item.bvid || item.bv_id;
  return bvid
    ? `https://www.bilibili.com/video/${encodeURIComponent(String(bvid))}`
    : `https://www.bilibili.com/video/av${encodeURIComponent(String(item.id || item.aid || item.rid || ''))}`;
}

function isAllowedVideoUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (_) {
    return false;
  }
  if (url.protocol !== 'https:' || !['bilibili.com', 'www.bilibili.com'].includes(url.hostname.toLowerCase())) return false;
  return /^\/video\/(?:BV[0-9A-Za-z]+|av\d+)(?:\/|$)/i.test(url.pathname);
}
function itemBvid(item) { return String(item?.bvid || item?.bv_id || '').trim(); }
function cssEscapeValue(value) {
  if (window.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
async function openVideo(url) {
  await send('OPEN_IN_ACTIVE_TAB', { url });
}

function closeSidePreview() {
  clearTimeout(state.hoverTimer);
  clearTimeout(state.previewTimer);
  clearTimeout(state.leaveTimer);
  if (state.previewBox) {
    try {
      const iframe = state.previewBox.querySelector('iframe');
      if (iframe) iframe.src = 'about:blank';
    } catch (_) {}
    state.previewBox.remove();
    state.previewBox = null;
  }
}
function chooseSidePreviewPosition(rect, width, height) {
  const gap = 10, vw = window.innerWidth, vh = window.innerHeight;
  const candidates = [
    { left: rect.left, top: rect.bottom + gap },
    { left: rect.left, top: rect.top - height - gap },
    { left: vw - width - gap, top: gap },
    { left: gap, top: vh - height - gap }
  ];
  for (const c of candidates) {
    const left = Math.max(gap, Math.min(vw - width - gap, c.left));
    const top = Math.max(gap, Math.min(vh - height - gap, c.top));
    const pr = { left, top, right: left + width, bottom: top + height };
    const noOverlap = pr.right < rect.left || pr.left > rect.right || pr.bottom < rect.top || pr.top > rect.bottom;
    if (noOverlap) return { left, top };
  }
  return { left: Math.max(gap, Math.min(vw - width - gap, rect.left)), top: Math.max(gap, Math.min(vh - height - gap, rect.bottom + gap)) };
}
async function showSidePreview(item, sourceEl) {
  closeSidePreview();
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
  if (!settings.previewEnabled) return;
  const bvid = item.bvid || item.bv_id;
  if (!bvid) return;
  const rect = sourceEl.getBoundingClientRect();
  const width = Math.min(360, Math.max(260, window.innerWidth - 20));
  const height = Math.round(width * 9 / 16) + 30;
  const pos = chooseSidePreviewPosition(rect, width, height);
  const box = document.createElement('div');
  box.className = 'bfs-side-preview';
  box.style.left = `${pos.left}px`;
  box.style.top = `${pos.top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;

  const iframe = document.createElement('iframe');
  iframe.src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=1&autoplay=1&muted=${settings.previewMuted === false ? '0' : '1'}&t=0&danmaku=0&high_quality=0&as_wide=1&bfs_preview=1&bfs_rate=${encodeURIComponent(settings.previewRate || 4)}&bfs_speed=${encodeURIComponent(settings.previewRate || 4)}&bfs_volume=${encodeURIComponent(settings.previewVolume ?? 70)}`;
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.referrerPolicy = 'origin-when-cross-origin';
  const title = document.createElement('div');
  title.className = 'preview-title';
  title.textContent = `${settings.previewRate || 4}x 悬停预览 · 点击进入详情页${settings.previewMuted === false ? ' · 声音开启' : ''}`;
  const click = document.createElement('div');
  click.className = 'preview-click';
  click.addEventListener('click', () => openVideo(videoUrl(item)));
  box.append(iframe, title, click);
  box.addEventListener('mouseenter', () => clearTimeout(state.leaveTimer));
  box.addEventListener('mouseleave', closeSidePreview);
  document.body.appendChild(box);
  state.previewBox = box;
}
async function scheduleSidePreview(item, sourceEl, event) {
  closeSidePreview();
  const s = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
  if (!s.previewEnabled) return;
  if (s.previewRequireAlt !== false && !event?.altKey) return;
  state.hoverTimer = setTimeout(() => showSidePreview(item, sourceEl), Math.max(1200, Number(s.previewHoverDelay ?? 2000)));
}


function isEditableTarget(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (el.closest('input, textarea, select, [contenteditable="true"]')) return true;
  return false;
}

function currentSortedItems() {
  return sortedItems();
}

function renderedSelectedElement() {
  if (state.selectedIndex < 0) return null;
  return document.querySelector(`.video-item[data-index="${state.selectedIndex}"]`);
}

function updateSelectedClasses() {
  document.querySelectorAll('.video-item').forEach(el => {
    const selected = Number(el.dataset.index) === Number(state.selectedIndex);
    el.classList.toggle('selected-video', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function selectIndex(index, options = {}) {
  const all = currentSortedItems();
  if (!all.length) {
    state.selectedIndex = -1;
    updateSelectedClasses();
    return null;
  }
  const next = Math.max(0, Math.min(all.length - 1, Number(index)));
  state.selectedIndex = next;
  if (next >= Number(state.renderLimit || 0)) {
    const batch = Math.max(20, Math.min(500, Number(els.renderBatchSize?.value || 80)));
    state.renderLimit = Math.ceil((next + 1) / batch) * batch;
    render();
  } else {
    updateSelectedClasses();
  }
  const el = renderedSelectedElement();
  if (el && options.scroll !== false) {
    el.scrollIntoView({ block: 'center', behavior: options.smooth === false ? 'auto' : 'smooth' });
  }
  if (el && options.focus === true) {
    try { el.focus({ preventScroll: true }); } catch (_) {}
  }
  if (!options.silent) {
    const item = all[next];
    msg(`已选择 ${next + 1} / ${all.length}：${item?.title || '无标题'}。Enter 打开，U 取消收藏。`);
  }
  return all[next];
}

function moveSelection(delta) {
  const all = currentSortedItems();
  if (!all.length) return;
  const base = state.selectedIndex >= 0 ? state.selectedIndex : 0;
  selectIndex(base + delta, { scroll: true });
}

function getSelectedItem() {
  const all = currentSortedItems();
  if (!all.length) return null;
  if (state.selectedIndex < 0) selectIndex(0, { scroll: false, silent: true });
  return all[state.selectedIndex] || null;
}

async function openSelectedVideo() {
  const item = getSelectedItem();
  if (!item) return msg('当前没有可打开的视频。');
  await openVideo(videoUrl(item));
}

async function unfavItem(item, mediaId = currentFolderId(), source = 'sidepanel') {
  if (!item) return msg('当前没有选中的视频。');
  const aid = Number(item.id || item.aid || item.rid);
  if (!aid) throw new Error('无法识别该视频 aid，不能取消收藏。');
  const { shortcutScope = 'selected' } = await chrome.storage.local.get(['shortcutScope']);
  const result = await send('UNFAV_AID', { aid, folderId: mediaId, scope: shortcutScope });
  const folderIds = [...new Set(
    (shortcutScope === 'all' ? (result.folderIds || []) : [mediaId])
      .map(value => String(value).trim())
      .filter(value => /^\d+$/.test(value) && value !== '0')
  )];
  if (!folderIds.length) throw new Error('取消收藏成功，但没有返回可恢复的收藏夹。');
  for (const folderId of folderIds) {
    const cache = String(folderId) === currentFolderId() ? null : await dbGet('items', folderId);
    const folderItem = cache?.items?.find(v => Number(v.id || v.aid || v.rid) === aid) || item;
    await storeTrash(folderItem, folderId, source, false);
  }
  await renderTrash();
  await removeAidFromCache(aid, folderIds, false);
  const all = currentSortedItems();
  if (all.length) selectIndex(Math.min(state.selectedIndex, all.length - 1), { scroll: false, silent: true });
  msg(shortcutScope === 'all' ? '已从所有收藏夹取消收藏，已放入插件回收站。' : '已取消收藏，已放入插件回收站。');
}

async function unfavSelectedVideo() {
  if (state.keyboardBusy) return;
  const item = getSelectedItem();
  if (!item) return msg('当前没有选中的视频。');
  state.keyboardBusy = true;
  try {
    await unfavItem(item, currentFolderId(), 'sidepanel-keyboard');
  } catch (e) {
    msg(e.message || String(e));
  } finally {
    setTimeout(() => { state.keyboardBusy = false; }, 500);
  }
}

function bindSidepanelKeyboard() {
  document.addEventListener('keydown', event => {
    if (isEditableTarget(event.target)) return;
    const keyboardEnabled = els.sideKeyboardEnabled ? els.sideKeyboardEnabled.checked : true;
    if (!keyboardEnabled) return;
    const key = event.key;
    const shortcutKey = String(els.shortcutKey?.value || 'u').slice(0, 1).toLowerCase();
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', 'Enter'].includes(key) || key.toLowerCase() === shortcutKey) {
      const all = currentSortedItems();
      if (!all.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === 'ArrowDown') return moveSelection(1);
      if (key === 'ArrowUp') return moveSelection(-1);
      if (key === 'PageDown') return moveSelection(10);
      if (key === 'PageUp') return moveSelection(-10);
      if (key === 'Home') return selectIndex(0, { scroll: true });
      if (key === 'End') return selectIndex(all.length - 1, { scroll: true });
      if (key === 'Enter') return openSelectedVideo().catch(e => msg(e.message || String(e)));
      if (key.toLowerCase() === shortcutKey) return unfavSelectedVideo();
    }
  }, true);
}

function render() {
  const allItems = sortedItems();
  state.sortedCache = allItems;
  if (!allItems.length) state.selectedIndex = -1;
  else if (state.selectedIndex >= allItems.length) state.selectedIndex = allItems.length - 1;
  const items = allItems.slice(0, Math.max(20, Number(state.renderLimit || 80)));
  els.list.innerHTML = '';
  const frag = document.createDocumentFragment();
  const mediaId = currentFolderId();

  items.forEach((item, index) => {
    const node = els.tpl.content.cloneNode(true);
    const cover = node.querySelector('.cover');
    const title = node.querySelector('.title');
    const up = node.querySelector('.up');
    const stats = node.querySelector('.stats');
    const root = node.querySelector('.video-item');
    const openBtn = node.querySelector('.openBtn');
    const unfavBtn = node.querySelector('.unfavBtn');
    const url = videoUrl(item);
    const bvid = itemBvid(item);
    if (root) {
      root.dataset.index = String(index);
      root.dataset.bvid = bvid;
      root.dataset.aid = String(item.id || item.aid || '');
      root.tabIndex = 0;
      root.setAttribute('role', 'option');
      root.setAttribute('aria-selected', index === state.selectedIndex ? 'true' : 'false');
      root.classList.toggle('current-video', Boolean(state.currentHighlightBvid && bvid && bvid === state.currentHighlightBvid));
      root.classList.toggle('selected-video', index === state.selectedIndex);
      root.addEventListener('mousedown', () => selectIndex(index, { scroll: false, silent: true }));
      root.addEventListener('focus', () => selectIndex(index, { scroll: false, silent: true }));
    }

    cover.loading = 'lazy';
    cover.decoding = 'async';
    cover.src = item.cover || '';
    title.textContent = item.title || '无标题';
    title.href = '#';
    title.addEventListener('click', e => { e.preventDefault(); selectIndex(index, { scroll: false, silent: true }); openVideo(url); });
    cover.addEventListener('click', () => { selectIndex(index, { scroll: false, silent: true }); openVideo(url); });
    cover.addEventListener('mouseenter', event => scheduleSidePreview(item, cover, event));
    cover.addEventListener('mouseleave', () => { clearTimeout(state.hoverTimer); state.leaveTimer = setTimeout(closeSidePreview, 180); });
    up.textContent = `UP：${item.upper?.name || '未知'}`;
    stats.textContent = `播放 ${fmtNum(item.cnt_info?.play)} · 弹幕 ${fmtNum(item.cnt_info?.danmaku)} · 时长 ${fmtDuration(item.duration)} · 收藏于 ${fmtDate(item.fav_time || item.mtime)}`;
    openBtn.addEventListener('click', () => { selectIndex(index, { scroll: false, silent: true }); openVideo(url); });
    unfavBtn.addEventListener('click', async () => {
      selectIndex(index, { scroll: false, silent: true });
      unfavBtn.disabled = true;
      try {
        await unfavItem(item, mediaId, 'sidepanel');
      } catch (e) {
        msg(e.message || String(e));
      } finally {
        unfavBtn.disabled = false;
      }
    });
    frag.appendChild(node);
  });
  els.list.appendChild(frag);
  updateSelectedClasses();
  if (els.loadMoreBtn) {
    els.loadMoreBtn.classList.toggle('hidden', allItems.length <= items.length);
    els.loadMoreBtn.textContent = allItems.length > items.length ? `加载更多（${items.length} / ${allItems.length}）` : '已全部显示';
  }
  if (state.items.length) msg(`当前显示 ${items.length} / 筛选后 ${allItems.length} / 已加载 ${state.items.length}`);
}

async function storeTrash(item, folderId, source = 'unknown', shouldRender = true) {
  const aid = Number(item.id || item.aid || item.rid);
  if (!aid || !folderId) return;
  const now = Date.now();
  const recent = await dbTrashByAidFolder(aid, folderId);
  const dup = recent.find(t => now - Number(t.deletedAt || 0) < 60000);
  if (dup) return;
  await dbPut('trash', {
    trashId: `${aid}_${folderId}_${now}`,
    aid,
    bvid: item.bvid || item.bv_id || '',
    folderId: String(folderId),
    folderTitle: folderTitleById(folderId),
    item,
    source,
    deletedAt: now
  });
  if (shouldRender) await renderTrash();
}

async function removeAidFromCache(aid, folderIds = [], createTrash = true) {
  const ids = folderIds.map(String).filter(Boolean);
  if (!ids.length) return;
  for (const folderId of ids) {
    const cache = await dbGet('items', folderId);
    if (!cache?.items?.length) continue;
    const found = cache.items.find(v => Number(v.id || v.aid || v.rid) === Number(aid));
    const next = cache.items.filter(v => Number(v.id || v.aid || v.rid) !== Number(aid));
    if (found && createTrash) await storeTrash(found, folderId, 'page');
    if (next.length !== cache.items.length) await saveItemsCache(folderId, next, cache.info, cache.partial, cache.syncState);
  }
  if (ids.includes(currentFolderId())) {
    replaceStateItems(state.items.filter(v => Number(v.id || v.aid) !== Number(aid)));
    render();
  }
}

async function addItemBackToCache(item, folderId) {
  if (!item || !folderId) return;
  const cache = await dbGet('items', folderId);
  const list = cache?.items ? [...cache.items] : [];
  if (!list.some(v => Number(v.id || v.aid || v.rid) === Number(item.id || item.aid || item.rid))) list.unshift(item);
  await saveItemsCache(folderId, list, cache?.info || null, cache?.partial || false, cache?.syncState || null);
  if (String(folderId) === currentFolderId()) {
    if (!state.items.some(v => Number(v.id || v.aid || v.rid) === Number(item.id || item.aid || item.rid))) replaceStateItems([item, ...state.items]);
    render();
  }
}

async function renderTrash() {
  const list = await dbRecentTrash(TRASH_DISPLAY_LIMIT);
  els.trashList.innerHTML = '';
  if (!list.length) {
    els.trashList.textContent = `回收站为空（最多加载最近 ${TRASH_DISPLAY_LIMIT} 条）。`;
    return;
  }
  for (const t of list) {
    const div = document.createElement('div');
    div.className = 'trash-item';
    const title = document.createElement('div');
    title.className = 'trash-title';
    title.textContent = t.item?.title || `av${t.aid}`;
    const meta = document.createElement('div');
    meta.className = 'trash-meta';
    meta.textContent = `${t.folderTitle || t.folderId} · ${new Date(t.deletedAt).toLocaleString('zh-CN', { hour12: false })}`;
    const actions = document.createElement('div');
    actions.className = 'trash-actions';
    const restore = document.createElement('button');
    restore.textContent = '恢复收藏';
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      try {
        await send('FAV_AID', { aid: t.aid, folderId: t.folderId });
        await addItemBackToCache(t.item, t.folderId);
        await dbDelete('trash', t.trashId);
        await renderTrash();
        msg('已恢复收藏。');
      } catch (e) {
        msg(e.message || String(e));
        restore.disabled = false;
      }
    });
    const open = document.createElement('button');
    open.textContent = '打开视频';
    open.addEventListener('click', () => openVideo(videoUrl(t.item || { id: t.aid, bvid: t.bvid })));
    const del = document.createElement('button');
    del.textContent = '移出回收站';
    del.className = 'danger-soft';
    del.addEventListener('click', async () => { await dbDelete('trash', t.trashId); await renderTrash(); });
    actions.append(restore, open, del);
    div.append(title, meta, actions);
    els.trashList.appendChild(div);
  }
  const hint = document.createElement('div');
  hint.className = 'trash-meta';
  hint.textContent = `仅加载最近 ${TRASH_DISPLAY_LIMIT} 条回收记录。`;
  els.trashList.appendChild(hint);
}

async function applyFavEvent(event) {
  const aid = Number(event?.aid);
  if (!event || !['add', 'del'].includes(event.action) || !Number.isSafeInteger(aid) || aid <= 0) return;
  const ids = [...new Set((event.folderIds || []).map(String).filter(value => /^\d+$/.test(value) && value !== '0'))];
  if (!ids.length) return;
  if (event.action === 'del') {
    await removeAidFromCache(aid, ids, true);
    msg('检测到播放页/网页取消收藏，已同步到插件缓存。');
  } else if (event.action === 'add') {
    const matches = (await Promise.all(ids.map(folderId => dbTrashByAidFolder(aid, folderId)))).flat();
    for (const t of matches) {
      await addItemBackToCache(t.item, t.folderId);
      await dbDelete('trash', t.trashId);
    }
    await renderTrash();
    if (matches.length) msg('检测到网页恢复收藏，已从回收站移回缓存。');
  }
}

async function applyPendingEvents() {
  try {
    const data = await send('GET_PENDING_FAV_EVENTS');
    for (const ev of data.events || []) await applyFavEvent(ev);
  } catch (_) {}
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeFilePart(s) { return String(s || '收藏夹').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60); }
function exportJson() {
  const data = {
    exportedAt: new Date().toISOString(),
    user: state.user,
    folderId: currentFolderId(),
    folderTitle: folderTitleById(currentFolderId()),
    count: state.items.length,
    items: sortedItems()
  };
  downloadText(`${safeFilePart(data.folderTitle)}_${Date.now()}.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
}
function csvCell(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }
function exportCsv() {
  const rows = [['标题', 'UP主', 'BV号', 'AV号', '播放量', '弹幕数', '时长秒', '收藏时间', '发布时间', '链接']];
  for (const item of sortedItems()) {
    rows.push([item.title, item.upper?.name, item.bvid || item.bv_id, item.id, item.cnt_info?.play, item.cnt_info?.danmaku, item.duration, fmtDate(item.fav_time || item.mtime), fmtDate(item.pubtime || item.ctime), videoUrl(item)]);
  }
  const csv = '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\n');
  downloadText(`${safeFilePart(folderTitleById(currentFolderId()))}_${Date.now()}.csv`, csv, 'text/csv;charset=utf-8');
}


async function findCurrentVideoInCache(bvid) {
  if (!bvid) return null;
  const currentItems = sortedItems();
  let index = currentItems.findIndex(item => itemBvid(item) === bvid);
  if (index >= 0) return { folderId: currentFolderId(), index, item: currentItems[index], fromCurrent: true };

  const rawIndex = state.items.findIndex(item => itemBvid(item) === bvid);
  if (rawIndex >= 0) {
    if (els.keyword.value) {
      els.keyword.value = '';
      await saveSettings();
    }
    const all = sortedItems();
    index = all.findIndex(item => itemBvid(item) === bvid);
    return { folderId: currentFolderId(), index: Math.max(0, index), item: all[index] || state.items[rawIndex], fromCurrent: true };
  }

  const caches = await dbAll('items');
  for (const cache of caches) {
    const items = cache?.items || [];
    const found = items.find(item => itemBvid(item) === bvid);
    if (!found) continue;
    return { folderId: String(cache.mediaId), index: -1, item: found, fromCurrent: false };
  }
  return null;
}

function scrollToRenderedBvid(bvid) {
  const el = document.querySelector(`.video-item[data-bvid="${cssEscapeValue(bvid)}"]`);
  if (!el) return false;
  const index = Number(el.dataset.index);
  if (Number.isFinite(index)) selectIndex(index, { scroll: false, silent: true });
  el.classList.add('current-video');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return true;
}

async function gotoCurrentVideo() {
  let data;
  try {
    data = await send('GET_ACTIVE_VIDEO_INFO');
  } catch (e) {
    return msg(e.message || String(e));
  }
  const bvid = data?.bvid;
  if (!bvid) return msg('当前活动标签页不是 B 站视频页。');

  const found = await findCurrentVideoInCache(bvid);
  if (!found) return msg(`当前视频 ${bvid} 不在已缓存的收藏夹里。可以先同步包含它的收藏夹。`);

  if (!found.fromCurrent && found.folderId && found.folderId !== currentFolderId()) {
    const opt = [...els.folderSelect.options].find(o => o.value === String(found.folderId));
    if (opt) {
      els.folderSelect.value = String(found.folderId);
      state.selectedFolderId = String(found.folderId);
      await openCacheForCurrentFolder();
    }
  }

  if (els.keyword.value) {
    els.keyword.value = '';
    await saveSettings();
  }
  state.currentHighlightBvid = bvid;
  const all = sortedItems();
  const index = all.findIndex(item => itemBvid(item) === bvid);
  if (index >= 0) {
    state.selectedIndex = index;
    const batch = Math.max(20, Math.min(500, Number(els.renderBatchSize.value || 80)));
    state.renderLimit = Math.max(state.renderLimit, Math.ceil((index + 1) / batch) * batch);
  }
  render();
  setTimeout(() => {
    const ok = scrollToRenderedBvid(bvid);
    msg(ok ? `已定位到当前视频：${bvid}` : `已切换收藏夹，但当前排序/筛选下未能定位：${bvid}`);
  }, 80);
}

async function applyActiveLayoutSettings() {
  try { await saveSettings(); } catch (_) {}
  try { await send('APPLY_ACTIVE_LAYOUT_SETTINGS'); } catch (_) {}
}

function bindEvents() {
  els.refreshBtn.addEventListener('click', () => refreshFolders().catch(e => msg(e.message)));
  els.openCacheBtn.addEventListener('click', () => openCacheForCurrentFolder().catch(e => msg(e.message)));
  els.syncBtn.addEventListener('click', () => slowSync().catch(e => msg(e.message)));
  els.clearCacheBtn.addEventListener('click', () => clearCurrentCache().catch(e => msg(e.message)));
  els.folderSelect.addEventListener('change', async () => { state.selectedFolderId = currentFolderId(); await saveSettings(); await openCacheForCurrentFolder(); });
  [els.sort1, els.sort2, els.sort3, els.dir1, els.dir2, els.dir3, els.keyword].forEach(el => {
    const rerender = () => {
      if ([els.sort1, els.sort2, els.sort3, els.dir1, els.dir2, els.dir3].includes(el)) resetRandomShuffle();
      saveSettings();
      resetRenderLimit();
      render();
    };
    el.addEventListener('input', rerender);
    el.addEventListener('change', rerender);
  });
  els.randomSort?.addEventListener('change', () => {
    resetRandomShuffle();
    updateSortControls();
    saveSettings();
    resetRenderLimit();
    render();
  });
  els.randomReshuffleBtn?.addEventListener('click', () => {
    resetRandomShuffle();
    render();
  });
  [els.shortcutScope, els.shortcutKey, els.previewEnabled, els.previewSound, els.previewRequireAlt, els.previewHoverDelay, els.previewRate, els.previewVolume, els.preserveVideoRate, els.focusPageAfterOpen, els.preservePlayerMode, els.theaterLayout, els.sideKeyboardEnabled, els.renderBatchSize].filter(Boolean).forEach(el => {
    el.addEventListener('input', () => { saveSettings(); if (el === els.renderBatchSize) { resetRenderLimit(); render(); } });
    el.addEventListener('change', () => { saveSettings(); if (el === els.renderBatchSize) { resetRenderLimit(); render(); } });
  });
  els.loadMoreBtn?.addEventListener('click', () => {
    const size = Math.max(20, Math.min(500, Number(els.renderBatchSize.value || 80)));
    state.renderLimit += size;
    render();
  });
  els.scrollTopBtn?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  els.gotoCurrentBtn?.addEventListener('click', () => gotoCurrentVideo().catch(e => msg(e.message || String(e))));
  els.theaterLayout?.addEventListener('change', () => applyActiveLayoutSettings());
  els.preservePlayerMode?.addEventListener('change', () => applyActiveLayoutSettings());
  els.trashPanel?.addEventListener('toggle', () => {
    if (els.trashPanel.open) renderTrash().catch(e => msg(e.message || String(e)));
  });
  els.exportJsonBtn.addEventListener('click', exportJson);
  els.exportCsvBtn.addEventListener('click', exportCsv);
  els.refreshTrashBtn.addEventListener('click', () => renderTrash().catch(e => msg(e.message)));
  els.clearTrashBtn.addEventListener('click', async () => {
    if (!window.confirm('确定清空插件回收站吗？移出的记录将无法恢复。')) return;
    await dbClear('trash');
    await renderTrash();
    msg('已清空插件回收站。');
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'BILI_FAV_CHANGED') applyFavEvent(message.event).catch(e => msg(e.message));
});

window.addEventListener('scroll', closeSidePreview, { passive: true, capture: true });
window.addEventListener('blur', closeSidePreview);

(async function init() {
  fillCriteria();
  bindEvents();
  bindSidepanelKeyboard();
  await loadSettings();
  const migrated = await migrateLegacyCacheIfNeeded();
  const hasFolderCache = await loadFoldersFromCache();
  if (hasFolderCache) {
    await openCacheForCurrentFolder();
    if (migrated.folders || migrated.items) msg(`已迁移旧版缓存：收藏夹列表 ${migrated.folders ? '已恢复' : '无需迁移'}，视频缓存 ${migrated.items} 个收藏夹。`);
  } else {
    msg('还没有缓存。先打开一个 B 站页面，然后点“刷新收藏夹”。');
  }
  els.trashList.textContent = `展开回收站后加载最近 ${TRASH_DISPLAY_LIMIT} 条记录。`;
  await applyPendingEvents();
})().catch(e => {
  els.userStatus.textContent = '初始化失败';
  msg(e.message || String(e));
});
