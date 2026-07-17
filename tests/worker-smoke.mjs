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
const env = {
    RP_IMAGE_R2: bucket,
    RP_IMAGE_ADMIN_PASSWORD: 'test-password',
    RP_IMAGE_MASTER_KEY: 'test-master-key',
    ASSETS: { fetch: async () => new Response('asset') }
};
const origin = 'https://rp.example.com';
const originalFetch = globalThis.fetch;
let upstreamCalls = 0;

globalThis.fetch = async (input) => {
    const url = input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'nai.sta1n.cn' && url.pathname === '/generate') {
        upstreamCalls += 1;
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]), {
            headers: { 'content-type': 'image/png' }
        });
    }
    if (url.hostname === 'nai.sta1n.cn' && url.pathname === '/api/api/getUser') {
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

    const keySave = await request('/rp-image/api/settings/nai-key', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'NAI-SECRET-TEST' })
    });
    assert(keySave.ok, 'NAI key save failed');
    const encrypted = await bucket.get('RP-image/config/nai-key.json');
    assert(encrypted && !(await encrypted.text()).includes('NAI-SECRET-TEST'), 'NAI key was stored in plaintext');

    const imageParams = new URLSearchParams({
        character_name: 'Alice',
        character_uuid: '123e4567-e89b-12d3-a456-426614174000',
        tag: '1girl, blue hair',
        model: 'nai-diffusion-4-5-full',
        size: '竖图'
    });
    const imagePath = `/rp-image/api/render?${imageParams}`;
    const firstImage = await request(imagePath, { headers: { cookie } });
    assert(firstImage.ok && firstImage.headers.get('x-rp-image-cache') === 'MISS', 'first image was not a MISS');
    assert(upstreamCalls === 1, 'upstream should be called once');

    const secondImage = await request(imagePath);
    assert(secondImage.ok && secondImage.headers.get('x-rp-image-cache') === 'ORIGINAL', 'original cache was not used');
    assert(upstreamCalls === 1, 'original cache unexpectedly called upstream');

    const fakeWebp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 1, 2, 3, 4]);
    const webpSave = await request(`/rp-image/api/webp?${imageParams}`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'image/webp' },
        body: fakeWebp
    });
    assert(webpSave.ok, 'WebP save failed');

    const thirdImage = await request(imagePath);
    assert(thirdImage.ok && thirdImage.headers.get('x-rp-image-cache') === 'WEBP', 'WebP cache was not preferred');
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
