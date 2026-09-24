# 扫码核销 App（CanteenScan）

企业团餐核销系统的**手机扫码核销端**：核销员用手机摄像头扫员工的动态核销码，直接完成核销并语音播报。与扫码枪/闸机走同一条设备通道（一机一密钥），无需账号体系。

## 功能

| 页面 | 功能 |
|------|------|
| 启动页 | 已绑定 → 直接进扫码页；未绑定 → 进绑定页 |
| 绑定页 | 输入平台发放的设备密钥 → 探测校验 → 保存进入扫码 |
| 扫码页 | CameraX + ML Kit 实时扫码；补光/切镜头/手动输码；本次会话核销计数 |
| 结果页 | 成功（员工/餐标/剩余次数/播报回显，4 秒自动返回）；失败（原因 + 该找谁 + 不自动返回） |
| 记录页 | 本机核销记录（最多 200 条），交班核对用；完整数据在管理后台 |

语音播报直接念**后端返回的 `voiceText`**（如「核销成功，餐标15元」），客户端不拼接任何业务文案——口径变化只需改服务端。

## 技术栈

- Kotlin + ViewBinding，minSdk 24 / targetSdk 34（Android 7.0+）
- CameraX 1.3.4（预览 + 帧分析）+ ML Kit barcode-scanning 17.2.0（**bundled 版**，模型打进 APK，不依赖 Google Play 服务）
- OkHttp 4 + Gson；原生 `TextToSpeech` 播报；震动反馈区分成功/失败

## 环境要求

- Android Studio（Koala 及以上均可，需带 AGP 8.5 支持）
- JDK 17（Android Studio 自带）
- 一台 Android 7.0+ 真机（相机必需，模拟器扫码体验差）

## 打包 APK 步骤

1. 用 Android Studio `Open` 打开 `scan-app-android/` 目录，等待 Gradle Sync 完成（首次会自动下载依赖）
2. 手机开启 USB 调试并连接，Android Studio 顶部选中该设备
3. 点绿色 ▶ 直接安装调试版；或菜单 `Build → Build Bundle(s)/APK(s) → Build APK(s)` 生成正式 APK（位于 `app/build/outputs/apk/`）
4. 生成**发布版**需要签名：`Build → Generate Signed Bundle / APK`，按向导创建 keystore（签名文件不要提交 git）

> 如 Gradle 下载依赖慢，可在 `settings.gradle.kts` 的仓库列表最前面加阿里云镜像：
> `maven { url = uri("https://maven.aliyun.com/repository/google") }`、`maven { url = uri("https://maven.aliyun.com/repository/central") }`

### 没有本地环境？云端编译拿 APK

工程自带 GitHub Actions 配置（`.github/workflows/build-apk.yml`）：

1. 把本目录内容推到任意 GitHub 仓库（保持 `.github/workflows/` 在仓库根）
2. 打开仓库 **Actions** 标签页，等「Build APK」跑完（首约 5-8 分钟）
3. 进入该次运行，页面底部 **Artifacts** 下载 `canteen-scan-debug-apk`，解压即得 APK

之后每次 push 都会自动重新出包，适合"改了后端地址就重打包"的节奏。

### 把 APK 装到手机（方式三：手机直接装）

> 前提：先通过上面任一方式拿到 APK 文件（如 `app-debug.apk`）。没有 APK 时这条路走不通——先云端编译或本地打包。

**推荐传输方式（按省事程度排序）：**

1. **数据线**（最稳）：手机连电脑选"文件传输"模式，把 APK 拷到手机的 `Download/` 目录 → 手机文件管理器里找到 → 点开安装
2. **QQ 传文件**：电脑 QQ 发给"我的手机"，手机 QQ 点开即可直接安装（QQ 不改文件名）
3. **微信传输助手**：⚠️ 经典坑——微信会把 `.apk` 改名成 `.apk.1`，下载后必须在文件管理器里**重命名去掉末尾的 `.1`** 才能点开安装
4. **网盘**：上传后手机端下载安装，速度慢但适合反复分发

**安装步骤：**

1. 手机上点开 APK → 系统弹"禁止安装未知来源应用"→ 点"设置"→ 允许**该应用来源**安装（只放行文件管理器/QQ/微信，不必全局放开）
2. 回到安装页 → 继续 → 完成
3. ⚠️ **HarmonyOS NEXT（纯血鸿蒙）不支持安装 APK**，需 Android 7.0+ 的普通安卓机或兼容安卓的鸿蒙 4.x 以下

**装好后的首次配置：**

1. 打开 App 自动进绑定页 → 粘贴后台「设备管理」发放的 48 位设备密钥 → 点「绑定并开始」
2. 首次进入扫码页会请求**相机权限**，必须允许（扫码必需）
3. App 后端地址已内置为 `https://tuancan.gengle.xyz`（HTTPS），无需额外设置

开发者调试也可以数据线连接后 `adb install app-debug.apk`。

## 修改后端地址

默认指向 `https://tuancan.gengle.xyz`。改一处即可：

```
app/build.gradle.kts → defaultConfig → buildConfigField("String", "API_BASE", "\"你的地址\"")
```

改完重新打包。换成 HTTPS 域名后，建议同步把
`app/src/main/res/xml/network_security_config.xml` 里的 `cleartextTrafficPermitted` 改为 `false`。

## 设备密钥从哪来

1. 平台管理员登录管理后台 →「设备管理」→ 新增设备（可绑定门店）
2. 保存后页面显示**一次性明文密钥**（48 位），复制它
3. App 绑定页粘贴 → 点「绑定并开始」

密钥丢失/泄露：后台对该设备「换发密钥」，旧密钥立即失效；App 下次核销会收到 2006 并引导重新绑定。

## 接口契约

App 只调用一个接口：

```
POST /api/device/verify
{ "deviceKey": "...", "qrToken": "员工码内容", "storeId": "可选" }
```

完整字段契约见 `verify-api-contract.cjs` 头部注释与 deliverables 里的交付说明。

## 本仓库自带的验证工具（无需 Android Studio 即可跑）

```bash
# 1. 工程静态一致性检查（资源引用/Manifest/ViewBinding/格式化参数）
node check-android.js

# 2. 接口契约验证（等价复刻 App 网络层，直接打后端）
#    先启动本地后端：
cd ../backend
node scripts/reset-local-db.js
node_modules/.bin/tsc -p tsconfig.json
LOCAL_MODE=1 PORT=3311 node dist/main.js
#    另开终端：
cd ../scan-app-android
node verify-api-contract.cjs
```

## 已知限制

- ~~本工程未经过真机编译~~ **已于 2026-09-24 用便携工具链实际编译通过**，且已修复 Android 15+ 设备的两类兼容性警告：
  - **16 KB 页对齐**：ML Kit 17.2.0→17.3.0（libbarhopper_v3.so）+ CameraX 1.3.4→1.4.2（libimage_processing_util_jni.so）+ compileSdk 35 + so 未压缩打包；`check-16k-alignment.py` 可随时复验
  - **可调试应用警告**：release 包（内部分发签名，keystore 在 `keystore/`）不再带 debuggable 标志
  - `deliverables/` 同时提供 debug 与 release 两个包
- ⚠️ **debug 与 release 签名不同，不能互相覆盖安装**——换包装要先卸载旧包（绑定信息会清掉，需重输设备密钥）
- 本工程路径含中文，已在 `gradle.properties` 加 `android.overridePathCheck=true`；若编译在资源环节报诡异错误，把工程整体复制到纯英文路径再编
- 必须联网核销（无离线模式），断网时明确提示网络异常
- 手动输码适用于员工屏幕碎裂/贴防窥膜的场景，输入的是核销码的完整 token
