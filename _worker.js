const API_PREFIX = '/rp-image/api';
const R2_BINDING = 'RP_IMAGE_R2';
const ADMIN_PASSWORD_ENV = 'RP_IMAGE_ADMIN_PASSWORD';
const SESSION_COOKIE = 'rp_image_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

const ROOT_PREFIX = 'RP-image';
const SETTINGS_KEY = `${ROOT_PREFIX}/config/settings.json`;
const IMAGE_PREFIX = `${ROOT_PREFIX}/image`;
const CACHE_PREFIX = `${ROOT_PREFIX}/Cache`;
const BACKUP_PREFIX = `${ROOT_PREFIX}/save`;
const SHARED_CHARACTER_NAME = '公共缓存';
const SHARED_CHARACTER_UUID = '00000000-0000-4000-8000-000000000000';

const MAX_JSON_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_WEBP_BYTES = 32 * 1024 * 1024;
const MAX_BACKUP_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_BACKUP_CHUNKS = 256;
const MAX_LIST_OBJECTS = 20000;
const UPSTREAM_TIMEOUT_MS = 120000;
const imageGenerationRuns = new Map();

const PROVIDERS = Object.freeze({
    sta1n: 'https://nai.sta1n.cn',
    std: 'https://std.loliyc.com'
});

const DEFAULT_SETTINGS = Object.freeze({
    provider: 'sta1n',
    webpQuality: 0.82,
    backupRetention: 5
});

const IMAGE_PARAM_RULES = Object.freeze({
    tag: { max: 30000, required: true },
    model: { max: 128, default: 'nai-diffusion-4-5-full' },
    artist: { max: 30000, default: '' },
    size: { max: 32, default: '\u7ad6\u56fe' },
    steps: { integer: true, min: 1, maxNumber: 100, default: '40' },
    scale: { number: true, min: 0, maxNumber: 50, default: '6' },
    cfg: { number: true, min: 0, maxNumber: 50, default: '0' },
    sampler: { max: 64, default: 'k_dpmpp_2m_sde' },
    negative: { max: 30000, default: '' },
    nocache: { enum: ['0', '1'], default: '0' },
    noise_schedule: { max: 64, default: 'karras' },
    reroll_nonce: { max: 128, default: '' }
});

const IMAGE_QUERY_NAMES = new Set([
    ...Object.keys(IMAGE_PARAM_RULES),
    'provider',
    'character_name',
    'characterName',
    'character_uuid',
    'characterUuid',
    'uuid',
    'token'
]);

class HttpError extends Error {
    constructor(status, message, code = 'request_error') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...extraHeaders
        }
    });
}

function fail(status, message, code = 'request_error', extra = {}) {
    return json({ ok: false, error: message, code, ...extra }, status);
}

function methodNotAllowed(allow) {
    return json({
        ok: false,
        error: 'Method not allowed.',
        code: 'method_not_allowed',
        allow
    }, 405, { allow });
}

function getSecret(env, name) {
    const value = env?.[name];
    return typeof value === 'string' && value.length > 0 ? value : '';
}

function getBucket(env) {
    const bucket = env?.[R2_BINDING];
    if (!bucket
        || typeof bucket.get !== 'function'
        || typeof bucket.put !== 'function'
        || typeof bucket.delete !== 'function'
        || typeof bucket.list !== 'function') {
        throw new HttpError(503, `Missing R2 binding: ${R2_BINDING}.`, 'r2_not_configured');
    }
    return bucket;
}

function requireAdminPassword(env) {
    const password = getSecret(env, ADMIN_PASSWORD_ENV);
    if (!password) {
        throw new HttpError(503, `Missing Secret: ${ADMIN_PASSWORD_ENV}.`, 'admin_password_not_configured');
    }
    return password;
}

function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(bytes) {
    const input = bytes instanceof ArrayBuffer
        ? bytes
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}

async function sha256Text(text) {
    return sha256Bytes(new TextEncoder().encode(text));
}

function base64UrlEncode(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function timingSafeTextEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const [leftHash, rightHash] = await Promise.all([sha256Text(left), sha256Text(right)]);
    return leftHash === rightHash;
}

function readCookie(request, name) {
    const cookie = request.headers.get('cookie') || '';
    for (const part of cookie.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return rest.join('=');
    }
    return '';
}

async function importSessionKey(password) {
    const material = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`rp-image-session-v1\0${password}`)
    );
    return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function createSessionToken(password) {
    const payload = new TextEncoder().encode(JSON.stringify({
        expiresAt: Date.now() + SESSION_SECONDS * 1000,
        nonce: crypto.randomUUID()
    }));
    const encodedPayload = base64UrlEncode(payload);
    const signature = await crypto.subtle.sign(
        'HMAC',
        await importSessionKey(password),
        new TextEncoder().encode(encodedPayload)
    );
    return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifySessionToken(token, password) {
    if (!token || token.length > 1024) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    try {
        const expected = await crypto.subtle.sign(
            'HMAC',
            await importSessionKey(password),
            new TextEncoder().encode(parts[0])
        );
        if (!await timingSafeTextEqual(parts[1], base64UrlEncode(new Uint8Array(expected)))) return false;
        const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
        return Number.isFinite(payload.expiresAt)
            && payload.expiresAt > Date.now()
            && payload.expiresAt <= Date.now() + SESSION_SECONDS * 1000 + 60000;
    } catch (error) {
        return false;
    }
}

function sessionCookie(token) {
    return `${SESSION_COOKIE}=${token}; Path=/rp-image; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie() {
    return `${SESSION_COOKIE}=; Path=/rp-image; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function isAdminAuthenticated(request, env) {
    const password = getSecret(env, ADMIN_PASSWORD_ENV);
    if (!password) return false;
    return verifySessionToken(readCookie(request, SESSION_COOKIE), password);
}

async function requireAdminSession(request, env) {
    const password = requireAdminPassword(env);
    if (!await verifySessionToken(readCookie(request, SESSION_COOKIE), password)) {
        throw new HttpError(401, 'Administrator session required.', 'authentication_required');
    }
}

function assertSameOrigin(request) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get('origin');
    if (origin) {
        if (origin !== requestUrl.origin) {
            throw new HttpError(403, 'Cross-origin API requests are not allowed.', 'origin_mismatch');
        }
        return;
    }

    const referer = request.headers.get('referer');
    if (referer) {
        let refererOrigin;
        try {
            refererOrigin = new URL(referer).origin;
        } catch (error) {
            throw new HttpError(403, 'Invalid Referer.', 'origin_mismatch');
        }
        if (refererOrigin !== requestUrl.origin) {
            throw new HttpError(403, 'Cross-origin API requests are not allowed.', 'origin_mismatch');
        }
        return;
    }

    if ((request.headers.get('sec-fetch-site') || '').toLowerCase() !== 'same-origin') {
        throw new HttpError(403, 'A same-origin browser request is required.', 'origin_required');
    }
}

async function readJson(request, maxBytes = MAX_JSON_BYTES) {
    const length = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(length) && length > maxBytes) {
        throw new HttpError(413, 'JSON body is too large.', 'body_too_large');
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
        throw new HttpError(413, 'JSON body is too large.', 'body_too_large');
    }
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
        return value;
    } catch (error) {
        throw new HttpError(400, 'Invalid JSON object.', 'invalid_json');
    }
}

function normalizeSettings(value) {
    const provider = value?.provider == null ? DEFAULT_SETTINGS.provider : String(value.provider).trim().toLowerCase();
    if (!Object.hasOwn(PROVIDERS, provider)) {
        throw new HttpError(400, 'provider must be sta1n or std.', 'invalid_provider');
    }

    let webpQuality = value?.webpQuality == null
        ? DEFAULT_SETTINGS.webpQuality
        : Number(value.webpQuality);
    if (webpQuality > 1 && webpQuality <= 100) webpQuality /= 100;
    if (!Number.isFinite(webpQuality) || webpQuality < 0.1 || webpQuality > 1) {
        throw new HttpError(400, 'webpQuality must be between 0.1 and 1.', 'invalid_webp_quality');
    }

    const backupRetention = value?.backupRetention == null
        ? DEFAULT_SETTINGS.backupRetention
        : Number(value.backupRetention);
    if (!Number.isInteger(backupRetention) || backupRetention < 1 || backupRetention > 30) {
        throw new HttpError(400, 'backupRetention must be an integer between 1 and 30.', 'invalid_backup_retention');
    }

    return { provider, webpQuality, backupRetention };
}

async function loadSettings(bucket) {
    const object = await bucket.get(SETTINGS_KEY);
    if (!object) return { ...DEFAULT_SETTINGS };
    try {
        return normalizeSettings(JSON.parse(await object.text()));
    } catch (error) {
        if (error instanceof HttpError) {
            throw new HttpError(500, 'Stored settings are invalid.', 'settings_corrupt');
        }
        throw new HttpError(500, 'Stored settings could not be read.', 'settings_corrupt');
    }
}

async function saveSettings(bucket, settings) {
    await bucket.put(SETTINGS_KEY, JSON.stringify(settings), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
}

async function objectExists(bucket, key) {
    if (typeof bucket.head === 'function') return Boolean(await bucket.head(key));
    return Boolean(await bucket.get(key));
}

function sanitizeName(value, fallback, maxLength = 64) {
    const result = String(value || '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f\\/:*?"<>|#%&{}$!`'@+=]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[.\-]+|[.\-]+$/g, '')
        .slice(0, maxLength)
        .replace(/[.\-]+$/g, '');
    return result || fallback;
}

function normalizeUuid(value) {
    const uuid = String(value || '').trim().toLowerCase();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8a-f][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uuid)) {
        throw new HttpError(400, 'A valid character_uuid is required.', 'invalid_character_uuid');
    }
    return uuid;
}

function buildCharacterDirectory(name, uuid) {
    return `${sanitizeName(name, 'character')}--${normalizeUuid(uuid)}`;
}

function validateCharacterDirectory(value) {
    const directory = String(value || '').normalize('NFKC');
    if (!directory || directory.length > 128 || directory.includes('/') || directory.includes('\\') || directory.includes('..')) {
        throw new HttpError(400, 'Invalid characterDir.', 'invalid_character_directory');
    }
    const separator = directory.lastIndexOf('--');
    if (separator <= 0) throw new HttpError(400, 'Invalid characterDir.', 'invalid_character_directory');
    const name = directory.slice(0, separator);
    const uuid = normalizeUuid(directory.slice(separator + 2));
    const normalized = `${sanitizeName(name, 'character')}--${uuid}`;
    if (normalized !== directory) throw new HttpError(400, 'Invalid characterDir.', 'invalid_character_directory');
    return directory;
}

function requireHash(value) {
    const hash = String(value || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
        throw new HttpError(400, 'Invalid SHA-256 hash.', 'invalid_hash');
    }
    return hash;
}

function getSingleAlias(searchParams, names, label) {
    const values = [];
    for (const name of names) {
        for (const value of searchParams.getAll(name)) values.push(value);
    }
    if (values.length > 1) throw new HttpError(400, `Duplicate ${label}.`, 'duplicate_parameter');
    return values[0] || '';
}

function normalizeImageParameter(name, rawValue, rule) {
    const value = rawValue == null || rawValue === '' ? rule.default ?? '' : String(rawValue).trim();
    if (rule.required && !value) throw new HttpError(400, `${name} is required.`, 'missing_parameter');
    if (rule.max && value.length > rule.max) {
        throw new HttpError(400, `${name} is too long.`, 'parameter_too_long');
    }
    if (rule.enum && !rule.enum.includes(value)) {
        throw new HttpError(400, `${name} has an invalid value.`, 'invalid_parameter');
    }
    if (rule.integer) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < rule.min || number > rule.maxNumber) {
            throw new HttpError(400, `${name} is out of range.`, 'invalid_parameter');
        }
        return String(number);
    }
    if (rule.number) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < rule.min || number > rule.maxNumber) {
            throw new HttpError(400, `${name} is out of range.`, 'invalid_parameter');
        }
        return String(number);
    }
    return value;
}

function buildImageRequest(url, settings, { legacy = false } = {}) {
    for (const [name] of url.searchParams) {
        if (name === 'token') {
            if (legacy) continue;
            throw new HttpError(400, 'token must never be placed in the request URL.', 'token_in_url');
        }
        if (!IMAGE_QUERY_NAMES.has(name)) {
            throw new HttpError(400, `Unsupported image parameter: ${name}.`, 'unsupported_parameter');
        }
        if (url.searchParams.getAll(name).length > 1) {
            throw new HttpError(400, `Duplicate image parameter: ${name}.`, 'duplicate_parameter');
        }
    }

    const requestedCharacterName = getSingleAlias(
        url.searchParams,
        ['character_name', 'characterName'],
        'character name'
    );
    if ((!legacy && !requestedCharacterName) || requestedCharacterName.length > 200) {
        throw new HttpError(400, 'character_name is required and must be at most 200 characters.', 'invalid_character_name');
    }
    const characterName = requestedCharacterName || SHARED_CHARACTER_NAME;
    const characterUuid = legacy
        ? SHARED_CHARACTER_UUID
        : getSingleAlias(
            url.searchParams,
            ['character_uuid', 'characterUuid', 'uuid'],
            'character UUID'
        );
    const characterDir = buildCharacterDirectory(characterName, characterUuid);

    const requestedProvider = String(url.searchParams.get('provider') || (legacy ? 'sta1n' : settings.provider)).trim().toLowerCase();
    if (!Object.hasOwn(PROVIDERS, requestedProvider)) {
        throw new HttpError(400, 'provider must be sta1n or std.', 'invalid_provider');
    }

    const params = { provider: requestedProvider };
    for (const [name, rule] of Object.entries(IMAGE_PARAM_RULES)) {
        params[name] = normalizeImageParameter(name, url.searchParams.get(name), rule);
    }
    const token = legacy ? String(url.searchParams.get('token') || '') : '';
    if (legacy && token.length > 2000) {
        throw new HttpError(400, 'token is too long.', 'invalid_token');
    }
    return { characterName, characterUuid: normalizeUuid(characterUuid), characterDir, params, token };
}

async function imageHash(params) {
    const canonical = [
        ['provider', params.provider],
        ...Object.keys(IMAGE_PARAM_RULES).map((name) => [name, params[name]])
    ];
    return sha256Text(JSON.stringify(canonical));
}

function originalImageKey(characterDir, hash) {
    return `${IMAGE_PREFIX}/${characterDir}/${hash}`;
}

function webpImageKey(characterDir, hash) {
    return `${CACHE_PREFIX}/${characterDir}/${hash}.webp`;
}

function immutableImageResponse(object, requestMethod, extraHeaders = {}) {
    const contentType = object.httpMetadata?.contentType || 'application/octet-stream';
    return new Response(requestMethod === 'HEAD' ? null : object.body, {
        headers: {
            'content-type': contentType,
            'content-length': String(object.size || 0),
            'cache-control': 'public, max-age=3600, must-revalidate',
            'x-content-type-options': 'nosniff',
            ...extraHeaders
        }
    });
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new HttpError(504, 'Upstream request timed out.', 'upstream_timeout');
        }
        throw new HttpError(502, 'Upstream request failed.', 'upstream_failure');
    } finally {
        clearTimeout(timer);
    }
}

async function generateImageFromOriginalRequest(url, params, token) {
    if (!token) throw new HttpError(400, 'token is required on a cache miss.', 'token_required');
    const upstream = new URL('/generate', PROVIDERS[params.provider]);
    upstream.search = url.search;
    for (const name of ['provider', 'character_name', 'characterName', 'character_uuid', 'characterUuid', 'uuid']) {
        upstream.searchParams.delete(name);
    }
    const response = await fetchWithTimeout(upstream, {
        method: 'GET',
        headers: {
            accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.1',
            'user-agent': 'RP-FixedImage-Worker/1.0'
        },
        redirect: 'error'
    }, UPSTREAM_TIMEOUT_MS);
    if (!response.ok) {
        throw new HttpError(502, `Image provider returned HTTP ${response.status}.`, 'upstream_http_error');
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(contentType)) {
        throw new HttpError(502, 'Image provider did not return an image.', 'upstream_invalid_content');
    }
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new HttpError(413, 'Generated image is empty or too large.', 'image_too_large');
    }
    return { bytes, contentType };
}

async function handleRender(request, env, url, options = {}) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const bucket = getBucket(env);
    const settings = await loadSettings(bucket);
    const imageRequest = buildImageRequest(url, settings, options);
    const hash = await imageHash(imageRequest.params);
    const webpKey = webpImageKey(imageRequest.characterDir, hash);
    const originalKey = originalImageKey(imageRequest.characterDir, hash);

    const webp = await bucket.get(webpKey);
    if (webp) {
        return immutableImageResponse(webp, request.method, {
            'x-rp-image-cache': 'WEBP',
            'x-rp-image-hash': hash
        });
    }
    const original = await bucket.get(originalKey);
    if (original) {
        return new Response(request.method === 'HEAD' ? null : original.body, {
            headers: {
                'content-type': original.httpMetadata?.contentType || 'application/octet-stream',
                'content-length': String(original.size || 0),
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
                'x-rp-image-cache': 'ORIGINAL',
                'x-rp-image-hash': hash
            }
        });
    }

    if (request.method === 'HEAD') {
        return new Response(null, {
            status: 404,
            headers: { 'cache-control': 'no-store', 'x-rp-image-cache': 'MISS', 'x-rp-image-hash': hash }
        });
    }

    if (!options.legacy) {
        throw new HttpError(400, 'Use /generate or /rp-image/api/generate with a token.', 'token_required');
    }
    let generation = imageGenerationRuns.get(originalKey);
    if (!generation) {
        generation = (async () => {
            const generated = await generateImageFromOriginalRequest(url, imageRequest.params, imageRequest.token);
            await bucket.put(originalKey, generated.bytes, {
                httpMetadata: { contentType: generated.contentType },
                customMetadata: {
                    hash,
                    characterUuid: imageRequest.characterUuid,
                    provider: imageRequest.params.provider,
                    createdAt: String(Date.now())
                }
            });
            return generated;
        })().finally(() => imageGenerationRuns.delete(originalKey));
        imageGenerationRuns.set(originalKey, generation);
    }
    const generated = await generation;

    return new Response(generated.bytes, {
        headers: {
            'content-type': generated.contentType,
            'content-length': String(generated.bytes.byteLength),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'x-rp-image-cache': 'MISS',
            'x-rp-image-hash': hash
        }
    });
}

async function handleWebp(request, env, url) {
    if (request.method !== 'PUT') return methodNotAllowed('PUT');
    const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'image/webp') {
        throw new HttpError(415, 'Only image/webp is accepted.', 'invalid_content_type');
    }
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBP_BYTES) {
        throw new HttpError(413, 'WebP image is too large.', 'webp_too_large');
    }

    const bucket = getBucket(env);
    const settings = await loadSettings(bucket);
    const imageRequest = buildImageRequest(url, settings, { legacy: true });
    const hash = await imageHash(imageRequest.params);
    const originalKey = originalImageKey(imageRequest.characterDir, hash);
    if (!await objectExists(bucket, originalKey)) {
        throw new HttpError(404, 'The original image does not exist.', 'original_not_found');
    }

    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_WEBP_BYTES) {
        throw new HttpError(413, 'WebP image is empty or too large.', 'webp_too_large');
    }
    const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 12));
    const isWebp = signature.length === 12
        && String.fromCharCode(...signature.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...signature.subarray(8, 12)) === 'WEBP';
    if (!isWebp) throw new HttpError(415, 'The request body is not a valid WebP file.', 'invalid_webp');
    const key = webpImageKey(imageRequest.characterDir, hash);
    await bucket.put(key, bytes, {
        httpMetadata: { contentType: 'image/webp' },
        customMetadata: {
            hash,
            characterUuid: imageRequest.characterUuid,
            originalKey,
            createdAt: String(Date.now())
        }
    });
    return json({ ok: true, hash, key, bytes: bytes.byteLength });
}

async function listAll(bucket, prefix, include = []) {
    const objects = [];
    let cursor;
    do {
        const options = { prefix, cursor, limit: 1000 };
        if (include.length) options.include = include;
        const page = await bucket.list(options);
        for (const object of page.objects || []) {
            objects.push(object);
            if (objects.length > MAX_LIST_OBJECTS) {
                throw new HttpError(413, 'The object listing is too large.', 'listing_too_large');
            }
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return objects;
}

function parseImageObject(key, type) {
    const prefix = type === 'webp' ? `${CACHE_PREFIX}/` : `${IMAGE_PREFIX}/`;
    if (!key.startsWith(prefix)) return null;
    const relative = key.slice(prefix.length);
    const slash = relative.lastIndexOf('/');
    if (slash <= 0) return null;
    const characterDir = relative.slice(0, slash);
    const fileName = relative.slice(slash + 1);
    const hash = type === 'webp' && fileName.endsWith('.webp') ? fileName.slice(0, -5) : fileName;
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    try {
        validateCharacterDirectory(characterDir);
    } catch (error) {
        return null;
    }
    const separator = characterDir.lastIndexOf('--');
    return {
        characterDir,
        characterName: characterDir.slice(0, separator),
        characterUuid: characterDir.slice(separator + 2),
        hash
    };
}

function objectSummary(object) {
    return {
        key: object.key,
        size: Number(object.size || 0),
        uploaded: object.uploaded ? new Date(object.uploaded).toISOString() : '',
        contentType: object.httpMetadata?.contentType || 'application/octet-stream'
    };
}

async function handleImageList(request, env) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    await requireAdminSession(request, env);
    const bucket = getBucket(env);
    const [originals, webps] = await Promise.all([
        listAll(bucket, `${IMAGE_PREFIX}/`, ['httpMetadata', 'customMetadata']),
        listAll(bucket, `${CACHE_PREFIX}/`, ['httpMetadata', 'customMetadata'])
    ]);
    const characters = new Map();

    for (const [type, objects] of [['original', originals], ['webp', webps]]) {
        for (const object of objects) {
            const parsed = parseImageObject(object.key, type);
            if (!parsed) continue;
            if (!characters.has(parsed.characterDir)) {
                characters.set(parsed.characterDir, {
                    characterDir: parsed.characterDir,
                    name: parsed.characterName,
                    uuid: parsed.characterUuid,
                    totalBytes: 0,
                    images: new Map()
                });
            }
            const character = characters.get(parsed.characterDir);
            if (!character.images.has(parsed.hash)) {
                character.images.set(parsed.hash, { hash: parsed.hash, original: null, webp: null });
            }
            character.images.get(parsed.hash)[type] = objectSummary(object);
            character.totalBytes += Number(object.size || 0);
        }
    }

    const result = Array.from(characters.values()).map((character) => ({
        characterDir: character.characterDir,
        name: character.name,
        uuid: character.uuid,
        count: character.images.size,
        totalBytes: character.totalBytes,
        images: Array.from(character.images.values()).sort((left, right) => {
            const leftDate = left.webp?.uploaded || left.original?.uploaded || '';
            const rightDate = right.webp?.uploaded || right.original?.uploaded || '';
            return rightDate.localeCompare(leftDate);
        })
    })).sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));

    return json({
        ok: true,
        characterCount: result.length,
        imageCount: result.reduce((sum, character) => sum + character.count, 0),
        totalBytes: result.reduce((sum, character) => sum + character.totalBytes, 0),
        characters: result
    });
}

function imageKeyFromQuery(url) {
    const characterDir = validateCharacterDirectory(url.searchParams.get('characterDir'));
    const hash = requireHash(url.searchParams.get('hash'));
    const copy = String(url.searchParams.get('copy') || 'original').toLowerCase();
    if (copy !== 'original' && copy !== 'webp') {
        throw new HttpError(400, 'copy must be original or webp.', 'invalid_copy');
    }
    return { characterDir, hash, copy, key: copy === 'webp' ? webpImageKey(characterDir, hash) : originalImageKey(characterDir, hash) };
}

async function handleImageRead(request, env, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    await requireAdminSession(request, env);
    const target = imageKeyFromQuery(url);
    const object = await getBucket(env).get(target.key);
    if (!object) throw new HttpError(404, 'Image copy not found.', 'image_not_found');
    return new Response(request.method === 'HEAD' ? null : object.body, {
        headers: {
            'content-type': object.httpMetadata?.contentType || (target.copy === 'webp' ? 'image/webp' : 'application/octet-stream'),
            'content-length': String(object.size || 0),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff'
        }
    });
}

async function deleteKeys(bucket, keys) {
    const unique = [...new Set(keys)].filter(Boolean);
    for (let offset = 0; offset < unique.length; offset += 500) {
        await bucket.delete(unique.slice(offset, offset + 500));
    }
}

async function handleImageDelete(request, env, url) {
    if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
    await requireAdminSession(request, env);
    const body = request.headers.get('content-type')?.includes('application/json')
        ? await readJson(request)
        : {};
    const characterDir = validateCharacterDirectory(body.characterDir || url.searchParams.get('characterDir'));
    const bucket = getBucket(env);

    if (body.character === true || url.searchParams.get('character') === '1') {
        const [originals, webps] = await Promise.all([
            listAll(bucket, `${IMAGE_PREFIX}/${characterDir}/`),
            listAll(bucket, `${CACHE_PREFIX}/${characterDir}/`)
        ]);
        const keys = [...originals, ...webps].map((object) => object.key);
        await deleteKeys(bucket, keys);
        return json({ ok: true, deletedCopies: keys.length, characterDir });
    }

    const hash = requireHash(body.hash || url.searchParams.get('hash'));
    const copy = String(body.copy || url.searchParams.get('copy') || 'all').toLowerCase();
    if (!['original', 'webp', 'all'].includes(copy)) {
        throw new HttpError(400, 'copy must be original, webp, or all.', 'invalid_copy');
    }
    const keys = [];
    if (copy === 'original' || copy === 'all') keys.push(originalImageKey(characterDir, hash));
    if (copy === 'webp' || copy === 'all') keys.push(webpImageKey(characterDir, hash));
    const existence = await Promise.all(keys.map((key) => objectExists(bucket, key)));
    await deleteKeys(bucket, keys);
    return json({ ok: true, deletedCopies: existence.filter(Boolean).length, characterDir, hash, copy });
}

async function handleAuth(request, env, url) {
    if (url.pathname === `${API_PREFIX}/auth/status`) {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        const passwordConfigured = Boolean(getSecret(env, ADMIN_PASSWORD_ENV));
        return json({
            ok: true,
            passwordConfigured,
            authenticated: passwordConfigured && await isAdminAuthenticated(request, env)
        });
    }
    if (url.pathname === `${API_PREFIX}/auth/login`) {
        if (request.method !== 'POST') return methodNotAllowed('POST');
        const expected = requireAdminPassword(env);
        const body = await readJson(request, 8192);
        const supplied = typeof body.password === 'string' ? body.password : '';
        if (!supplied || !await timingSafeTextEqual(supplied, expected)) {
            throw new HttpError(401, 'Invalid administrator password.', 'invalid_password');
        }
        return json({ ok: true, expiresIn: SESSION_SECONDS }, 200, {
            'set-cookie': sessionCookie(await createSessionToken(expected))
        });
    }
    if (url.pathname === `${API_PREFIX}/auth/logout`) {
        if (request.method !== 'POST') return methodNotAllowed('POST');
        return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
    }
    return null;
}

async function handleSettings(request, env, url) {
    const bucket = getBucket(env);
    if (url.pathname === `${API_PREFIX}/settings/public`) {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        const settings = await loadSettings(bucket);
        return json({ ok: true, webpQuality: settings.webpQuality });
    }
    await requireAdminSession(request, env);
    if (url.pathname === `${API_PREFIX}/settings/status`) {
        if (request.method !== 'GET') return methodNotAllowed('GET');
        return json({
            ok: true,
            configured: {
                r2: true,
                adminPassword: Boolean(getSecret(env, ADMIN_PASSWORD_ENV))
            }
        });
    }
    if (url.pathname === `${API_PREFIX}/settings`) {
        if (request.method === 'GET') {
            const settings = await loadSettings(bucket);
            return json({ ok: true, ...settings });
        }
        if (request.method === 'PUT') {
            const body = await readJson(request);
            const current = await loadSettings(bucket);
            const settings = normalizeSettings({ ...current, ...body });
            await saveSettings(bucket, settings);
            return json({ ok: true, ...settings });
        }
        return methodNotAllowed('GET, PUT');
    }
    return null;
}

async function handleNaiAccountProxy(request) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const body = await request.arrayBuffer();
    if (body.byteLength > 16384) throw new HttpError(413, 'Request body is too large.', 'body_too_large');
    const response = await fetchWithTimeout(new URL('/api/api/getUser', PROVIDERS.sta1n), {
        method: 'POST',
        headers: {
            accept: request.headers.get('accept') || 'application/json',
            'content-type': request.headers.get('content-type') || 'application/json; charset=utf-8',
            'user-agent': 'RP-FixedImage-Worker/1.0'
        },
        body,
        redirect: 'error'
    }, UPSTREAM_TIMEOUT_MS);
    return new Response(response.body, {
        status: response.status,
        headers: {
            'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff'
        }
    });
}

function originHashForRequest(request) {
    return sha256Text(new URL(request.url).origin.toLowerCase());
}

async function buildSiteInfo(request, siteName) {
    const safeSiteName = sanitizeName(siteName, 'site', 64);
    if (!siteName || String(siteName).length > 200) {
        throw new HttpError(400, 'siteName is required and must be at most 200 characters.', 'invalid_site_name');
    }
    const originHash = await originHashForRequest(request);
    return { safeSiteName, originHash, siteDir: `${safeSiteName}--${originHash}` };
}

function validateBackupId(backupId, expectedOriginHash) {
    const value = String(backupId || '');
    if (!value || value.length > 220 || value.includes('..') || value.includes('\\')) {
        throw new HttpError(400, 'Invalid backupId.', 'invalid_backup_id');
    }
    const parts = value.split('/');
    if (parts.length !== 2 || !/^\d{13,16}$/.test(parts[1]) || !parts[0].endsWith(`--${expectedOriginHash}`)) {
        throw new HttpError(400, 'Invalid backupId.', 'invalid_backup_id');
    }
    const separator = parts[0].lastIndexOf('--');
    const siteName = parts[0].slice(0, separator);
    if (!siteName || sanitizeName(siteName, 'site', 64) !== siteName) {
        throw new HttpError(400, 'Invalid backupId.', 'invalid_backup_id');
    }
    return value;
}

function backupRoot(backupId) {
    return `${BACKUP_PREFIX}/${backupId}`;
}

function backupChunkKey(backupId, index) {
    return `${backupRoot(backupId)}/chunks/${String(index).padStart(6, '0')}.bin`;
}

async function readUploadMarker(bucket, backupId) {
    const object = await bucket.get(`${backupRoot(backupId)}/_upload.json`);
    if (!object) throw new HttpError(404, 'Backup upload session not found.', 'backup_upload_not_found');
    try {
        return JSON.parse(await object.text());
    } catch (error) {
        throw new HttpError(500, 'Backup upload marker is invalid.', 'backup_upload_corrupt');
    }
}

function normalizeChunkManifest(chunks, marker) {
    if (!Array.isArray(chunks) || chunks.length !== marker.chunkCount) {
        throw new HttpError(400, 'Backup chunk manifest count does not match start.', 'invalid_chunk_manifest');
    }
    let totalBytes = 0;
    const seen = new Set();
    const normalized = chunks.map((chunk) => {
        const index = Number(chunk?.index);
        const size = Number(chunk?.size ?? chunk?.length);
        const sha256 = String(chunk?.sha256 || chunk?.checksum || '').toLowerCase();
        if (!Number.isInteger(index) || index < 0 || index >= marker.chunkCount || seen.has(index)) {
            throw new HttpError(400, 'Backup chunk index is invalid or duplicated.', 'invalid_chunk_manifest');
        }
        if (!Number.isInteger(size) || size <= 0 || size > MAX_BACKUP_CHUNK_BYTES) {
            throw new HttpError(400, 'Backup chunk size is invalid.', 'invalid_chunk_manifest');
        }
        if (!/^[a-f0-9]{64}$/.test(sha256)) {
            throw new HttpError(400, 'Backup chunk SHA-256 is invalid.', 'invalid_chunk_manifest');
        }
        seen.add(index);
        totalBytes += size;
        return { index, size, sha256 };
    }).sort((left, right) => left.index - right.index);
    if (totalBytes !== marker.totalBytes) {
        throw new HttpError(400, 'Backup chunk sizes do not match totalBytes.', 'invalid_chunk_manifest');
    }
    return normalized;
}

async function validateStoredBackupChunks(bucket, backupId, chunks) {
    for (const chunk of chunks) {
        const object = typeof bucket.head === 'function'
            ? await bucket.head(backupChunkKey(backupId, chunk.index))
            : await bucket.get(backupChunkKey(backupId, chunk.index));
        if (!object || Number(object.size) !== chunk.size || object.customMetadata?.sha256 !== chunk.sha256) {
            throw new HttpError(409, `Backup chunk ${chunk.index} is missing or invalid.`, 'backup_chunk_invalid');
        }
    }
}

async function cleanupBackupRetention(bucket, siteDir, retention) {
    const objects = await listAll(bucket, `${BACKUP_PREFIX}/${siteDir}/`);
    const timestamps = objects
        .filter((object) => object.key.endsWith('/manifest.json'))
        .map((object) => object.key.slice(`${BACKUP_PREFIX}/${siteDir}/`.length).split('/')[0])
        .filter((timestamp) => /^\d{13,16}$/.test(timestamp))
        .sort((left, right) => right.localeCompare(left));
    const stale = timestamps.slice(retention);
    for (const timestamp of stale) {
        const staleObjects = await listAll(bucket, `${BACKUP_PREFIX}/${siteDir}/${timestamp}/`);
        await deleteKeys(bucket, staleObjects.map((object) => object.key));
    }
    return stale.length;
}

async function handleBackupStart(request, env) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    await requireAdminSession(request, env);
    const body = await readJson(request);
    const totalBytes = Number(body.totalBytes);
    const chunkCount = Number(body.chunkCount);
    if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_BACKUP_TOTAL_BYTES) {
        throw new HttpError(400, 'totalBytes is outside the allowed backup range.', 'invalid_backup_size');
    }
    if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_BACKUP_CHUNKS) {
        throw new HttpError(400, 'chunkCount is outside the allowed backup range.', 'invalid_chunk_count');
    }
    if (totalBytes > chunkCount * MAX_BACKUP_CHUNK_BYTES) {
        throw new HttpError(400, 'totalBytes cannot fit in the declared chunks.', 'invalid_backup_size');
    }
    const site = await buildSiteInfo(request, body.siteName);
    const bucket = getBucket(env);
    let timestamp = Date.now();
    while (await objectExists(bucket, `${BACKUP_PREFIX}/${site.siteDir}/${timestamp}/_upload.json`)
        || await objectExists(bucket, `${BACKUP_PREFIX}/${site.siteDir}/${timestamp}/manifest.json`)) {
        timestamp += 1;
    }
    const backupId = `${site.siteDir}/${timestamp}`;
    const marker = {
        version: 1,
        backupId,
        siteName: site.safeSiteName,
        originHash: site.originHash,
        timestamp,
        totalBytes,
        chunkCount,
        createdAt: new Date().toISOString()
    };
    await bucket.put(`${backupRoot(backupId)}/_upload.json`, JSON.stringify(marker), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
    return json({ ok: true, backupId, timestamp, maxChunkBytes: MAX_BACKUP_CHUNK_BYTES });
}

async function handleBackupChunkUpload(request, env, url) {
    if (request.method !== 'PUT') return methodNotAllowed('PUT');
    await requireAdminSession(request, env);
    const originHash = await originHashForRequest(request);
    const backupId = validateBackupId(url.searchParams.get('backupId'), originHash);
    const index = Number(url.searchParams.get('index'));
    const expectedHash = String(
        request.headers.get('x-rp-chunk-sha256') || url.searchParams.get('sha256') || ''
    ).toLowerCase();
    if (!Number.isInteger(index) || index < 0 || index >= MAX_BACKUP_CHUNKS) {
        throw new HttpError(400, 'Invalid backup chunk index.', 'invalid_chunk_index');
    }
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw new HttpError(400, 'A valid chunk SHA-256 is required.', 'invalid_chunk_hash');
    }
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BACKUP_CHUNK_BYTES) {
        throw new HttpError(413, 'Backup chunk is too large.', 'chunk_too_large');
    }
    const bucket = getBucket(env);
    const marker = await readUploadMarker(bucket, backupId);
    if (index >= marker.chunkCount) throw new HttpError(400, 'Chunk index exceeds chunkCount.', 'invalid_chunk_index');
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_BACKUP_CHUNK_BYTES) {
        throw new HttpError(413, 'Backup chunk is empty or too large.', 'chunk_too_large');
    }
    const chunkKey = backupChunkKey(backupId, index);
    const storedChunks = await listAll(bucket, `${backupRoot(backupId)}/chunks/`);
    const otherBytes = storedChunks.reduce(
        (sum, object) => object.key === chunkKey ? sum : sum + Number(object.size || 0),
        0
    );
    if (otherBytes + bytes.byteLength > marker.totalBytes) {
        throw new HttpError(413, 'Uploaded chunks exceed the declared backup total.', 'backup_total_exceeded');
    }
    const actualHash = await sha256Bytes(bytes);
    if (actualHash !== expectedHash) {
        throw new HttpError(409, 'Backup chunk SHA-256 verification failed.', 'chunk_hash_mismatch');
    }
    await bucket.put(chunkKey, bytes, {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { sha256: actualHash, index: String(index), size: String(bytes.byteLength) }
    });
    return json({ ok: true, backupId, index, size: bytes.byteLength, sha256: actualHash });
}

async function handleBackupCommit(request, env) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    await requireAdminSession(request, env);
    const body = await readJson(request);
    const originHash = await originHashForRequest(request);
    const backupId = validateBackupId(body.backupId, originHash);
    const bucket = getBucket(env);
    const marker = await readUploadMarker(bucket, backupId);
    const suppliedManifest = body.manifest && typeof body.manifest === 'object' && !Array.isArray(body.manifest)
        ? body.manifest
        : body;
    const chunks = normalizeChunkManifest(suppliedManifest.chunks, marker);
    await validateStoredBackupChunks(bucket, backupId, chunks);

    const checksum = String(suppliedManifest.sha256 || suppliedManifest.checksum || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
        throw new HttpError(400, 'Backup manifest SHA-256 is invalid.', 'invalid_manifest_hash');
    }
    const metadata = suppliedManifest.metadata == null ? null : suppliedManifest.metadata;
    if (metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
        throw new HttpError(400, 'manifest.metadata must be an object.', 'invalid_manifest_metadata');
    }
    if (metadata !== null && JSON.stringify(metadata).length > 32768) {
        throw new HttpError(400, 'manifest.metadata is too large.', 'invalid_manifest_metadata');
    }
    const manifest = {
        version: 1,
        backupId,
        siteName: marker.siteName,
        originHash: marker.originHash,
        timestamp: marker.timestamp,
        createdAt: marker.createdAt,
        committedAt: new Date().toISOString(),
        format: typeof suppliedManifest.format === 'string' ? suppliedManifest.format.slice(0, 128) : '',
        schemaVersion: Number.isFinite(Number(suppliedManifest.schemaVersion)) ? Number(suppliedManifest.schemaVersion) : null,
        recordCount: Number.isFinite(Number(suppliedManifest.recordCount)) ? Number(suppliedManifest.recordCount) : null,
        totalBytes: marker.totalBytes,
        chunkCount: marker.chunkCount,
        sha256: checksum || null,
        metadata,
        chunks
    };
    await bucket.put(`${backupRoot(backupId)}/manifest.json`, JSON.stringify(manifest), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
    await bucket.delete(`${backupRoot(backupId)}/_upload.json`);
    const settings = await loadSettings(bucket);
    const cleanedBackups = await cleanupBackupRetention(bucket, backupId.split('/')[0], settings.backupRetention);
    return json({ ok: true, backupId, manifest, cleanedBackups });
}

async function handleBackupList(request, env, url) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    await requireAdminSession(request, env);
    const site = await buildSiteInfo(request, url.searchParams.get('siteName'));
    const bucket = getBucket(env);
    const objects = await listAll(bucket, `${BACKUP_PREFIX}/${site.siteDir}/`);
    const manifests = [];
    for (const object of objects.filter((item) => item.key.endsWith('/manifest.json'))) {
        const manifestObject = await bucket.get(object.key);
        if (!manifestObject) continue;
        try {
            const manifest = JSON.parse(await manifestObject.text());
            manifests.push({
                backupId: manifest.backupId,
                timestamp: manifest.timestamp,
                committedAt: manifest.committedAt,
                totalBytes: manifest.totalBytes,
                chunkCount: manifest.chunkCount,
                sha256: manifest.sha256,
                format: manifest.format,
                schemaVersion: manifest.schemaVersion,
                recordCount: manifest.recordCount,
                metadata: manifest.metadata
            });
        } catch (error) {
            throw new HttpError(500, 'A stored backup manifest is invalid.', 'backup_manifest_corrupt');
        }
    }
    manifests.sort((left, right) => Number(right.timestamp) - Number(left.timestamp));
    return json({ ok: true, siteDir: site.siteDir, backups: manifests });
}

async function getCommittedManifest(request, env, url) {
    await requireAdminSession(request, env);
    const originHash = await originHashForRequest(request);
    const backupId = validateBackupId(url.searchParams.get('backupId'), originHash);
    const object = await getBucket(env).get(`${backupRoot(backupId)}/manifest.json`);
    if (!object) throw new HttpError(404, 'Backup manifest not found.', 'backup_not_found');
    let manifest;
    try {
        manifest = JSON.parse(await object.text());
    } catch (error) {
        throw new HttpError(500, 'Backup manifest is invalid.', 'backup_manifest_corrupt');
    }
    return { backupId, manifest };
}

async function handleBackupManifest(request, env, url) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const { manifest } = await getCommittedManifest(request, env, url);
    return json({ ok: true, manifest });
}

async function handleBackupChunkRead(request, env, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const { backupId, manifest } = await getCommittedManifest(request, env, url);
    const index = Number(url.searchParams.get('index'));
    const chunk = Array.isArray(manifest.chunks) ? manifest.chunks.find((item) => item.index === index) : null;
    if (!chunk) throw new HttpError(404, 'Backup chunk is not in the manifest.', 'backup_chunk_not_found');
    const object = await getBucket(env).get(backupChunkKey(backupId, index));
    if (!object) throw new HttpError(404, 'Backup chunk not found.', 'backup_chunk_not_found');
    return new Response(request.method === 'HEAD' ? null : object.body, {
        headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(object.size || 0),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'x-rp-chunk-sha256': chunk.sha256,
            'x-rp-chunk-index': String(index)
        }
    });
}

async function handleBackupDelete(request, env, url) {
    if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
    await requireAdminSession(request, env);
    const body = request.headers.get('content-type')?.includes('application/json')
        ? await readJson(request)
        : {};
    const originHash = await originHashForRequest(request);
    const backupId = validateBackupId(body.backupId || url.searchParams.get('backupId'), originHash);
    const bucket = getBucket(env);
    const objects = await listAll(bucket, `${backupRoot(backupId)}/`);
    await deleteKeys(bucket, objects.map((object) => object.key));
    return json({ ok: true, backupId, deletedObjects: objects.length });
}

async function handleApi(request, env, ctx) {
    assertSameOrigin(request);
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: { allow: 'GET, HEAD, POST, PUT, DELETE, OPTIONS', 'cache-control': 'no-store' }
        });
    }

    const authResponse = await handleAuth(request, env, url);
    if (authResponse) return authResponse;

    if (url.pathname === `${API_PREFIX}/render`) return handleRender(request, env, url);
    if (url.pathname === `${API_PREFIX}/generate`) return handleRender(request, env, url, { legacy: true });
    if (url.pathname === `${API_PREFIX}/webp`) return handleWebp(request, env, url);
    if (url.pathname === `${API_PREFIX}/images`) return handleImageList(request, env);
    if (url.pathname === `${API_PREFIX}/images/object`) {
        if (request.method === 'DELETE') return handleImageDelete(request, env, url);
        return handleImageRead(request, env, url);
    }
    if (url.pathname === `${API_PREFIX}/images/delete`) return handleImageDelete(request, env, url);

    if (url.pathname.startsWith(`${API_PREFIX}/settings`)) {
        const response = await handleSettings(request, env, url);
        if (response) return response;
    }

    if (url.pathname === `${API_PREFIX}/backup/start`) return handleBackupStart(request, env);
    if (url.pathname === `${API_PREFIX}/backup/chunk`) {
        if (request.method === 'PUT') return handleBackupChunkUpload(request, env, url);
        return handleBackupChunkRead(request, env, url);
    }
    if (url.pathname === `${API_PREFIX}/backup/commit`) return handleBackupCommit(request, env, ctx);
    if (url.pathname === `${API_PREFIX}/backup/list`) return handleBackupList(request, env, url);
    if (url.pathname === `${API_PREFIX}/backup/manifest`) return handleBackupManifest(request, env, url);
    if (url.pathname === `${API_PREFIX}/backup/delete`) return handleBackupDelete(request, env, url);
    throw new HttpError(404, 'API route not found.', 'not_found');
}

async function serveStatic(request, env) {
    if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
        throw new HttpError(503, 'Missing ASSETS binding.', 'assets_not_configured');
    }
    return env.ASSETS.fetch(request);
}

async function serveRpHubHtml(request, env) {
    const response = await serveStatic(request, env);
    if (request.method !== 'GET' || !response.ok) return response;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/html')) return response;
    const html = await response.text();
    const marker = '</body>';
    const script = '<script src="/rp-image/bridge.js" defer></script>';
    if (!html.includes(marker) || html.includes(script)) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('etag');
    return new Response(html.replace(marker, `${script}\n${marker}`), {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        try {
            if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
                return await handleApi(request, env, ctx);
            }
            if (url.pathname === '/generate') {
                assertSameOrigin(request);
                return await handleRender(request, env, url, { legacy: true });
            }
            if (url.pathname === '/api/api/getUser') {
                assertSameOrigin(request);
                return await handleNaiAccountProxy(request);
            }
            if (url.pathname === '/rp-image') {
                url.pathname = '/rp-image/';
                return Response.redirect(url, 308);
            }
            if (url.pathname === '/' || url.pathname === '/index.html') {
                return await serveRpHubHtml(request, env);
            }
            return await serveStatic(request, env);
        } catch (error) {
            if (error instanceof HttpError) return fail(error.status, error.message, error.code);
            console.error('[RP Image Worker] Unexpected error:', error);
            return fail(500, 'Unexpected server error.', 'internal_error');
        }
    }
};
