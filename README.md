# RP-FixedImage

RP-FixedImage 基于 RP-Hub 1.7.6，通过 Cloudflare Pages Advanced Mode Worker 和 R2 为聊天生图提供持久缓存、WebP 压缩副本、图片管理与浏览器数据备份。

项目尽量减少对 RP-Hub 的侵入：`index.html`、样式、工具脚本和许可证保持 RP-Hub 1.7.6 原样，仅在 `assets/js/app.js` 中加入必要的加载入口、图片 URL 构造和备份写入控制。

## 功能

- RP-Hub 1.7.6 与 Worker、管理台同源部署。
- 浏览器不再把 NAI Key 放入图片 URL。
- 首次生成后将原图保存到 R2，后续请求不再调用上游生图服务。
- 浏览器将原图转换为 WebP 并回传，之后优先返回 WebP。
- 图片按角色名称和 UUID 分组。
- 图片名使用完整生成参数规范化后的 SHA-256。
- NAI Key 使用 AES-GCM 加密后保存到 R2，管理台不回显明文。
- 管理台支持图片查看、删除、NAI Key 设置、浏览器备份和恢复。
- 浏览器备份按分片上传，并校验每个分片和完整清单。

## 图片存储

原图：

```text
RP-image/image/<角色名称>--<角色UUID>/<SHA-256>
```

WebP：

```text
RP-image/Cache/<角色名称>--<角色UUID>/<SHA-256>.webp
```

图片请求流程：

```text
RP-Hub 输出 image###提示词###
  -> /rp-image/api/render
  -> R2 中存在 WebP：返回 WebP
  -> R2 中存在原图：返回原图
  -> 两者均不存在：Worker 解密 NAI Key 并请求上游
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

为接入 RP-FixedImage 而修改的上游文件：

```text
assets/js/app.js
```

`app.js` 中的改动仅包括：

- 动态加载 `/rp-image/bridge.js`，不修改 `index.html`。
- 将 `NAI画图正则` 的图片地址改为同源 Worker。
- 对正则捕获的提示词执行 URL 编码。
- 将额度和图片服务状态检查改为 Worker 接口。
- 提供主 RP-Hub 的备份刷新、暂停、恢复和重载入口。

## 角色卡工坊

本版本不包含 `character/index.html`。RP-Hub 1.7.6 参考文件中存在硬编码的第三方 API Key，为避免向公开仓库提交凭据，已按项目决策移除角色卡工坊文件。

因此：

- 主 RP-Hub、聊天、角色卡管理和聊天生图仍可使用。
- 侧边栏中的“角色卡生成”页面无法加载。
- 备份恢复期间只会自动暂停主 RP-Hub 的写入。
- 恢复前仍应关闭其他打开的 RP-Hub 标签页。

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

将整个仓库作为 Cloudflare Pages 项目部署。项目根目录中的 `_worker.js` 使用 Pages Advanced Mode，并通过 `env.ASSETS` 提供静态文件。

创建 R2 Bucket，并配置以下绑定名称：

```text
RP_IMAGE_R2
```

配置 Worker Secrets：

```text
RP_IMAGE_ADMIN_PASSWORD
RP_IMAGE_MASTER_KEY
```

`RP_IMAGE_MASTER_KEY` 应使用足够长的随机值。保存 NAI Key 后如果修改该 Secret，原有密文将无法解密，需要删除并重新保存 NAI Key。

部署后：

1. 打开 `https://<域名>/rp-image`。
2. 使用 `RP_IMAGE_ADMIN_PASSWORD` 登录。
3. 在“设置”中填写、测试并保存 NAI Key。
4. 返回 RP-Hub，选择角色并启用自动生图。

管理登录使用有效期 30 天的 `HttpOnly`、`Secure`、`SameSite=Strict` Cookie，作用域为 `/rp-image`。R2 已存在的图片可直接读取；缓存未命中并需要调用上游时，浏览器必须有有效管理会话。

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

`npm test` 验证管理登录、设置保存、NAI Key 加密、首次生成、原图缓存、WebP 优先缓存和备份分片提交。

## 许可证

RP-Hub 基础代码继续遵循 `CC BY-NC 4.0`，详见 `LICENSE`。未经原作者授权不得用于商业用途。
