# RP-FixedImage

RP-FixedImage 基于 RP-Hub 1.7.6，通过 Cloudflare Worker、Static Assets 和 R2 为聊天生图提供持久缓存、WebP 压缩副本、图片管理与浏览器数据备份。

仓库中的 RP-Hub 1.7.6 源文件保持原样。Worker 返回主页时会在响应 HTML 中运行时注入 WebP bridge；需要启用同源代理时，BAT 只修改 `assets/js/app.js` 中的两个稳定片段：将 NAI 地址改为同源，并为生图请求增加当前角色名。

## 功能

- RP-Hub 1.7.6 与 Worker、管理台同源部署。
- RP-Hub 继续在浏览器请求中携带 NAI token，Worker 不保存 token。
- 首次生成后将原图保存到 R2，后续请求不再调用上游生图服务。
- 浏览器将原图转换为 WebP 并回传，之后优先返回 WebP。
- BAT 为默认生图正则增加当前角色名，图片按角色名分组；同名角色共享缓存。
- 图片名使用完整生成参数规范化后的 SHA-256。
- 管理台支持图片查看、下载、删除、浏览器备份和恢复。
- 浏览器备份按分片上传，并校验每个分片和完整清单。

## 图片存储

原图：

```text
RP-image/image/<安全角色名>--00000000-0000-4000-8000-000000000000/<SHA-256>
```

WebP：

```text
RP-image/Cache/<安全角色名>--00000000-0000-4000-8000-000000000000/<SHA-256>.webp
```

图片请求流程：

```text
RP-Hub 输出 image###提示词###
  -> /generate（同源 Worker）
  -> R2 中存在 WebP：返回 WebP
  -> R2 中存在原图：返回原图
  -> 两者均不存在：Worker 移除本地 character_name 后将 NAI 参数原样转发
  -> 保存原图并返回
  -> 浏览器转换为 WebP 并上传
```

## 与 RP-Hub 1.7.6 的差异

保持原样的上游文件：

```text
index.html
assets/css/styles.css
assets/js/card-utils.js
assets/js/ui-select.js
assets/js/utils.js
LICENSE
```

`assets/js/app.js` 默认保持 RP-Hub 1.7.6 原样。使用仓库中的 BAT 后只会把 `IMAGE_GEN_BASE_URL` 从 `https://nai.sta1n.cn` 改为 `window.location.origin`，并在默认生图 URL 中增加 URL 编码后的 `character_name`。其他默认生图参数和 token 传递逻辑保持不变。

## 角色卡工坊

本版本不包含 `character/index.html`。RP-Hub 1.7.6 参考文件中存在硬编码的第三方 API Key，为避免向公开仓库提交凭据，已按项目决策移除角色卡工坊文件。

因此：

- 主 RP-Hub、聊天、角色卡管理和聊天生图仍可使用。
- 侧边栏中的“角色卡生成”页面无法加载。
- 原版 RP-Hub 没有备份暂停接口，创建备份或恢复前应关闭其他打开的 RP-Hub 标签页。

## 浏览器备份

备份范围：

```text
RPHubDB/store
AICharGen/characters（存在时）
SillyTavernDB/store（存在时）
rp_hub_*
ai_chargen_*
silly_tavern_*
```

R2 目录：

```text
RP-image/save/<站点名称>--<Origin-SHA-256>/<时间戳>/
```

备份不会加密，可能包含聊天、角色、记忆、用户资料和应用保存的 API Key。请只使用私有 R2 Bucket，并严格限制 Cloudflare 账户权限。

## Cloudflare 部署

项目使用 Cloudflare Worker + Static Assets 部署。`wrangler.jsonc` 明确将 `_worker.js` 设为 Worker 入口，并通过 `env.ASSETS` 提供仓库中的 RP-Hub 静态文件；`.assetsignore` 会阻止 Worker 源码、Git 文件、测试和开发脚本被作为公开静态资源上传。

Cloudflare Git 构建配置：

```text
Build command: npm run check
Deploy command: npx wrangler deploy
Root directory: /
```

不要将 Deploy command 配置为 `npx wrangler deploy .`。显式传入 `.` 会让 Wrangler 将整个仓库优先识别为静态资源目录，并可能触发 `_worker.js` 被当作公开资源上传的保护错误。

创建 R2 Bucket，并配置以下绑定名称：

```text
RP_IMAGE_R2
```

配置 Worker Secrets：

```text
RP_IMAGE_ADMIN_PASSWORD
```

部署后：

1. 打开 `https://<域名>/rp-image`。
2. 使用 `RP_IMAGE_ADMIN_PASSWORD` 登录。
3. 运行 `rp-fixed-image-app.bat apply`，让 RP-Hub 的 NAI 请求改为同源 Worker。
4. 返回 RP-Hub，在原设置页填写 NAI Key，选择角色并启用自动生图。

管理登录使用有效期 30 天的 `HttpOnly`、`Secure`、`SameSite=Strict` Cookie，作用域为 `/rp-image`，仅用于图片管理和浏览器备份。生图缓存未命中时，Worker 使用当前浏览器请求携带的 token 调用 NAI；token 不参与缓存哈希，也不会写入 R2。

## 限制

- 原图最大 64 MiB。
- WebP 最大 32 MiB。
- 浏览器备份分片为 8 MiB，Worker 单分片上限为 16 MiB。
- 单个备份最大 1 GiB、最多 256 个分片。
- 每个站点可保留 1 到 30 个备份版本。
- 同参数生成锁只在单个 Worker isolate 内有效。R2 是最终持久缓存，但极端并发的首次请求仍可能跨 isolate 重复调用上游。

## 本地验证

项目没有构建步骤。

```text
npm run check
npm test
```

`npm run check` 检查 Worker、RP-Hub 接入脚本、bridge 和管理端脚本语法。

`npm test` 验证管理登录、设置保存、透明 NAI 请求转发、token 不持久化、原图缓存、WebP 回传与优先缓存和备份分片提交。

## app.js 补丁脚本

仓库根目录的 `rp-fixed-image-app.bat` 可以对兼容 RP-Hub 版本的 `assets/js/app.js` 应用或还原同源 NAI 代理与角色名参数。

`rp-fixed-image-app.bat` 是直接运行入口，具体补丁逻辑位于同目录的 `rp-fixed-image-app.ps1`。复制脚本到其他位置时需要同时保留这两个文件。

在本仓库中使用：

```text
rp-fixed-image-app.bat status
rp-fixed-image-app.bat apply
rp-fixed-image-app.bat restore
```

对其他 RP-Hub 目录使用：

```text
rp-fixed-image-app.bat apply D:\path\to\RP-Hub
rp-fixed-image-app.bat restore D:\path\to\RP-Hub
```

第二个参数也可以直接指向 `assets\js\app.js`。脚本只修改两个唯一片段：将 `IMAGE_GEN_BASE_URL` 改为同源，并在默认 `/generate` URL 中加入当前角色的 `character_name`；其他默认正则内容和参数保持原样。脚本不锁定整个文件哈希，因此 RP 更新后只要这两个补丁点仍唯一且结构兼容即可直接应用；遇到缺失、重复或部分修改的补丁点会停止。每次应用都会在原文件旁创建或更新 `app.js.rp-fixed-image.bak`，还原时会校验备份与当前补丁可逆结果一致。

## 许可证

RP-Hub 基础代码继续遵循 `CC BY-NC 4.0`，详见 `LICENSE`。未经原作者授权不得用于商业用途。
