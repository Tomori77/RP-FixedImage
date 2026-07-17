import worker from '../_worker.js';

class MemoryObject {
    constructor(bytes, options = {}) {
        this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this.size = this.bytes.byteLength;
        this.httpMetadata = options.httpMetadata || {};
        this.customMetadata = options.customMetadata || {};
        this.uploaded = new Date();
        this.body = this.bytes;
    }

    async text() {
        return new TextDecoder().decode(this.bytes);
    }
}

class MemoryR2 {
    constructor() {
        this.objects = new Map();
    }

    async get(key) {
        return this.objects.get(key) || null;
    }

    async head(key) {
        return this.objects.get(key) || null;
    }

    async put(key, value, options = {}) {
        let bytes;
        if (typeof value === 'string') bytes = new TextEncoder().encode(value);
        else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
        else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        else throw new Error(`Unsupported mock R2 value for ${key}`);
        this.objects.set(key, new MemoryObject(bytes.slice(), options));
    }

    async delete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
    }

    async list({ prefix = '', cursor, limit = 1000 } = {}) {
        const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        const offset = cursor ? Number(cursor) : 0;
        const page = keys.slice(offset, offset + limit).map((key) => {
            const object = this.objects.get(key);
            return {
                key,
                size: object.size,
                uploaded: object.uploaded,
                httpMetadata: object.httpMetadata,
                customMetadata: object.customMetadata
            };
        });
        const next = offset + page.length;
        return { objects: page, truncated: next < keys.length, cursor: next < keys.length ? String(next) : undefined };
    }
}

const bucket = new MemoryR2();
const assetRequests = [];
const env = {
    RP_IMAGE_R2: bucket,
    RP_IMAGE_ADMIN_PASSWORD: 'test-password',
    ASSETS: {
        fetch: async (request) => {
            const pathname = new URL(request.url).pathname;
            assetRequests.push(pathname);
            if (pathname === '/') {
                return new Response('<!doctype html><html><body>RP Hub</body></html>', {
                    headers: { 'content-type': 'text/html; charset=utf-8' }
                });
            }
            return new Response('asset');
        }
    }
};
const origin = 'https://rp.example.com';
const originalFetch = globalThis.fetch;
let upstreamCalls = 0;
let lastUpstreamUrl = null;
let lastAccountBody = '';

globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'nai.sta1n.cn' && url.pathname === '/generate') {
        upstreamCalls += 1;
        lastUpstreamUrl = url;
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]), {
            headers: { 'content-type': 'image/png' }
        });
    }
    if (url.hostname === 'nai.sta1n.cn' && url.pathname === '/api/api/getUser') {
        if (init.body instanceof ArrayBuffer) lastAccountBody = new TextDecoder().decode(init.body);
        else if (ArrayBuffer.isView(init.body)) lastAccountBody = new TextDecoder().decode(init.body);
        else if (typeof init.body === 'string') lastAccountBody = init.body;
        else if (typeof input !== 'string' && !(input instanceof URL)) lastAccountBody = await input.clone().text();
        return Response.json({ status: 'ok', success: true, type: 'sta1n', data: { value: 100 } });
    }
    return originalFetch(input);
};

function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('origin', origin);
    return worker.fetch(new Request(`${origin}${path}`, { ...options, headers }), env, { waitUntil() {} });
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

try {
    const adminRedirect = await request('/rp-image');
    assert(adminRedirect.status === 308, 'admin path without slash did not redirect once');
    assert(adminRedirect.headers.get('location') === `${origin}/rp-image/`, 'admin redirect target is invalid');

    const adminPage = await request('/rp-image/');
    assert(adminPage.ok && await adminPage.text() === 'asset', 'admin page was not served as a static asset');
    assert(assetRequests.at(-1) === '/rp-image/', 'admin page was rewritten to index.html and may redirect loop');

    const rpHubPage = await request('/');
    const rpHubHtml = await rpHubPage.text();
    assert(rpHubHtml.includes('<script src="/rp-image/bridge.js" defer></script>'), 'RP-Hub HTML did not load the WebP bridge');

    const login = await request('/rp-image/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-password' })
    });
    assert(login.ok, 'login failed');
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const settings = await request('/rp-image/api/settings', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'sta1n', webpQuality: 0.82, backupRetention: 3 })
    });
    assert(settings.ok, 'settings save failed');

    const removedKeyEndpoint = await request('/rp-image/api/settings/nai-key', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'SHOULD-NOT-BE-STORED' })
    });
    assert(removedKeyEndpoint.status === 404, 'removed NAI key endpoint is still available');

    const accountBody = JSON.stringify({ toUserId: 'BROWSER-NAI-TOKEN' });
    const accountResponse = await request('/api/api/getUser', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: accountBody
    });
    const accountData = await accountResponse.json();
    assert(accountResponse.ok && accountData.data.value === 100, 'NAI account proxy failed');
    assert(lastAccountBody === accountBody, 'NAI account request body was not forwarded unchanged');

    const legacyParams = new URLSearchParams({
        tag: '1girl, red hair & blue eyes',
        token: 'BROWSER-NAI-TOKEN',
        character_name: 'Alice / 测试',
        model: 'nai-diffusion-4-5-full',
        artist: 'masterpiece, best quality',
        size: '竖图',
        steps: '40',
        scale: '6',
        cfg: '0',
        sampler: 'k_dpmpp_2m_sde',
        negative: 'bad anatomy',
        nocache: '0',
        noise_schedule: 'karras'
    });
    const legacyPath = `/generate?${legacyParams}`;
    const legacyFirst = await request(legacyPath);
    assert(legacyFirst.ok && legacyFirst.headers.get('x-rp-image-cache') === 'MISS', 'legacy proxy did not generate');
    assert(upstreamCalls === 1, 'legacy proxy did not call upstream exactly once');
    const expectedUpstreamParams = new URLSearchParams(legacyParams);
    expectedUpstreamParams.delete('character_name');
    assert(lastUpstreamUrl.search === `?${expectedUpstreamParams}`, 'legacy proxy did not forward NAI parameters unchanged');
    assert(!lastUpstreamUrl.searchParams.has('character_name'), 'local character name was forwarded to NAI');

    const cachedParams = new URLSearchParams(legacyParams);
    cachedParams.set('token', 'DIFFERENT-TOKEN');
    const legacySecond = await request(`/generate?${cachedParams}`);
    assert(legacySecond.ok && legacySecond.headers.get('x-rp-image-cache') === 'ORIGINAL', 'legacy proxy cache was not used');
    assert(upstreamCalls === 1, 'token unexpectedly changed the cache key');

    const characterPrefix = 'RP-image/image/Alice-测试--00000000-0000-4000-8000-000000000000/';
    assert([...bucket.objects.keys()].some((key) => key.startsWith(characterPrefix)), 'legacy proxy did not group images by character name');
    for (const object of bucket.objects.values()) {
        assert(!(await object.text()).includes('BROWSER-NAI-TOKEN'), 'browser token was persisted in R2');
    }

    const fakeWebp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 1, 2, 3, 4]);
    const webpParams = new URLSearchParams(legacyParams);
    webpParams.delete('token');
    const webpSave = await request(`/rp-image/api/webp?${webpParams}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/webp' },
        body: fakeWebp
    });
    assert(webpSave.ok, 'browser WebP upload failed');

    const legacyThird = await request(legacyPath);
    assert(legacyThird.ok && legacyThird.headers.get('x-rp-image-cache') === 'WEBP', 'WebP cache was not preferred');
    assert(upstreamCalls === 1, 'WebP cache unexpectedly called upstream');

    const chunkBytes = new TextEncoder().encode('{"type":"snapshot"}\n');
    const chunkHash = await crypto.subtle.digest('SHA-256', chunkBytes);
    const chunkSha = [...new Uint8Array(chunkHash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const start = await request('/rp-image/api/backup/start', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ siteName: 'rp.example.com', totalBytes: chunkBytes.byteLength, chunkCount: 1 })
    });
    const startData = await start.json();
    assert(start.ok && startData.backupId, 'backup start failed');
    const backupId = startData.backupId;

    const chunk = await request(`/rp-image/api/backup/chunk?${new URLSearchParams({ backupId, index: '0' })}`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/octet-stream', 'x-rp-chunk-sha256': chunkSha },
        body: chunkBytes
    });
    assert(chunk.ok, 'backup chunk upload failed');

    const commit = await request('/rp-image/api/backup/commit', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
            backupId,
            format: 'rp-image-browser-backup-jsonl-v1',
            schemaVersion: 1,
            recordCount: 0,
            checksum: await (async () => {
                const source = JSON.stringify([
                    'rp-image-browser-backup-jsonl-v1',
                    1,
                    0,
                    chunkBytes.byteLength,
                    [[chunkSha, chunkBytes.byteLength]]
                ]);
                const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
                return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
            })(),
            chunks: [{ index: 0, size: chunkBytes.byteLength, sha256: chunkSha }]
        })
    });
    assert(commit.ok, 'backup commit failed');

    const list = await request('/rp-image/api/backup/list?siteName=rp.example.com', { headers: { cookie } });
    const listData = await list.json();
    assert(list.ok && listData.backups.length === 1, 'backup list failed');

    console.log('worker smoke test passed');
} finally {
    globalThis.fetch = originalFetch;
}
