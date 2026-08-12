(() => {
  if (globalThis.__BILI_FAV_SORTER_PREVIEW_FRAME_V053__) return;
  globalThis.__BILI_FAV_SORTER_PREVIEW_FRAME_V053__ = true;

  const params = new URLSearchParams(location.search);
  if (params.get('bfs_preview') !== '1') return;

  const DEFAULT = {
    previewMuted: params.get('muted') !== '0',
    previewRate: Number(params.get('bfs_rate') || params.get('bfs_speed') || 4) || 4
  };

  let styleInjected = false;
  let lastTuneAt = 0;
  let observer = null;
  let intervalId = 0;
  const closeAfterMs = Math.max(4500, Math.min(12000, Math.ceil(30000 / Math.max(0.25, Number(DEFAULT.previewRate || 4))) + 2500));
  const stopAt = Date.now() + closeAfterMs;

  function injectStyle() {
    if (styleInjected || document.getElementById('bfs-preview-clean-style')) return;
    styleInjected = true;
    const style = document.createElement('style');
    style.id = 'bfs-preview-clean-style';
    style.textContent = `
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: #000 !important;
      }
      /* 只隐藏控制栏/弹幕/弹窗，不再隐藏播放器主体，避免黑屏。 */
      .bpx-player-control-wrap,
      .bpx-player-control-bottom,
      .bpx-player-control-top,
      .bpx-player-top-wrap,
      .bpx-player-ending-panel,
      .bpx-player-toast-wrap,
      .bpx-player-cmd-dm-wrap,
      .bpx-player-dm-wrap,
      .bpx-player-dialog-wrap,
      .bpx-player-sending-area,
      .bilibili-player-video-control,
      .bilibili-player-video-top,
      .bilibili-player-video-toast,
      .bilibili-player-video-popup,
      .bilibili-player-video-danmaku,
      .bilibili-player-video-sendbar,
      .bilibili-player-video-state,
      .bilibili-player-context-menu-container,
      .squirtle-controller-wrap,
      .squirtle-video-danmaku,
      .squirtle-progress-wrap {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
      video {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain !important;
        background: #000 !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      #bofqi,
      #bilibili-player,
      .bpx-player-container,
      .bpx-player-video-area,
      .bilibili-player-video {
        width: 100vw !important;
        height: 100vh !important;
        background: #000 !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  async function getSettings() {
    try {
      const s = await chrome.storage.local.get(['previewMuted', 'previewRate']);
      return { ...DEFAULT, ...s };
    } catch (_) {
      return DEFAULT;
    }
  }

  async function tuneVideo(force = false) {
    const now = Date.now();
    if (now > stopAt) {
      cleanup();
      return;
    }
    if (!force && now - lastTuneAt < 600) return;
    lastTuneAt = now;
    injectStyle();

    const settings = await getSettings();
    const rate = Math.max(0.25, Math.min(16, Number(settings.previewRate || 4)));
    const muted = settings.previewMuted !== false;
    const videos = Array.from(document.querySelectorAll('video'));

    for (const video of videos) {
      try {
        video.controls = false;
        video.muted = muted;
        video.defaultMuted = muted;
        if (!muted) video.volume = Math.max(video.volume || 0.7, 0.7);
        video.defaultPlaybackRate = rate;
        video.playbackRate = rate;
        if (video.currentTime >= 30) {
          video.pause();
          continue;
        }
        const p = video.play?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }
  }

  function cleanup() {
    try { observer?.disconnect?.(); } catch (_) {}
    if (intervalId) clearInterval(intervalId);
    for (const video of document.querySelectorAll('video')) {
      try {
        video.pause();
        video.removeAttribute('src');
        video.load?.();
      } catch (_) {}
    }
  }

  function boot() {
    tuneVideo(true);
    observer = new MutationObserver(() => tuneVideo(false));
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
    intervalId = setInterval(() => tuneVideo(false), 1500);
    setTimeout(cleanup, closeAfterMs);
    document.addEventListener('playing', () => tuneVideo(true), true);
    document.addEventListener('loadedmetadata', () => tuneVideo(true), true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
