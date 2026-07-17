(function () {
    'use strict';

    const RENDER_PATH = '/rp-image/api/render';
    const WEBP_PATH = '/rp-image/api/webp';
    const SETTINGS_PATH = '/rp-image/api/settings/public';
    const DEFAULT_QUALITY = 0.82;
    const IMAGE_PARAMS = Object.freeze({
        characterName: 'character_name',
        characterUuid: 'character_uuid',
        prompt: 'tag',
        provider: 'provider',
        model: 'model',
        artist: 'artist',
        size: 'size',
        steps: 'steps',
        scale: 'scale',
        cfg: 'cfg',
        sampler: 'sampler',
        negative: 'negative',
        noiseSchedule: 'noise_schedule',
        rerollNonce: 'reroll_nonce'
    });

    const attemptedUrls = new Set();
    const pendingUrls = [];
    const activeControllers = new Set();
    const idleWaiters = new Set();
    let qualityPromise = null;
    let channel = null;
    let running = false;
    let disposed = false;

    function buildImageUrl(params) {
        const url = new URL(RENDER_PATH, window.location.origin);
        if (!params || typeof params !== 'object') return url.href;

        for (const [name, queryName] of Object.entries(IMAGE_PARAMS)) {
            const value = params[name];
            if (value === undefined || value === null || value === '') continue;
            url.searchParams.set(queryName, String(value));
        }
        return url.href.replace(/([?&]tag=)%241(?:&|$)/, (match, prefix) => {
            const suffix = match.endsWith('&') ? '&' : '';
            return `${prefix}$1${suffix}`;
        });
    }

    function isRenderUrl(value) {
        try {
            const url = new URL(value, window.location.href);
            return url.origin === window.location.origin && url.pathname === RENDER_PATH;
        } catch (_) {
            return false;
        }
    }

    function normalizeQuality(value) {
        if (value === null || value === undefined || value === '') return null;
        let quality = Number(value);
        if (!Number.isFinite(quality)) return null;
        if (quality > 1 && quality <= 100) quality /= 100;
        if (quality < 0 || quality > 1) return null;
        return quality;
    }

    async function fetchQuality() {
        const controller = new AbortController();
        activeControllers.add(controller);

        try {
            const response = await fetch(SETTINGS_PATH, {
                credentials: 'same-origin',
                signal: controller.signal
            });
            if (!response.ok) return DEFAULT_QUALITY;

            const settings = await response.json();
            const values = [
                settings && settings.quality,
                settings && settings.webpQuality,
                settings && settings.webp_quality,
                settings && settings.data && settings.data.quality,
                settings && settings.data && settings.data.webpQuality,
                settings && settings.data && settings.data.webp_quality
            ];

            for (const value of values) {
                const quality = normalizeQuality(value);
                if (quality !== null) return quality;
            }
        } catch (_) {
            // Image backup is best-effort and must not affect page rendering.
        } finally {
            activeControllers.delete(controller);
        }

        return DEFAULT_QUALITY;
    }

    function getQuality() {
        if (!qualityPromise) qualityPromise = fetchQuality();
        return qualityPromise;
    }

    function canvasToWebp(canvas, quality) {
        return new Promise((resolve) => {
            canvas.toBlob(resolve, 'image/webp', quality);
        });
    }

    async function convertAndUpload(sourceUrl) {
        const controller = new AbortController();
        activeControllers.add(controller);
        let bitmap = null;
        let canvas = null;

        try {
            const response = await fetch(sourceUrl, {
                cache: 'force-cache',
                credentials: 'same-origin',
                signal: controller.signal
            });
            if (!response.ok) return;

            const original = await response.blob();
            const contentType = (response.headers.get('content-type') || original.type || '').toLowerCase();
            if (!original.size || contentType.includes('image/webp')) return;
            if (typeof createImageBitmap !== 'function') return;

            bitmap = await createImageBitmap(original);
            if (!bitmap.width || !bitmap.height) return;

            canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d');
            if (!context) return;

            context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
            const webp = await canvasToWebp(canvas, await getQuality());
            if (!webp || webp.type !== 'image/webp' || !webp.size || webp.size >= original.size) return;

            const uploadUrl = new URL(WEBP_PATH, window.location.origin);
            uploadUrl.search = new URL(sourceUrl).search;
            const uploadResponse = await fetch(uploadUrl.href, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'image/webp' },
                body: webp,
                signal: controller.signal
            });
            if (!uploadResponse.ok) return;
        } catch (_) {
            attemptedUrls.delete(sourceUrl);
            // Conversion and upload failures must never break chat images.
        } finally {
            if (bitmap && typeof bitmap.close === 'function') bitmap.close();
            if (canvas) {
                canvas.width = 1;
                canvas.height = 1;
            }
            activeControllers.delete(controller);
        }
    }

    function settleIdle() {
        if (running || pendingUrls.length) return;
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
    }

    async function drainQueue() {
        if (running || disposed) return;
        running = true;

        try {
            while (!disposed && pendingUrls.length) {
                await convertAndUpload(pendingUrls.shift());
            }
        } finally {
            running = false;
            settleIdle();
        }
    }

    function enqueue(sourceUrl) {
        const normalizedUrl = new URL(sourceUrl, window.location.href).href;
        if (disposed || attemptedUrls.has(normalizedUrl)) return;

        attemptedUrls.add(normalizedUrl);
        pendingUrls.push(normalizedUrl);
        void drainQueue();
    }

    function inspectImage(image) {
        if (disposed) return;
        const sourceUrl = image.currentSrc || image.src;
        if (!sourceUrl || !image.complete || !image.naturalWidth || !isRenderUrl(sourceUrl)) return;
        enqueue(sourceUrl);
    }

    function onImageLoad(event) {
        const image = event.target;
        if (typeof HTMLImageElement === 'undefined' || !(image instanceof HTMLImageElement)) return;
        inspectImage(image);
    }

    function waitForIdle() {
        if (!running && !pendingUrls.length) return Promise.resolve();
        return new Promise((resolve) => idleWaiters.add(resolve));
    }

    function postChannelResponse(action, request, ok, result, error) {
        if (!channel || disposed) return;

        const response = {
            type: 'rp-fixed-image-backup:response',
            action,
            requestId: request.requestId !== undefined ? request.requestId : request.id,
            ok
        };
        if (ok && result !== undefined) response.result = result;
        if (!ok) response.error = error || 'Backup host request failed';

        try {
            channel.postMessage(response);
        } catch (_) {
            delete response.result;
            try {
                channel.postMessage(response);
            } catch (_) {
                // Ignore channel shutdown and non-cloneable host results.
            }
        }
    }

    async function callBackupHost(host, action, request) {
        const payload = request.payload !== undefined ? request.payload : request.data;
        if (typeof host === 'function') return host(action, payload, request);
        if (typeof host[action] === 'function') return host[action](payload, request);
        if (typeof host.handleRequest === 'function') return host.handleRequest(action, payload, request);
        if (typeof host.request === 'function') return host.request(action, payload, request);
        return undefined;
    }

    async function onChannelMessage(event) {
        const request = event && event.data;
        if (!request || typeof request !== 'object' || request.type === 'rp-fixed-image-backup:response') return;

        const action = request.action || request.type;
        if (!['flush', 'pause', 'resume', 'reload', 'flush-pause'].includes(action)) return;

        const host = window.RPH_BACKUP_HOST;
        if (!host) return;

        try {
            if (action === 'flush' || action === 'flush-pause') await waitForIdle();
            let result;
            if (action === 'flush-pause') {
                await callBackupHost(host, 'flush', request);
                result = await callBackupHost(host, 'pause', request);
            } else {
                result = await callBackupHost(host, action, request);
            }
            postChannelResponse(action, request, true, result);
        } catch (error) {
            postChannelResponse(action, request, false, undefined, error && error.message);
        }
    }

    function setupBackupChannel() {
        if (typeof BroadcastChannel !== 'function') return;

        try {
            channel = new BroadcastChannel('rp-fixed-image-backup');
            channel.addEventListener('message', onChannelMessage);
        } catch (_) {
            channel = null;
        }
    }

    function cleanup() {
        if (disposed) return;
        disposed = true;
        pendingUrls.length = 0;
        document.removeEventListener('load', onImageLoad, true);
        window.removeEventListener('beforeunload', cleanup);
        window.removeEventListener('pagehide', onPageHide);

        for (const controller of activeControllers) controller.abort();
        activeControllers.clear();
        settleIdle();

        if (channel) {
            channel.removeEventListener('message', onChannelMessage);
            channel.close();
            channel = null;
        }
    }

    function onPageHide(event) {
        if (!event.persisted) cleanup();
    }

    window.RPH_IMAGE_BRIDGE = Object.freeze({ buildImageUrl });
    document.addEventListener('load', onImageLoad, true);
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', onPageHide);
    setupBackupChannel();
    void getQuality();

    for (const image of document.querySelectorAll('img')) inspectImage(image);
}());
