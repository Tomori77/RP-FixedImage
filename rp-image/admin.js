'use strict';

// Worker API routes are intentionally centralized here so backend path changes stay local.
const API = Object.freeze({
    authStatus: '/rp-image/api/auth/status',
    authLogin: '/rp-image/api/auth/login',
    authLogout: '/rp-image/api/auth/logout',
    settings: '/rp-image/api/settings',
    images: '/rp-image/api/images',
    imageFile: '/rp-image/api/images/object',
    imageDelete: '/rp-image/api/images/delete',
    backupList: '/rp-image/api/backup/list',
    backupCreate: '/rp-image/api/backup/start',
    backupCommit: '/rp-image/api/backup/commit',
    backupChunk: '/rp-image/api/backup/chunk',
    backupManifest: '/rp-image/api/backup/manifest',
    backupDelete: '/rp-image/api/backup/delete'
});

const CONFIG = Object.freeze({
    snapshotFormat: 'rp-image-browser-backup-jsonl-v1',
    snapshotSchemaVersion: 1,
    chunkSize: 8 * 1024 * 1024,
    maxSnapshotBytes: 1024 * 1024 * 1024,
    readBatchSize: 8,
    restoreBatchSize: 20,
    stagingDb: 'RPImageBackupStaging',
    stagingStore: 'chunks',
    hostChannel: 'rp-fixed-image-backup',
    hostTimeoutMs: 4000,
    databases: [
        { name: 'RPHubDB', stores: ['store'], optional: false },
        { name: 'AICharGen', stores: ['characters'], optional: false },
        { name: 'SillyTavernDB', stores: ['store'], optional: true }
    ],
    localStoragePrefixes: ['rp_hub_', 'ai_chargen_', 'silly_tavern_'],
    excludedLocalStoragePrefixes: ['rp_image_']
});

const state = {
    authenticated: false,
    activeTab: 'images',
    images: [],
    backups: [],
    settings: null,
    siteId: '',
    busy: false
};

const dom = {};

document.addEventListener('DOMContentLoaded', () => {
    cacheDom();
    bindEvents();
    initialize().catch((error) => {
        showLogin(error.message || '管理端初始化失败。');
    });
});

function cacheDom() {
    const ids = [
        'loginView', 'loginForm', 'passwordInput', 'loginButton', 'loginError', 'appView', 'logoutButton',
        'connectionBadge', 'refreshImagesButton', 'imageSearchInput', 'imageSummary', 'imageGroups',
        'refreshBackupsButton', 'siteLinkInput', 'siteIdValue', 'createBackupButton', 'backupProgress',
        'backupProgressText', 'backupProgressValue', 'backupProgressBar', 'backupCountBadge', 'backupList',
        'settingsForm',
        'webpQualityInput', 'webpQualityValue', 'backupRetentionInput', 'settingsMessage', 'saveSettingsButton',
        'previewDialog', 'previewTitle', 'previewImage', 'previewMeta', 'closePreviewButton', 'toastRegion'
    ];
    for (const id of ids) dom[id] = document.getElementById(id);
    dom.tabs = Array.from(document.querySelectorAll('.tab'));
    dom.panels = Array.from(document.querySelectorAll('.tab-panel'));
}

function bindEvents() {
    dom.loginForm.addEventListener('submit', handleLogin);
    dom.logoutButton.addEventListener('click', handleLogout);
    dom.tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
    dom.refreshImagesButton.addEventListener('click', () => loadImages(true).catch(() => {}));
    dom.imageSearchInput.addEventListener('input', renderImages);
    dom.refreshBackupsButton.addEventListener('click', () => loadBackups(true).catch(() => {}));
    dom.siteLinkInput.addEventListener('change', validateSiteLinkField);
    dom.createBackupButton.addEventListener('click', createBrowserBackup);
    dom.settingsForm.addEventListener('submit', saveSettings);
    dom.webpQualityInput.addEventListener('input', () => {
        dom.webpQualityValue.value = dom.webpQualityInput.value;
        dom.webpQualityValue.textContent = dom.webpQualityInput.value;
    });
    dom.closePreviewButton.addEventListener('click', () => dom.previewDialog.close());
    dom.previewDialog.addEventListener('click', (event) => {
        if (event.target === dom.previewDialog) dom.previewDialog.close();
    });
}

async function initialize() {
    dom.siteLinkInput.value = location.origin;
    state.siteId = await createSiteId(location.origin);
    dom.siteIdValue.textContent = state.siteId;

    try {
        const auth = await apiJson(API.authStatus, { method: 'GET', allowUnauthorized: true });
        if (auth.authenticated || auth.authorized || auth.authRequired === false) {
            showApp();
            await Promise.allSettled([loadImages(), loadBackups(), loadSettings()]);
            return;
        }
    } catch (error) {
        if (error.status && error.status !== 401) showToast(error.message, 'error');
    }
    showLogin();
}

async function handleLogin(event) {
    event.preventDefault();
    const password = dom.passwordInput.value;
    if (!password) return;
    setButtonBusy(dom.loginButton, true, '正在登录...');
    dom.loginError.textContent = '';
    try {
        const result = await apiJson(API.authLogin, {
            method: 'POST',
            body: { password },
            allowUnauthorized: true
        });
        if (result.authenticated === false || result.authorized === false) throw new Error('管理密码不正确。');
        dom.passwordInput.value = '';
        showApp();
        await Promise.allSettled([loadImages(), loadBackups(), loadSettings()]);
    } catch (error) {
        dom.loginError.textContent = error.status === 401 ? '管理密码不正确。' : error.message;
        dom.passwordInput.select();
    } finally {
        setButtonBusy(dom.loginButton, false);
    }
}

async function handleLogout() {
    try {
        await apiJson(API.authLogout, { method: 'POST' });
    } catch (error) {
        if (error.status !== 404 && error.status !== 405) showToast(error.message, 'error');
    } finally {
        state.authenticated = false;
        showLogin();
    }
}

function showLogin(message = '') {
    state.authenticated = false;
    dom.appView.hidden = true;
    dom.loginView.hidden = false;
    dom.loginError.textContent = message;
    setTimeout(() => dom.passwordInput.focus(), 0);
}

function showApp() {
    state.authenticated = true;
    dom.loginView.hidden = true;
    dom.appView.hidden = false;
    dom.connectionBadge.textContent = '已连接';
}

function activateTab(name) {
    state.activeTab = name;
    dom.tabs.forEach((tab) => {
        const active = tab.dataset.tab === name;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
    });
    dom.panels.forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${name}`));
    if (name === 'images' && state.images.length === 0) loadImages().catch(() => {});
    if (name === 'backups' && state.backups.length === 0) loadBackups().catch(() => {});
    if (name === 'settings' && !state.settings) loadSettings().catch(() => {});
}

async function apiJson(path, options = {}) {
    const headers = new Headers(options.headers || {});
    let body = options.body;
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(body);
    }
    const response = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        const error = Object.assign(new Error(data.error || data.message || `请求失败（HTTP ${response.status}）`), {
            status: response.status,
            data
        });
        if (response.status === 401 && !options.allowUnauthorized) showLogin('登录已失效，请重新输入管理密码。');
        throw error;
    }
    return data;
}

async function apiBytes(path) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) showLogin('登录已失效，请重新输入管理密码。');
        throw Object.assign(new Error(data.error || `下载失败（HTTP ${response.status}）`), { status: response.status });
    }
    return new Uint8Array(await response.arrayBuffer());
}

async function loadSettings(showSuccess = false) {
    try {
        const data = await apiJson(API.settings);
        const settings = data.settings || data;
        state.settings = settings;
        const rawQuality = Number(settings.webpQuality ?? settings.webp_quality ?? 0.82);
        const quality = clampInteger(rawQuality <= 1 ? rawQuality * 100 : rawQuality, 1, 100);
        dom.webpQualityInput.value = String(quality);
        dom.webpQualityValue.value = String(quality);
        dom.webpQualityValue.textContent = String(quality);
        dom.backupRetentionInput.value = String(clampInteger(settings.backupRetention ?? settings.backup_retention ?? settings.retention ?? 5, 1, 30));
        if (showSuccess) showToast('设置已刷新。', 'success');
    } catch (error) {
        showToast(`读取设置失败：${error.message}`, 'error');
        throw error;
    }
}

async function saveSettings(event) {
    event.preventDefault();
    const retention = clampInteger(dom.backupRetentionInput.value, 1, 30);
    const payload = {
        webpQuality: clampInteger(dom.webpQualityInput.value, 1, 100) / 100,
        backupRetention: Math.min(30, retention)
    };
    setButtonBusy(dom.saveSettingsButton, true, '保存中...');
    setFormMessage(dom.settingsMessage, '正在保存设置...', '');
    try {
        const result = await apiJson(API.settings, { method: 'PUT', body: payload });
        const settings = result.settings || result;
        state.settings = { ...(state.settings || {}), ...settings };
        setFormMessage(dom.settingsMessage, '设置已保存。', 'success');
        showToast('设置已保存。', 'success');
    } catch (error) {
        setFormMessage(dom.settingsMessage, error.message, 'error');
    } finally {
        setButtonBusy(dom.saveSettingsButton, false);
    }
}

async function loadImages(showSuccess = false) {
    dom.imageGroups.replaceChildren(createStateNode('正在读取图片...', 'loading-state'));
    setButtonBusy(dom.refreshImagesButton, true, '刷新中...');
    try {
        const data = await apiJson(API.images);
        state.images = normalizeImages(data);
        renderImages();
        if (showSuccess) showToast('图片列表已刷新。', 'success');
    } catch (error) {
        dom.imageGroups.replaceChildren(createStateNode(`读取图片失败：${error.message}`, 'empty-state'));
        throw error;
    } finally {
        setButtonBusy(dom.refreshImagesButton, false);
    }
}

function normalizeImages(data) {
    const rows = [];
    const groups = data.groups || data.characters;
    if (Array.isArray(groups)) {
        for (const group of groups) {
            const images = Array.isArray(group.images) ? group.images : [];
            for (const image of images) {
                rows.push(normalizeImage(image, group.name || group.characterName, group.uuid || group.characterUuid, group.characterDir));
            }
        }
    } else {
        const images = Array.isArray(data.images) ? data.images : Array.isArray(data.items) ? data.items : [];
        for (const image of images) rows.push(normalizeImage(image));
    }
    return rows.filter((image) => image.id || image.key || image.originalUrl || image.webpUrl);
}

function normalizeImage(image, fallbackName = '', fallbackUuid = '', fallbackDir = '') {
    const original = image.original || {};
    const webp = image.webp || image.thumbnail || {};
    const id = String(image.id || image.imageId || image.hash || image.key || image.checksum || original.key || webp.key || '');
    const originalSize = numberOrZero(image.originalSize ?? image.originalBytes ?? original.size ?? original.bytes ?? image.size);
    const webpSize = numberOrZero(image.webpSize ?? image.webpBytes ?? webp.size ?? webp.bytes ?? image.thumbSize);
    return {
        raw: image,
        id,
        key: String(image.key || original.key || webp.key || id),
        hash: String(image.hash || id),
        characterDir: String(image.characterDir || image.character_dir || fallbackDir || ''),
        characterName: String(image.characterName || image.roleName || fallbackName || '未命名角色'),
        characterUuid: String(image.characterUuid || image.roleUuid || image.uuid || fallbackUuid || '无 UUID'),
        originalSize,
        webpSize,
        originalExists: image.hasOriginal !== false && Boolean(originalSize || original.url || original.key || image.originalUrl || image.url || image.key),
        webpExists: Boolean(image.hasWebp ?? image.hasThumb ?? Boolean(webpSize || webp.url || image.webpUrl || image.thumbUrl)),
        originalUrl: sameOriginUrl(image.originalUrl || original.url || image.url),
        webpUrl: sameOriginUrl(image.webpUrl || webp.url || image.thumbUrl || image.thumbnailUrl),
        uploadedAt: image.uploadedAt || image.uploaded || image.createdAt || webp.uploaded || original.uploaded || ''
    };
}

function renderImages() {
    const query = dom.imageSearchInput.value.trim().toLocaleLowerCase('zh-CN');
    const filtered = state.images.filter((image) => {
        if (!query) return true;
        return `${image.characterName} ${image.characterUuid} ${image.id} ${image.key}`.toLocaleLowerCase('zh-CN').includes(query);
    });
    const groups = new Map();
    for (const image of filtered) {
        const groupKey = `${image.characterName}\u0000${image.characterUuid}`;
        if (!groups.has(groupKey)) groups.set(groupKey, { name: image.characterName, uuid: image.characterUuid, images: [] });
        groups.get(groupKey).images.push(image);
    }
    dom.imageGroups.replaceChildren();
    if (filtered.length === 0) {
        dom.imageGroups.append(createStateNode(state.images.length ? '没有符合搜索条件的图片。' : '远端当前没有图片。', 'empty-state'));
    } else {
        const sortedGroups = Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
        for (const group of sortedGroups) dom.imageGroups.append(createImageGroup(group));
    }
    const originalBytes = filtered.reduce((sum, image) => sum + image.originalSize, 0);
    const webpBytes = filtered.reduce((sum, image) => sum + image.webpSize, 0);
    dom.imageSummary.textContent = `${groups.size} 个角色分组 · ${filtered.length} 张 · 原图 ${formatBytes(originalBytes)} · WebP ${formatBytes(webpBytes)}`;
}

function createImageGroup(group) {
    const article = element('section', 'card image-group');
    const header = element('div', 'image-group-header');
    const title = element('div', 'image-group-title');
    title.append(element('h3', '', group.name), element('code', '', group.uuid));
    const totalOriginal = group.images.reduce((sum, image) => sum + image.originalSize, 0);
    const totalWebp = group.images.reduce((sum, image) => sum + image.webpSize, 0);
    header.append(title, element('div', 'image-group-stats', `${group.images.length} 张 · ${formatBytes(totalOriginal + totalWebp)}`));
    const grid = element('div', 'image-grid');
    group.images.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))).forEach((image) => grid.append(createImageCard(image)));
    article.append(header, grid);
    return article;
}

function createImageCard(image) {
    const card = element('article', 'image-card');
    const previewButton = element('button', 'image-preview-button');
    previewButton.type = 'button';
    const previewUrl = getImageUrl(image, image.webpExists ? 'webp' : 'original');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = `${image.characterName} 图片`;
    img.src = previewUrl;
    previewButton.append(img, element('span', 'image-kind', image.webpExists ? 'WebP 预览' : '原图预览'));
    previewButton.addEventListener('click', () => openImagePreview(image));

    const body = element('div', 'image-body');
    const id = element('div', 'image-id', image.id || image.key);
    id.title = image.id || image.key;
    const ratio = image.originalSize > 0 && image.webpSize > 0
        ? `${Math.max(0, (1 - image.webpSize / image.originalSize) * 100).toFixed(1)}%`
        : '--';
    const sizes = element('div', 'size-grid');
    sizes.append(
        createSizeCell('原图', image.originalExists ? formatBytes(image.originalSize) : '无'),
        createSizeCell('WebP', image.webpExists ? formatBytes(image.webpSize) : '无'),
        createSizeCell('压缩率', ratio)
    );
    const actions = element('div', 'image-actions');
    actions.append(
        createDownloadButton('下载原图', image, 'original', !image.originalExists),
        createDownloadButton('下载 WebP', image, 'webp', !image.webpExists),
        createDeleteButton('删原图', image, 'original', !image.originalExists),
        createDeleteButton('删 WebP', image, 'webp', !image.webpExists),
        createDeleteButton('删除全部', image, 'all', false, true)
    );
    body.append(id, sizes, actions);
    card.append(previewButton, body);
    return card;
}

function createSizeCell(label, value) {
    const cell = element('div', 'size-cell');
    cell.append(element('span', '', label), element('strong', '', value));
    return cell;
}

function createDeleteButton(label, image, target, disabled, dangerous = false) {
    const button = element('button', `button ${dangerous ? 'danger' : 'secondary'}`, label);
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', async () => {
        const targetLabel = target === 'all' ? '原图和 WebP' : target === 'webp' ? 'WebP' : '原图';
        if (!window.confirm(`确定删除“${image.characterName}”的${targetLabel}？`)) return;
        setButtonBusy(button, true, '删除中');
        try {
            await apiJson(API.imageDelete, {
                method: 'DELETE',
                body: {
                    characterDir: image.characterDir,
                    hash: image.hash,
                    copy: target
                }
            });
            showToast(`${targetLabel}已删除。`, 'success');
            await loadImages();
        } catch (error) {
            showToast(error.message, 'error');
            setButtonBusy(button, false);
        }
    });
    return button;
}

function createDownloadButton(label, image, kind, disabled) {
    const link = element('a', 'button secondary', label);
    link.href = disabled ? '#' : getImageUrl(image, kind);
    link.download = `${image.characterName}-${image.hash}.${kind === 'webp' ? 'webp' : 'image'}`;
    link.setAttribute('role', 'button');
    if (disabled) {
        link.setAttribute('aria-disabled', 'true');
        link.addEventListener('click', (event) => event.preventDefault());
    }
    return link;
}

function getImageUrl(image, kind) {
    const direct = kind === 'webp' ? image.webpUrl : image.originalUrl;
    if (direct) return direct;
    const params = new URLSearchParams({
        characterDir: image.characterDir,
        hash: image.hash,
        copy: kind === 'webp' ? 'webp' : 'original'
    });
    return `${API.imageFile}?${params.toString()}`;
}

function openImagePreview(image) {
    const kind = image.webpExists ? 'webp' : 'original';
    dom.previewTitle.textContent = `${image.characterName} · ${kind === 'webp' ? 'WebP' : '原图'}`;
    dom.previewImage.src = getImageUrl(image, kind);
    dom.previewImage.alt = `${image.characterName} 图片预览`;
    dom.previewMeta.textContent = `${image.characterUuid} · 原图 ${formatBytes(image.originalSize)} · WebP ${formatBytes(image.webpSize)}`;
    dom.previewDialog.showModal();
}

async function loadBackups(showSuccess = false) {
    dom.backupList.replaceChildren(createStateNode('正在读取远端版本...', 'loading-state'));
    setButtonBusy(dom.refreshBackupsButton, true, '刷新中...');
    try {
        const params = new URLSearchParams({ siteName: location.hostname });
        const data = await apiJson(`${API.backupList}?${params.toString()}`);
        state.backups = normalizeBackups(data);
        renderBackups();
        if (showSuccess) showToast('远端版本已刷新。', 'success');
    } catch (error) {
        dom.backupList.replaceChildren(createStateNode(`读取备份失败：${error.message}`, 'empty-state'));
        throw error;
    } finally {
        setButtonBusy(dom.refreshBackupsButton, false);
    }
}

function normalizeBackups(data) {
    const backups = Array.isArray(data.backups) ? data.backups : Array.isArray(data.versions) ? data.versions : Array.isArray(data.items) ? data.items : [];
    return backups.map((item) => ({
        ...item,
        id: String(item.id || item.backupId || item.version || item.key || ''),
        createdAt: item.createdAt || item.updatedAt || item.timestamp || item.uploadedAt || '',
        totalBytes: numberOrZero(item.totalBytes ?? item.size ?? item.bytes),
        chunkCount: numberOrZero(item.chunkCount ?? item.parts),
        recordCount: numberOrZero(item.recordCount ?? item.records)
    })).filter((item) => item.id).sort((a, b) => timestampOf(b.createdAt) - timestampOf(a.createdAt));
}

function renderBackups() {
    dom.backupList.replaceChildren();
    dom.backupCountBadge.textContent = `${state.backups.length} 个版本`;
    if (state.backups.length === 0) {
        dom.backupList.append(createStateNode('当前站点还没有远端备份。', 'empty-state'));
        return;
    }
    for (const backup of state.backups) {
        const item = element('article', 'backup-item');
        const info = element('div');
        const versionLabel = backup.label || backup.name || `版本 ${backup.version || backup.id}`;
        info.append(element('h4', '', versionLabel));
        const meta = element('div', 'backup-item-meta');
        meta.append(
            element('span', '', formatDate(backup.createdAt)),
            element('span', '', formatBytes(backup.totalBytes)),
            element('span', '', `${backup.chunkCount || '?'} 个分片`),
            element('span', '', `${backup.recordCount || '?'} 条记录`)
        );
        info.append(meta);
        const actions = element('div', 'backup-item-actions');
        const restore = element('button', 'button primary', '恢复');
        restore.type = 'button';
        restore.addEventListener('click', () => restoreBackup(backup, restore));
        const remove = element('button', 'button danger', '删除');
        remove.type = 'button';
        remove.addEventListener('click', () => deleteBackup(backup, remove));
        actions.append(restore, remove);
        item.append(info, actions);
        dom.backupList.append(item);
    }
}

async function deleteBackup(backup, button) {
    if (!window.confirm(`确定删除远端备份“${backup.label || backup.id}”？此操作不可撤销。`)) return;
    setButtonBusy(button, true, '删除中');
    try {
        await apiJson(API.backupDelete, { method: 'DELETE', body: { backupId: backup.id } });
        showToast('远端备份已删除。', 'success');
        await loadBackups();
    } catch (error) {
        showToast(error.message, 'error');
        setButtonBusy(button, false);
    }
}

async function createBrowserBackup() {
    if (state.busy) return;
    let siteOrigin;
    try {
        siteOrigin = validateSiteLink(dom.siteLinkInput.value);
    } catch (error) {
        showToast(error.message, 'error');
        dom.siteLinkInput.focus();
        return;
    }

    state.busy = true;
    setButtonBusy(dom.createBackupButton, true, '正在备份...');
    updateBackupProgress(1, '正在读取浏览器数据...');
    let backupId = '';
    let stagingDb = null;
    let host = null;
    try {
        const stats = { recordCount: 0, totalBytes: 0 };
        const chunks = [];
        host = await requestHostFlushAndPause();
        if (!host.responded) {
            const proceed = window.confirm('当前 RP-Hub 未提供备份暂停接口。请先关闭其他 RP-Hub 标签页，避免备份过程中数据继续变化；确认已关闭后点击“确定”继续。');
            if (!proceed) throw new Error('已取消备份。');
        }
        stagingDb = await openStagingDb();
        await clearStaging(stagingDb);
        for await (const chunk of iterateSnapshotChunks(stats, siteOrigin)) {
            await writeStagingChunk(stagingDb, chunk.index, chunk.bytes);
            chunks.push({ index: chunk.index, checksum: chunk.checksum, length: chunk.length });
            updateBackupProgress(Math.min(38, 6 + chunks.length * 2), `已生成 ${chunks.length} 个分片...`);
        }
        if (chunks.length === 0) throw new Error('未生成有效备份分片。');
        const created = await apiJson(API.backupCreate, {
            method: 'POST',
            body: {
                siteName: location.hostname,
                totalBytes: stats.totalBytes,
                chunkCount: chunks.length
            }
        });
        backupId = String(created.backupId || '');
        if (!backupId) throw new Error('Worker 未返回备份 ID。');

        for (const chunk of chunks) {
            const bytes = await readStagingChunk(stagingDb, chunk.index);
            await uploadBackupChunk(backupId, { ...chunk, bytes });
            updateBackupProgress(40 + Math.round((chunk.index + 1) / chunks.length * 50), `已上传 ${chunk.index + 1}/${chunks.length} 个分片...`);
        }
        const checksum = await sha256Text(buildSnapshotChecksumSource(stats, chunks));
        updateBackupProgress(95, '全部分片已上传，正在提交版本...');
        await apiJson(API.backupCommit, {
            method: 'POST',
            body: {
                backupId,
                format: CONFIG.snapshotFormat,
                schemaVersion: CONFIG.snapshotSchemaVersion,
                recordCount: stats.recordCount,
                chunks: chunks.map((chunk) => ({ index: chunk.index, size: chunk.length, sha256: chunk.checksum })),
                checksum,
                metadata: { origin: siteOrigin, siteId: state.siteId }
            }
        });
        updateBackupProgress(100, `备份完成：${formatBytes(stats.totalBytes)}，${chunks.length} 个分片。`);
        showToast('浏览器备份已提交。', 'success');
        await loadBackups();
    } catch (error) {
        updateBackupProgress(0, `备份失败：${error.message}`);
        showToast(error.message, 'error');
    } finally {
        if (host?.resume) await host.resume().catch(() => {});
        if (stagingDb) {
            try { await clearStaging(stagingDb); } catch (_) {}
            stagingDb.close();
        }
        state.busy = false;
        setButtonBusy(dom.createBackupButton, false);
    }
}

async function uploadBackupChunk(backupId, chunk) {
    const params = new URLSearchParams({ backupId, index: String(chunk.index) });
    const response = await fetch(`${API.backupChunk}?${params.toString()}`, {
        method: 'PUT',
        headers: {
            'content-type': 'application/octet-stream',
            'x-rp-chunk-index': String(chunk.index),
            'x-rp-chunk-sha256': chunk.checksum,
            'x-rp-chunk-length': String(chunk.length)
        },
        body: chunk.bytes,
        credentials: 'same-origin',
        cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        if (response.status === 401) showLogin('登录已失效，请重新输入管理密码。');
        throw new Error(data.error || `第 ${chunk.index + 1} 个分片上传失败。`);
    }
    const serverChecksum = String(data.checksum || data.sha256 || chunk.checksum).toLowerCase();
    if (serverChecksum !== chunk.checksum) throw new Error(`第 ${chunk.index + 1} 个分片的服务端校验码不一致。`);
}

async function restoreBackup(backup, button) {
    if (state.busy) return;
    const firstConfirm = window.confirm('恢复会覆盖本机白名单内的 RP-Hub、角色生成器和兼容数据，并在完成后刷新页面。确定继续？');
    if (!firstConfirm) return;

    state.busy = true;
    setButtonBusy(button, true, '准备恢复');
    updateBackupProgress(1, '正在请求 RP-Hub 保存并暂停写入...');
    let host = null;
    let stagingDb = null;
    try {
        host = await requestHostFlushAndPause();
        if (!host.responded) {
            const fallbackConfirm = window.confirm('未收到 RP-Hub 宿主响应。请先关闭其他 RP-Hub 标签页，避免它们在恢复后把旧数据写回；确认已关闭后，再点击“确定”继续恢复。');
            if (!fallbackConfirm) throw new Error('已取消恢复。');
        }

        const manifest = await fetchBackupManifest(backup);
        const chunks = await validateRemoteManifest(manifest, backup);
        stagingDb = await openStagingDb();
        await clearStaging(stagingDb);
        for (const chunk of chunks) {
            const bytes = await downloadBackupChunk(backup.id, chunk);
            await writeStagingChunk(stagingDb, chunk.index, bytes);
            updateBackupProgress(5 + Math.round((chunk.index + 1) / chunks.length * 65), `已下载并校验 ${chunk.index + 1}/${chunks.length} 个分片...`);
        }

        updateBackupProgress(73, '分片下载完成，正在验证完整 JSONL 快照...');
        const validator = new SnapshotValidator(manifest.recordCount);
        await parseStagedSnapshot(stagingDb, chunks, (line) => validator.consume(line));
        const metadata = validator.finish();

        const confirmManifest = await fetchBackupManifest(backup);
        if (String(confirmManifest.checksum || confirmManifest.sha256 || '').toLowerCase() !== String(manifest.checksum || manifest.sha256 || '').toLowerCase()) {
            throw new Error('恢复期间远端版本发生变化，请重新操作。');
        }

        updateBackupProgress(80, '完整校验通过，正在覆盖白名单存储...');
        await applyValidatedSnapshot(stagingDb, chunks, metadata, (done, total) => {
            updateBackupProgress(80 + Math.round(done / Math.max(1, total) * 19), `正在恢复本地数据 ${done}/${total}...`);
        });
        updateBackupProgress(100, '恢复完成，页面即将刷新...');
        showToast('恢复完成，正在刷新页面。', 'success');
        if (host?.reload) host.reload();
        setTimeout(() => location.reload(), 500);
    } catch (error) {
        if (host?.resume) await host.resume().catch(() => {});
        if (error.message !== '已取消恢复。') showToast(`恢复失败：${error.message}`, 'error');
        updateBackupProgress(0, error.message);
        state.busy = false;
        setButtonBusy(button, false);
    } finally {
        if (stagingDb) {
            try { await clearStaging(stagingDb); } catch (_) {}
            stagingDb.close();
        }
    }
}

async function fetchBackupManifest(backup) {
    const data = await apiJson(`${API.backupManifest}?${new URLSearchParams({ backupId: backup.id })}`);
    const manifest = data.manifest || data.backup || data;
    return { ...backup, ...manifest, id: backup.id };
}

async function validateRemoteManifest(manifest, backup) {
    const format = manifest.format || manifest.snapshotFormat;
    if (format !== CONFIG.snapshotFormat || Number(manifest.schemaVersion) !== CONFIG.snapshotSchemaVersion) {
        throw new Error('远端备份格式或版本不受支持。');
    }
    if (manifest.siteId && manifest.siteId !== state.siteId) throw new Error('远端备份不属于当前站点 ID。');
    if (manifest.origin && new URL(manifest.origin).origin !== location.origin) throw new Error('远端备份来源与当前 origin 不一致。');
    const rawChunks = manifest.chunks || manifest.chunkManifest || manifest.parts;
    if (!Array.isArray(rawChunks) || rawChunks.length === 0) throw new Error('远端分片清单为空。');
    let totalBytes = 0;
    const chunks = rawChunks.map((chunk, index) => {
        const chunkIndex = Number(chunk.index ?? chunk.partNumber - 1);
        const checksum = String(chunk.checksum || chunk.sha256 || '').toLowerCase();
        const length = Number(chunk.length || chunk.byteLength || chunk.size || 0);
        if (chunkIndex !== index || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`远端第 ${index + 1} 个分片信息无效。`);
        if (!Number.isInteger(length) || length <= 0 || length > CONFIG.chunkSize) throw new Error(`远端第 ${index + 1} 个分片大小无效。`);
        totalBytes += length;
        return { index, checksum, length, url: sameOriginUrl(chunk.url || chunk.downloadUrl) };
    });
    if (totalBytes !== Number(manifest.totalBytes || backup.totalBytes)) throw new Error('远端分片总大小不一致。');
    const expectedChecksum = String(manifest.checksum || manifest.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedChecksum)) throw new Error('远端备份总校验码无效。');
    const source = buildSnapshotChecksumSource({ recordCount: Number(manifest.recordCount || 0), totalBytes }, chunks);
    if (await sha256Text(source) !== expectedChecksum) throw new Error('远端备份清单校验失败。');
    return chunks;
}

async function downloadBackupChunk(backupId, chunk) {
    const path = `${API.backupChunk}?${new URLSearchParams({ backupId, index: String(chunk.index) })}`;
    const bytes = await apiBytes(chunk.url || path);
    if (bytes.byteLength !== chunk.length) throw new Error(`第 ${chunk.index + 1} 个分片大小校验失败。`);
    if (await sha256Bytes(bytes) !== chunk.checksum) throw new Error(`第 ${chunk.index + 1} 个分片 SHA-256 校验失败。`);
    return bytes;
}

async function requestHostFlushAndPause() {
    const host = window.RPH_BACKUP_HOST;
    if (host) {
        if (typeof host === 'function') {
            const result = await host({ action: 'flush-pause', source: 'rp-image-admin' });
            return { responded: result !== false, resume: null };
        }
        if (typeof host.flushAndPause === 'function') {
            await host.flushAndPause();
            return { responded: true, resume: typeof host.resume === 'function' ? () => host.resume() : null };
        }
        if (typeof host.flush === 'function') await host.flush();
        if (typeof host.pause === 'function') await host.pause();
        if (typeof host.flush === 'function' || typeof host.pause === 'function') {
            return { responded: true, resume: typeof host.resume === 'function' ? () => host.resume() : null };
        }
    }
    return requestHostViaBroadcastChannel();
}

function requestHostViaBroadcastChannel() {
    return requestHostAction('flush-pause').then((responded) => ({
        responded: Boolean(responded),
        resume: () => requestHostAction('resume'),
        reload: () => postHostAction('reload')
    }));
}

function requestHostAction(action) {
    const host = window.RPH_BACKUP_HOST;
    if (host) {
        if (action === 'flush-pause') {
            return Promise.resolve()
                .then(() => typeof host.flush === 'function' ? host.flush() : undefined)
                .then(() => typeof host.pause === 'function' ? host.pause() : undefined)
                .then(() => true);
        }
        if (typeof host[action] === 'function') return Promise.resolve(host[action]()).then(() => true);
    }
    if (typeof BroadcastChannel !== 'function') return Promise.resolve(false);
    return new Promise((resolve) => {
        const channel = new BroadcastChannel(CONFIG.hostChannel);
        const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        let settled = false;
        const finish = (responded) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            channel.close();
            resolve(Boolean(responded));
        };
        channel.onmessage = (event) => {
            const message = event.data || {};
            if (message.type === 'rp-fixed-image-backup:response' && message.requestId === requestId && message.action === action) finish(message.ok !== false);
        };
        const timer = setTimeout(() => finish(false), CONFIG.hostTimeoutMs);
        channel.postMessage({ type: 'rp-fixed-image-backup:request', action, requestId, source: 'rp-image-admin' });
    });
}

function postHostAction(action) {
    const host = window.RPH_BACKUP_HOST;
    if (host && typeof host[action] === 'function') {
        void Promise.resolve(host[action]());
        return true;
    }
    if (typeof BroadcastChannel !== 'function') return false;
    const channel = new BroadcastChannel(CONFIG.hostChannel);
    channel.postMessage({
        type: 'rp-fixed-image-backup:request',
        action,
        requestId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        source: 'rp-image-admin'
    });
    setTimeout(() => channel.close(), 1000);
    return true;
}

function validateSiteLinkField() {
    try {
        validateSiteLink(dom.siteLinkInput.value);
        dom.siteLinkInput.setCustomValidity('');
    } catch (error) {
        dom.siteLinkInput.setCustomValidity(error.message);
        dom.siteLinkInput.reportValidity();
    }
}

function validateSiteLink(value) {
    let url;
    try {
        url = new URL(String(value || '').trim(), location.href);
    } catch (_) {
        throw new Error('站点链接格式无效。');
    }
    if (url.origin !== location.origin) {
        throw new Error(`当前版本只允许同源链接：必须是 ${location.origin}，不能使用 ${url.origin}。`);
    }
    return url.origin;
}

async function createSiteId(origin) {
    return `rph-${(await sha256Text(origin)).slice(0, 24)}`;
}

function isAllowedLocalStorageKey(key) {
    return typeof key === 'string'
        && !CONFIG.excludedLocalStoragePrefixes.some((prefix) => key.startsWith(prefix))
        && CONFIG.localStoragePrefixes.some((prefix) => key.startsWith(prefix));
}

function readLocalStorageEntries() {
    const entries = [];
    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (isAllowedLocalStorageKey(key)) entries.push({ key, value: localStorage.getItem(key) });
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function listExistingDatabaseNames() {
    if (typeof indexedDB.databases === 'function') {
        try {
            const databases = await indexedDB.databases();
            return new Set((databases || []).map((item) => item?.name).filter(Boolean));
        } catch (_) {}
    }
    const existing = new Set();
    for (const definition of CONFIG.databases) {
        if (await databaseExistsWithoutCreating(definition.name)) existing.add(definition.name);
    }
    return existing;
}

function databaseExistsWithoutCreating(name) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        let created = false;
        request.onupgradeneeded = () => {
            created = true;
            request.transaction.abort();
        };
        request.onerror = () => {
            if (created && request.error?.name === 'AbortError') resolve(false);
            else reject(request.error || new Error(`无法检查 IndexedDB：${name}`));
        };
        request.onsuccess = () => {
            request.result.close();
            resolve(true);
        };
    });
}

function openDatabase(name, version) {
    return new Promise((resolve, reject) => {
        const request = version ? indexedDB.open(name, version) : indexedDB.open(name);
        request.onerror = () => reject(request.error || new Error(`无法打开 IndexedDB：${name}`));
        request.onsuccess = () => resolve(request.result);
    });
}

function readStoreDefinitions(db, names) {
    return names.map((name) => {
        const store = db.transaction(name, 'readonly').objectStore(name);
        return { name, keyPath: store.keyPath, autoIncrement: Boolean(store.autoIncrement) };
    });
}

function readRecordBatch(db, storeName, afterKey, hasAfterKey) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const range = hasAfterKey ? IDBKeyRange.lowerBound(afterKey, true) : null;
        const records = [];
        const request = store.openCursor(range);
        request.onerror = () => reject(request.error || new Error(`读取 ${db.name}/${storeName} 失败。`));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return resolve({ records, done: true, lastKey: afterKey });
            records.push({ key: cursor.key, value: cursor.value });
            if (records.length >= CONFIG.readBatchSize) return resolve({ records, done: false, lastKey: cursor.key });
            cursor.continue();
        };
    });
}

async function* iterateStoreRecords(db, storeName) {
    let afterKey;
    let hasAfterKey = false;
    while (true) {
        const batch = await readRecordBatch(db, storeName, afterKey, hasAfterKey);
        for (const record of batch.records) yield record;
        if (batch.done) return;
        afterKey = batch.lastKey;
        hasAfterKey = true;
        await nextTask();
    }
}

async function* iterateSnapshotLines(stats, origin) {
    yield jsonLine({
        type: 'snapshot',
        format: CONFIG.snapshotFormat,
        schemaVersion: CONFIG.snapshotSchemaVersion,
        siteId: state.siteId,
        origin,
        createdAt: new Date().toISOString()
    });

    for (const entry of readLocalStorageEntries()) {
        stats.recordCount += 1;
        yield jsonLine({ type: 'localStorage', key: entry.key, value: entry.value });
    }
    yield jsonLine({ type: 'localStorageEnd' });

    const databaseNames = await listExistingDatabaseNames();
    for (const definition of CONFIG.databases) {
        if (!databaseNames.has(definition.name)) continue;
        const db = await openDatabase(definition.name);
        try {
            const storeNames = definition.stores.filter((name) => db.objectStoreNames.contains(name));
            if (storeNames.length === 0) continue;
            const stores = readStoreDefinitions(db, storeNames);
            yield jsonLine({ type: 'database', name: definition.name, version: db.version, stores });
            for (const store of stores) {
                for await (const record of iterateStoreRecords(db, store.name)) {
                    stats.recordCount += 1;
                    const key = await encodeJsonValue(record.key);
                    if (Array.isArray(record.value)) {
                        yield jsonLine({ type: 'recordArrayStart', database: definition.name, store: store.name, key, length: record.value.length });
                        for (let index = 0; index < record.value.length; index += 1) {
                            const value = Object.prototype.hasOwnProperty.call(record.value, index) ? record.value[index] : undefined;
                            yield jsonLine({ type: 'recordArrayItem', database: definition.name, store: store.name, index, value: await encodeJsonValue(value) });
                        }
                        yield jsonLine({ type: 'recordArrayEnd', database: definition.name, store: store.name });
                    } else {
                        yield jsonLine({
                            type: 'record',
                            database: definition.name,
                            store: store.name,
                            key,
                            value: await encodeJsonValue(record.value)
                        });
                    }
                }
                yield jsonLine({ type: 'storeEnd', database: definition.name, store: store.name });
            }
            yield jsonLine({ type: 'databaseEnd', name: definition.name });
        } finally {
            db.close();
        }
    }
    yield jsonLine({ type: 'snapshotEnd', recordCount: stats.recordCount });
}

class SnapshotChunkWriter {
    constructor() {
        this.encoder = new TextEncoder();
        this.buffer = new Uint8Array(CONFIG.chunkSize);
        this.offset = 0;
        this.totalBytes = 0;
    }

    append(text) {
        const completed = [];
        for (let start = 0; start < text.length;) {
            let end = Math.min(text.length, start + 256 * 1024);
            if (end < text.length && isSurrogatePair(text.charCodeAt(end - 1), text.charCodeAt(end))) end -= 1;
            const bytes = this.encoder.encode(text.slice(start, end));
            this.totalBytes += bytes.byteLength;
            if (this.totalBytes > CONFIG.maxSnapshotBytes) throw new Error(`备份超过 ${formatBytes(CONFIG.maxSnapshotBytes)} 上限。`);
            let byteOffset = 0;
            while (byteOffset < bytes.byteLength) {
                const writable = Math.min(CONFIG.chunkSize - this.offset, bytes.byteLength - byteOffset);
                this.buffer.set(bytes.subarray(byteOffset, byteOffset + writable), this.offset);
                this.offset += writable;
                byteOffset += writable;
                if (this.offset === CONFIG.chunkSize) {
                    completed.push(this.buffer);
                    this.buffer = new Uint8Array(CONFIG.chunkSize);
                    this.offset = 0;
                }
            }
            start = end;
        }
        return completed;
    }

    finish() {
        if (this.offset === 0) return null;
        const bytes = this.buffer.slice(0, this.offset);
        this.buffer = new Uint8Array(CONFIG.chunkSize);
        this.offset = 0;
        return bytes;
    }
}

async function* iterateSnapshotChunks(stats, origin) {
    const writer = new SnapshotChunkWriter();
    let index = 0;
    for await (const line of iterateSnapshotLines(stats, origin)) {
        for (const bytes of writer.append(line)) {
            yield { index, bytes, length: bytes.byteLength, checksum: await sha256Bytes(bytes) };
            index += 1;
            await nextTask();
        }
    }
    const final = writer.finish();
    if (final) yield { index, bytes: final, length: final.byteLength, checksum: await sha256Bytes(final) };
    stats.totalBytes = writer.totalBytes;
}

function buildSnapshotChecksumSource(stats, chunks) {
    return JSON.stringify([
        CONFIG.snapshotFormat,
        CONFIG.snapshotSchemaVersion,
        Number(stats.recordCount || 0),
        Number(stats.totalBytes || 0),
        chunks.map((chunk) => [String(chunk.checksum).toLowerCase(), Number(chunk.length)])
    ]);
}

function openStagingDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.stagingDb, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(CONFIG.stagingStore)) request.result.createObjectStore(CONFIG.stagingStore);
        };
        request.onerror = () => reject(request.error || new Error('无法打开恢复临时数据库。'));
        request.onsuccess = () => resolve(request.result);
    });
}

function clearStaging(db) {
    return transactionPromise(db, CONFIG.stagingStore, 'readwrite', (store) => store.clear());
}

function writeStagingChunk(db, index, bytes) {
    return transactionPromise(db, CONFIG.stagingStore, 'readwrite', (store) => store.put(bytes, index));
}

function readStagingChunk(db, index) {
    return new Promise((resolve, reject) => {
        const request = db.transaction(CONFIG.stagingStore, 'readonly').objectStore(CONFIG.stagingStore).get(index);
        request.onerror = () => reject(request.error || new Error('读取恢复临时分片失败。'));
        request.onsuccess = () => {
            const value = request.result;
            if (value instanceof Uint8Array) resolve(value);
            else if (value instanceof ArrayBuffer) resolve(new Uint8Array(value));
            else reject(new Error(`恢复临时分片 ${index + 1} 不存在。`));
        };
    });
}

async function parseStagedSnapshot(db, chunks, onLine) {
    const decoder = new TextDecoder();
    const reader = new SnapshotLineReader(onLine);
    for (const chunk of chunks) {
        const bytes = await readStagingChunk(db, chunk.index);
        if (bytes.byteLength !== chunk.length || await sha256Bytes(bytes) !== chunk.checksum) {
            throw new Error(`恢复临时分片 ${chunk.index + 1} 二次校验失败。`);
        }
        await reader.push(decoder.decode(bytes, { stream: true }));
    }
    await reader.push(decoder.decode());
    await reader.finish();
}

class SnapshotLineReader {
    constructor(onLine) {
        this.onLine = onLine;
        this.pending = [];
    }

    async push(text) {
        let start = 0;
        while (true) {
            const end = text.indexOf('\n', start);
            if (end < 0) break;
            this.pending.push(text.slice(start, end));
            const line = this.pending.join('');
            this.pending = [];
            if (line) await this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
            start = end + 1;
        }
        if (start < text.length) this.pending.push(text.slice(start));
    }

    async finish() {
        if (this.pending.length === 0) return;
        const line = this.pending.join('');
        this.pending = [];
        if (line) await this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
}

class SnapshotValidator {
    constructor(expectedRecordCount) {
        this.expectedRecordCount = Number(expectedRecordCount || 0);
        this.recordCount = 0;
        this.started = false;
        this.ended = false;
        this.localStorageEnded = false;
        this.localStorageKeys = new Set();
        this.databases = new Map();
        this.currentDatabase = null;
        this.currentStore = null;
        this.arrayRecord = null;
    }

    consume(text) {
        let line;
        try { line = JSON.parse(text); } catch (_) { throw new Error('备份 JSONL 包含无效 JSON。'); }
        if (this.ended) throw new Error('备份结束标记后仍有数据。');
        switch (line?.type) {
            case 'snapshot': return this.start(line);
            case 'localStorage': return this.localStorage(line);
            case 'localStorageEnd': return this.endLocalStorage();
            case 'database': return this.startDatabase(line);
            case 'record': return this.record(line);
            case 'recordArrayStart': return this.startArray(line);
            case 'recordArrayItem': return this.arrayItem(line);
            case 'recordArrayEnd': return this.endArray(line);
            case 'storeEnd': return this.endStore(line);
            case 'databaseEnd': return this.endDatabase(line);
            case 'snapshotEnd': return this.end(line);
            default: throw new Error('备份包含未知 JSONL 记录。');
        }
    }

    start(line) {
        if (this.started || line.format !== CONFIG.snapshotFormat || Number(line.schemaVersion) !== CONFIG.snapshotSchemaVersion) throw new Error('备份头信息无效。');
        if (line.siteId !== state.siteId || new URL(line.origin).origin !== location.origin) throw new Error('备份站点与当前 origin 不一致。');
        this.started = true;
    }

    localStorage(line) {
        if (!this.started || this.localStorageEnded || this.currentDatabase || !isAllowedLocalStorageKey(line.key)) throw new Error('备份 localStorage 记录无效。');
        if (this.localStorageKeys.has(line.key)) throw new Error(`备份 localStorage 键重复：${line.key}`);
        this.localStorageKeys.add(line.key);
        this.recordCount += 1;
    }

    endLocalStorage() {
        if (!this.started || this.localStorageEnded || this.currentDatabase) throw new Error('备份 localStorage 结束标记无效。');
        this.localStorageEnded = true;
    }

    startDatabase(line) {
        if (!this.localStorageEnded || this.currentDatabase || this.databases.has(line.name)) throw new Error('备份数据库记录顺序无效。');
        const known = CONFIG.databases.find((item) => item.name === line.name);
        if (!known) throw new Error(`备份包含非白名单数据库：${line.name}`);
        const stores = Array.isArray(line.stores) ? line.stores : [];
        if (stores.length === 0) throw new Error(`备份数据库 ${line.name} 没有对象存储。`);
        const normalized = stores.map((store) => {
            if (!known.stores.includes(store?.name)) throw new Error(`备份包含非白名单对象存储：${line.name}/${store?.name}`);
            return { name: store.name, keyPath: store.keyPath ?? null, autoIncrement: Boolean(store.autoIncrement) };
        });
        if (new Set(normalized.map((store) => store.name)).size !== normalized.length) throw new Error(`备份数据库 ${line.name} 的对象存储重复。`);
        this.currentDatabase = { name: line.name, version: Number(line.version || 1), stores: normalized, finishedStores: new Set() };
        this.databases.set(line.name, this.currentDatabase);
        this.currentStore = normalized[0]?.name || null;
    }

    assertRecord(line) {
        if (!this.currentDatabase || !this.currentStore || line.database !== this.currentDatabase.name || line.store !== this.currentStore) throw new Error('备份对象存储记录顺序无效。');
    }

    record(line) {
        this.assertRecord(line);
        if (this.arrayRecord) throw new Error('备份数组记录尚未结束。');
        decodeJsonValue(line.key);
        decodeJsonValue(line.value);
        this.recordCount += 1;
    }

    startArray(line) {
        this.assertRecord(line);
        const length = Number(line.length);
        if (this.arrayRecord || !Number.isInteger(length) || length < 0) throw new Error('备份数组记录头无效。');
        decodeJsonValue(line.key);
        this.arrayRecord = { length, nextIndex: 0 };
    }

    arrayItem(line) {
        this.assertRecord(line);
        if (!this.arrayRecord || Number(line.index) !== this.arrayRecord.nextIndex) throw new Error('备份数组项目顺序无效。');
        decodeJsonValue(line.value);
        this.arrayRecord.nextIndex += 1;
    }

    endArray(line) {
        this.assertRecord(line);
        if (!this.arrayRecord || this.arrayRecord.nextIndex !== this.arrayRecord.length) throw new Error('备份数组记录长度不一致。');
        this.arrayRecord = null;
        this.recordCount += 1;
    }

    endStore(line) {
        this.assertRecord(line);
        if (this.arrayRecord) throw new Error('备份对象存储结束时数组记录未结束。');
        this.currentDatabase.finishedStores.add(this.currentStore);
        const next = this.currentDatabase.stores.find((store) => !this.currentDatabase.finishedStores.has(store.name));
        this.currentStore = next?.name || null;
    }

    endDatabase(line) {
        if (!this.currentDatabase || this.currentStore || line.name !== this.currentDatabase.name) throw new Error('备份数据库结束标记无效。');
        this.currentDatabase = null;
    }

    end(line) {
        if (!this.started || !this.localStorageEnded || this.currentDatabase || Number(line.recordCount) !== this.recordCount) throw new Error('备份结束信息或记录数量无效。');
        if (this.expectedRecordCount && this.recordCount !== this.expectedRecordCount) throw new Error('备份清单与 JSONL 记录数量不一致。');
        this.ended = true;
    }

    finish() {
        if (!this.started || !this.ended) throw new Error('备份 JSONL 不完整。');
        return { recordCount: this.recordCount, databases: this.databases, localStorageKeys: this.localStorageKeys };
    }
}

async function applyValidatedSnapshot(stagingDb, chunks, metadata, onProgress) {
    const databaseNames = await listExistingDatabaseNames();
    const openDatabases = new Map();
    try {
        for (const definition of CONFIG.databases) {
            const snapshotDb = metadata.databases.get(definition.name);
            if (!snapshotDb) continue;
            const stores = snapshotDb.stores;
            const db = await openDatabaseForRestore(definition.name, stores);
            openDatabases.set(definition.name, db);
        }

        for (const key of metadata.localStorageKeys) localStorage.removeItem(key);
        for (const definition of CONFIG.databases) {
            const db = openDatabases.get(definition.name);
            if (!db) continue;
            for (const storeName of definition.stores) {
                if (db.objectStoreNames.contains(storeName)) await clearObjectStore(db, storeName);
            }
        }

        let completed = 0;
        const arrays = new Map();
        const batches = new Map();
        const flush = async (database, store) => {
            const token = `${database}\u0000${store}`;
            const batch = batches.get(token) || [];
            if (batch.length === 0) return;
            batches.set(token, []);
            await writeRecordBatch(openDatabases.get(database), store, batch);
            completed += batch.length;
            onProgress(completed, metadata.recordCount);
        };
        const queue = async (database, store, record) => {
            const token = `${database}\u0000${store}`;
            if (!batches.has(token)) batches.set(token, []);
            batches.get(token).push(record);
            if (batches.get(token).length >= CONFIG.restoreBatchSize) await flush(database, store);
        };

        await parseStagedSnapshot(stagingDb, chunks, async (text) => {
            const line = JSON.parse(text);
            if (line.type === 'localStorage') {
                localStorage.setItem(line.key, String(line.value ?? ''));
                completed += 1;
                onProgress(completed, metadata.recordCount);
            } else if (line.type === 'record') {
                await queue(line.database, line.store, { key: decodeJsonValue(line.key), value: decodeJsonValue(line.value) });
            } else if (line.type === 'recordArrayStart') {
                arrays.set(`${line.database}\u0000${line.store}`, { key: decodeJsonValue(line.key), value: [] });
            } else if (line.type === 'recordArrayItem') {
                arrays.get(`${line.database}\u0000${line.store}`).value.push(decodeJsonValue(line.value));
            } else if (line.type === 'recordArrayEnd') {
                const token = `${line.database}\u0000${line.store}`;
                const record = arrays.get(token);
                arrays.delete(token);
                await queue(line.database, line.store, record);
            } else if (line.type === 'storeEnd') {
                await flush(line.database, line.store);
            }
        });
        if (arrays.size) throw new Error('恢复数组记录未完整写入。');
    } finally {
        openDatabases.forEach((db) => db.close());
    }
}

function openDatabaseForRestore(name, stores) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onupgradeneeded = () => createMissingStores(request.result, stores);
        request.onblocked = () => reject(new Error(`数据库 ${name} 被其他标签页占用，请关闭其他 RP-Hub 标签后重试。`));
        request.onerror = () => reject(request.error || new Error(`无法恢复数据库：${name}`));
        request.onsuccess = () => {
            const db = request.result;
            const missing = stores.filter((store) => !db.objectStoreNames.contains(store.name));
            if (missing.length === 0) return resolve(db);
            const version = db.version + 1;
            db.close();
            const upgrade = indexedDB.open(name, version);
            upgrade.onupgradeneeded = () => createMissingStores(upgrade.result, stores);
            upgrade.onblocked = () => reject(new Error(`数据库 ${name} 被其他标签页占用，请关闭其他 RP-Hub 标签后重试。`));
            upgrade.onerror = () => reject(upgrade.error || new Error(`无法升级数据库：${name}`));
            upgrade.onsuccess = () => resolve(upgrade.result);
        };
    });
}

function createMissingStores(db, stores) {
    for (const store of stores) {
        if (db.objectStoreNames.contains(store.name)) continue;
        const options = {};
        if (store.keyPath !== null && store.keyPath !== undefined) options.keyPath = store.keyPath;
        if (store.autoIncrement) options.autoIncrement = true;
        db.createObjectStore(store.name, options);
    }
}

function clearObjectStore(db, storeName) {
    return transactionPromise(db, storeName, 'readwrite', (store) => store.clear());
}

function writeRecordBatch(db, storeName, records) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error(`写入 ${db.name}/${storeName} 失败。`));
        transaction.onabort = () => reject(transaction.error || new Error(`写入 ${db.name}/${storeName} 已中止。`));
        for (const record of records) {
            if (store.keyPath !== null) store.put(record.value);
            else store.put(record.value, record.key);
        }
    });
}

function clearAllowedLocalStorage() {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (isAllowedLocalStorageKey(key)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
}

function transactionPromise(db, storeName, mode, action) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = action(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 操作失败。'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 操作已中止。'));
    });
}

async function encodeJsonValue(value, seen = new WeakSet()) {
    if (value === undefined) return { __rpImageBackupType: 'Undefined' };
    if (typeof value === 'bigint') return { __rpImageBackupType: 'BigInt', value: value.toString() };
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) throw new Error('IndexedDB 数据包含循环引用，无法序列化为 JSONL。');
    seen.add(value);
    try {
        if (value instanceof Date) return { __rpImageBackupType: 'Date', value: value.toISOString() };
        if (value instanceof ArrayBuffer) return { __rpImageBackupType: 'ArrayBuffer', value: bytesToBase64(new Uint8Array(value)) };
        if (ArrayBuffer.isView(value)) {
            return {
                __rpImageBackupType: 'TypedArray',
                name: value.constructor.name,
                value: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
            };
        }
        if (value instanceof Blob) {
            return {
                __rpImageBackupType: 'Blob',
                mime: value.type,
                value: bytesToBase64(new Uint8Array(await value.arrayBuffer()))
            };
        }
        if (value instanceof Map) {
            const entries = [];
            for (const [key, item] of value) entries.push([await encodeJsonValue(key, seen), await encodeJsonValue(item, seen)]);
            return { __rpImageBackupType: 'Map', value: entries };
        }
        if (value instanceof Set) {
            const entries = [];
            for (const item of value) entries.push(await encodeJsonValue(item, seen));
            return { __rpImageBackupType: 'Set', value: entries };
        }
        if (Array.isArray(value)) {
            const result = [];
            for (let index = 0; index < value.length; index += 1) result.push(await encodeJsonValue(value[index], seen));
            return result;
        }
        const result = {};
        for (const key of Object.keys(value)) result[key] = await encodeJsonValue(value[key], seen);
        return result;
    } finally {
        seen.delete(value);
    }
}

function decodeJsonValue(value) {
    if (Array.isArray(value)) return value.map(decodeJsonValue);
    if (!value || typeof value !== 'object') return value;
    const type = value.__rpImageBackupType;
    if (type === 'Undefined') return undefined;
    if (type === 'BigInt') return BigInt(value.value);
    if (type === 'Date') return new Date(value.value);
    if (type === 'ArrayBuffer') return base64ToBytes(value.value).buffer;
    if (type === 'Blob') return new Blob([base64ToBytes(value.value)], { type: value.mime || '' });
    if (type === 'Map') return new Map((value.value || []).map(([key, item]) => [decodeJsonValue(key), decodeJsonValue(item)]));
    if (type === 'Set') return new Set((value.value || []).map(decodeJsonValue));
    if (type === 'TypedArray') {
        const bytes = base64ToBytes(value.value);
        if (value.name === 'DataView') return new DataView(bytes.buffer);
        const Constructor = globalThis[value.name];
        if (typeof Constructor !== 'function' || !Constructor.BYTES_PER_ELEMENT) throw new Error(`不支持的 TypedArray：${value.name}`);
        return new Constructor(bytes.buffer);
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = decodeJsonValue(item);
    return result;
}

function bytesToBase64(bytes) {
    const parts = [];
    const step = 0x8000;
    for (let index = 0; index < bytes.length; index += step) parts.push(String.fromCharCode(...bytes.subarray(index, index + step)));
    return btoa(parts.join(''));
}

function base64ToBytes(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function jsonLine(value) {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') throw new Error('本地数据无法序列化。');
    return `${text}\n`;
}

async function sha256Text(text) {
    return sha256Bytes(new TextEncoder().encode(text));
}

async function sha256Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function updateBackupProgress(percent, text) {
    dom.backupProgress.hidden = false;
    const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
    dom.backupProgressBar.style.width = `${normalized}%`;
    dom.backupProgressValue.textContent = `${Math.round(normalized)}%`;
    dom.backupProgressText.textContent = text;
}

function setButtonBusy(button, busy, busyText = '') {
    if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? busyText : button.dataset.defaultText;
}

function setFormMessage(node, message, type) {
    node.textContent = message;
    node.className = `form-message${type ? ` ${type}` : ''}`;
}

function showToast(message, type = '') {
    const toast = element('div', `toast${type ? ` ${type}` : ''}`, message);
    dom.toastRegion.append(toast);
    setTimeout(() => toast.remove(), 5000);
}

function createStateNode(text, className) {
    return element('div', className, text);
}

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
}

function sameOriginUrl(value) {
    if (!value) return '';
    try {
        const url = new URL(value, location.href);
        return url.origin === location.origin ? url.href : '';
    } catch (_) {
        return '';
    }
}

function formatBytes(value) {
    let bytes = Math.max(0, Number(value) || 0);
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
        bytes /= 1024;
        unit += 1;
    }
    return `${bytes.toFixed(unit === 0 ? 0 : bytes >= 100 ? 0 : bytes >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDate(value) {
    const time = timestampOf(value);
    if (!time) return '时间未知';
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
}

function timestampOf(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function clampInteger(value, min, max) {
    const number = Math.round(Number(value));
    return Math.max(min, Math.min(max, Number.isFinite(number) ? number : min));
}

function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function isSurrogatePair(left, right) {
    return left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF;
}

function nextTask() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
