# MonkeyScan 漏洞修复报告

> 扫描对象：`yunhunk/canteen-verify`（团餐核销系统）
> 报告来源：`monkeyscan-task-yunhunk_canteen-verify_main-defects (1).zip`（29 份缺陷说明）
> 修复日期：2026-09-25
> 验证方式：本地端到端验证（3 套脚本 + 专项断言 26 项）、编译验证、构建产物扫描

---

## 一、总览

| 编号 | 漏洞 | 级别 | 状态 | 修复要点 |
|------|------|------|------|----------|
| e5fe7 / 440fe | `POST /api/verify/scan` 缺角色限制且未校验跨租户归属 | **P0** | ✅ | 加 `@Roles('employee')` + `assertTenantMatch()` |
| 72550 | `GET /api/company/remain` 缺角色限制 | **P0** | ✅ | 加 `@Roles('company')` |
| 8f382 | `GET /api/employee/windows` 缺角色限制 | **P0** | ✅ | 员工控制器类级 `@Roles('employee')` |
| 6abcb | nginx `/assets/` 重复 `add_header` 丢安全头 | 中 | ✅ | 抽 `security-headers.conf` 片段，各层级 include |
| cc0a4 / 58dd3 / 93ed2 | X-Forwarded-For 伪造绕过限流、伪造审计 IP | **P0** | ✅ | ClientIp 只信 X-Real-IP → req.ip → remoteAddress |
| b7846 | 设备通道未校验设备所属公司 vs 二维码公司 | 高 | ✅ | `resolveStoreId` 加设备 `company_id` 校验 |
| 807d2 | Redis 静默降级使限流退化单进程语义 | 低 | ✅ | 生产 fail-closed，`ALLOW_REDIS_DEGRADED=1` 才降级 |
| 2c476 | 跨公司转移员工未失效会话与二维码 | 高 | ✅ | `token_version+1` + 作废二维码 + 变更日志 |
| 707ba | 微信绑定 TOCTOU 绕过「一人一号」 | 高 | ✅ | 条件 UPDATE 原子绑定，`affected=0` 即失败 |
| a4f59 | 「最后一个超管」保护 TOCTOU | 高 | ✅ | 检查+写入包进事务 + 悲观写锁 |
| 7d3e8 | 后台登录锁定可被用户名变体绕过 | 高 | ✅ | 用户名 NFKC + trim + lower 规范化 + IP 限流 |
| a095f | 第二条员工登录路由缺限流 | 高 | ✅ | 限流下沉到 `AuthService.employeeLogin` 内部 |
| 4fb74 / 77064 | 仅用工号绑定时无限流、无校验 | 高 | ✅ | 三方限流（code/phone/IP）+ 工号格式校验 |
| 4b4e9 | 工号跨租户匹配导致越权绑定 | 高 | ✅ | 要求 phone+employeeNo 命中同一行 |
| **23242** | **不安全的默认数据库凭据（root/root）** | **高** | ✅ | 移除 `'root'` 兜底 + 生产强制校验 + 弱口令拒绝 |
| **32a18** | **CSV 公式注入** | **中** | ✅ | `csvCell()` 对 `=+-@\t\r` 起始值前置单引号 |
| **fb0a0** | **设备密钥仍接受无盐 SHA-256 旧哈希** | **中** | ✅ | 加 `ALLOW_LEGACY_KEY_HASH` 开关，生产默认关闭 |
| **724a4 / 51062 / 50b9f / 20652** | **种子/脚本硬编码凭据** | **中** | ✅ | 全部改环境变量 `SEED_*`，本地演示值仅兜底 |
| **10325** | **设备密钥明文存 SharedPreferences** | **低** | ✅ | 改用 EncryptedSharedPreferences + Keystore |
| **04f84** | **缺少服务端登出，JWT 7 天内始终可用** | **中** | ✅ | 新增 `POST /api/auth/logout`（token_version+1） |
| **5ac96 / b4d15** | **token 存 localStorage 且缺 CSP** | **低** | ✅ | nginx CSP 片段 + index.html meta 回退 |

**29 项全部完成修复。** 加粗行为本轮新增修复项（此前 3 轮已完成其余部分）。

---

## 二、本轮修复明细

### 1. 23242 不安全的默认数据库凭据

**问题**：`app.config.ts` 里 `username: process.env.DB_USER || 'root'`、
`password: process.env.DB_PASSWORD || 'root'`。弱默认一旦随镜像泄漏等于留后门。

**修复**（`backend/src/config/app.config.ts`）：

```ts
if (!localMode) {
  // ...
  const dbUser = process.env.DB_USER;
  const dbPassword = process.env.DB_PASSWORD;
  if (!dbUser || !dbPassword) {
    throw new Error('生产环境必须显式配置 DB_USER 和 DB_PASSWORD');
  }
  if (dbPassword === 'root' || dbPassword === 'password' || dbPassword.length < 12) {
    throw new Error('DB_PASSWORD 强度不足（禁用 root/password 等弱口令，长度须 ≥12）');
  }
}
// 兜底值改为空串（仅 localMode 会走到；生产已被上面拦截）
username: process.env.DB_USER || '',
password: process.env.DB_PASSWORD || '',
```

**验证**：缺凭据 → 抛「必须显式配置」；`root` → 抛「强度不足」；
合规强口令 → 正常加载（未误杀）。

---

### 2. 32a18 CSV 公式注入

**问题**：员工姓名/门店名若被填成 `=cmd|'/c calc'!A1`，导出 CSV 后
在打开文件的机器上执行命令（CWE-1236）。

**修复**（`backend/src/modules/consumption/consumption.service.ts`）：

```ts
private csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // 公式注入中和：起始为 = + - @ 或制表符/回车时前置单引号
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
```

顺序很关键：**先**中和公式、**再**做引号包裹，否则 `"=1+1"` 仍会被部分解析器当公式。

**验证**：`=cmd → '=cmd`、`+1 → '+1`、`-2 → '-2`、`@SUM → '@SUM`；
常规值 `normal`、`a,b → "a,b"`、`q"q → "q""q"` 未被破坏。

---

### 3. fb0a0 淘汰旧 SHA-256 设备密钥哈希

**问题**：`candidateHashes()` 无条件追加 `sha256(plain)`，任何残留的
64 字符旧哈希行仍可被快速、无盐哈希认证，库泄漏即可离线爆破。

**修复**（`backend/src/modules/common/utils/device-key.ts`）：

```ts
export function isLegacyKeyHashAllowed(): boolean {
  if (process.env.ALLOW_LEGACY_KEY_HASH === '1') return true;
  if (process.env.ALLOW_LEGACY_KEY_HASH === '0') return false;
  // 未显式设置：生产默认拒绝，本地默认允许
  return process.env.LOCAL_MODE === '1';
}

export function candidateHashes(plain: string): string[] {
  const list = [hashDeviceKey(plain)];
  if (isLegacyKeyHashAllowed()) list.push(hashDeviceKeyLegacy(plain));
  return list;
}
// candidateHashesAsync 同理
```

配套 `deploy/migrations/2026-09-25-retire-legacy-device-key-hash.sql`：
盘点旧行 → 确保字段 255 宽 → 加 `CHECK (key_hash LIKE 'v2$%')` 约束
永久禁止旧形态写入；旧行需走后台「换发密钥」重发（哈希单向不可改写）。

**验证**：生产模式候选数 = 1（仅 `v2$`）；显式开启时候选数 = 2（不误伤老设备）。

---

### 4. 724a4 / 51062 / 50b9f / 20652 硬编码凭据外置

**问题**：`ensure-database.ts`、`verify-login.cjs`、`verify-api-contract.cjs`
内硬编码 `admin123456` / `company123456` / `device-key-demo-000x`，
且扫描器指出这些是**真能登录**的值（非占位符）。

**修复**：全部改为环境变量读取，本地演示值仅作无配置时的兜底：

| 文件 | 变量 |
|------|------|
| `backend/src/database/ensure-database.ts` | `SEED_SUPER_PASSWORD` / `SEED_COMPANY_PASSWORD` / `SEED_DEVICE_KEY_1/2` |
| `admin-web/scripts/verify-login.cjs` | `SEED_SUPER_PASSWORD` / `SEED_COMPANY_PASSWORD` |
| `scan-app-android/verify-api-contract.cjs` | 同上 + `SEED_DEVICE_KEY_1/2` |

`ensure-database.ts` 同时把设备 `key_prefix` 从固定 `'device-k'`
改为密钥前 8 位，日志中非本地演示时不再回显明文口令。
`deploy/.env.example` 新增第七节说明这些变量。

---

### 5. 10325 设备密钥加密落盘

**问题**：设备 bearer key（192 位高熵、`/api/device/verify` 唯一凭据）
以明文存于 `/data/data/.../shared_prefs/canteen_scan_device.xml`，
root / ADB backup / 取证镜像下可被直接读走并异地重放（CWE-312）。

**修复**（`scan-app-android/.../data/DeviceStore.kt`）：

```kotlin
private fun createPrefs(ctx: Context): SharedPreferences {
    return try {
        val masterKey = MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            ctx, PREF_NAME_ENC, masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        Log.w(TAG, "加密存储初始化失败，降级为普通 SharedPreferences：${e.message}")
        usingEncryptedStorage = false
        ctx.getSharedPreferences(PREF_NAME_PLAIN, Context.MODE_PRIVATE)
    }
}
```

主密钥由 Android Keystore 生成且不落盘；`clear()` 额外清理历史版本
可能残留的明文文件。降级不静默（写 Log + `usingEncryptedStorage` 标志可供界面提示）。

依赖新增 `androidx.security:security-crypto:1.1.0-alpha06`。

**验证**：APK 编译通过（BUILD SUCCESSFUL），dex 中确认含
`EncryptedSharedPreferences` / `MasterKey` / `AES256_GCM` / `canteen_scan_device_enc`。

> 顺带修掉两处**上游不存在的依赖版本**（`material:1.12.3`、`recyclerview:1.3.3`
> 在 google/aliyun 仓库均为 404，导致无法构建），改用实际存在的 `1.12.0` / `1.3.2`。

---

### 6. 04f84 服务端登出

**问题**：登出仅清 localStorage，JWT 默认 7 天，被窃取的令牌在用户
「退出」后仍可全程使用。

**修复**：

- 后端 `auth.service.ts` 已有 `logout()`（`token_version+1`），本次补齐
  `POST /api/auth/logout`（`@Roles('super','company','employee')`）；
- 前端 `api/auth.js` 加 `logout()`；`stores/user.js` 的 `logout()` 改为
  **先 await 服务端注销、再清本地**（顺序不能反，否则带不上 Authorization 头）；
- `AdminLayout.vue` 的调用点改为 `await store.logout()`。

**验证**：登出接口 `code=0`；同一 token 再次访问受保护接口 → HTTP 401（biz 1006）；
吊销后可重新登录。

---

### 7. 5ac96 / b4d15 CSP 回退

**问题**：token 在 localStorage，任何 XSS 都能读走；nginx 未设 CSP，
index.html 也无 meta 回退。

**修复**：

- nginx：新增 `deploy/nginx/security-headers.conf` 片段（含 CSP），
  在 server 级与 `location /assets/` 都 `include`（解决 6abcb 的层级覆盖问题）；
- 前端：`admin-web/index.html` 加 CSP meta 作为第二层防线
  （nginx 配置被误改或静态站改托管时仍生效）。

CSP 策略：`default-src 'self'`、`script-src 'self'`（不放开 inline/eval）、
`style-src 'self' 'unsafe-inline'`（Element Plus 运行时注入行内样式）、
`object-src 'none'`、`base-uri 'self'`、`frame-ancestors`。

**验证**：构建产物 `dist/index.html` 含 CSP meta；全量 bundle 扫描
`admin123456|company123456` 零命中。

---

## 三、验证结果

| 验证项 | 结果 |
|--------|------|
| 后端 TypeScript 编译 | ✅ 零错误 |
| 后端 `nest build` | ✅ 通过 |
| 设备密钥回归 `verify-device-key-fix.cjs` | ✅ **8 / 8** |
| 扫码 App 接口契约 `verify-api-contract.cjs` | ✅ **55 / 55** |
| 管理后台联调 `verify-login.cjs` | ✅ **22 / 22** |
| MonkeyScan 专项 `verify-monkeyscan-fixes.cjs` | ✅ **26 / 26** |
| 管理后台前端构建 | ✅ 6.53s |
| Android debug APK 编译 | ✅ BUILD SUCCESSFUL |
| APK 加密类编入检查 | ✅ 5/5 关键字 FOUND |

**合计 111 项断言全部通过。**

---

## 四、部署注意事项

1. **23242**：生产 `.env` 必须已配 `DB_USER` / `DB_PASSWORD`（≥12 位、非 root/password），
   否则后端会**拒绝启动**。现网已有配置，升级后请确认。
2. **fb0a0**：先执行
   `deploy/migrations/2026-09-25-retire-legacy-device-key-hash.sql`；
   若第 1 步盘点出 `legacy_sha256_rows > 0`，需先在后台给对应设备
   **换发密钥**并下发新 App，再保持 `ALLOW_LEGACY_KEY_HASH=0`。
3. **10325**：需**重新分发 APK**（`scan-app-android` 重编译产物）。
   老版本升级到新版后，首次 `clear()` 会清掉历史明文文件；
   已绑定设备需**重新绑定**一次（明文文件不会被新版读取）。
4. **04f84**：管理后台需**重新构建部署**（`admin-web/dist`）。
5. **6abcb / b4d15**：nginx 需重新加载，并确认
   `security-headers.conf` 已挂载到 `/etc/nginx/conf.d/`。
6. **807d2**：生产 Redis 必须可用；确需降级调试请显式设 `ALLOW_REDIS_DEGRADED=1`。

---

## 五、未改动但已确认安全的项

- `android:allowBackup="false"` 已在 Manifest 配置（降低 10325 敞口）；
- `MODE_PRIVATE` 保持（限制同 UID 访问）；
- 应用代码无 `v-html` / `innerHTML` / `dangerouslySetInnerHTML` 汇聚点
  （扫描器也确认未发现实际 XSS 路径，故 5ac96 评为 LOW/潜在）。
