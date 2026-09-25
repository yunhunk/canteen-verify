package com.canteen.scan.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 设备绑定信息的本地存储。
 *
 * 只存四样东西：设备密钥、门店 id、门店名、设备名。
 * 不存 openid / 账号 / 密码 —— 设备身份完全由设备密钥承担，
 * 本机不留任何自然人凭据，设备丢了只需要在后台停用或换发密钥。
 *
 * ═══ 漏洞 10325：设备密钥必须加密落盘 ═══
 *
 * 旧实现用普通 SharedPreferences(MODE_PRIVATE)，设备密钥以**明文**存于
 * /data/data/com.canteen.scan/shared_prefs/canteen_scan_device.xml。
 * 该文件在 root 设备、ADB backup（android:allowBackup 默认 true）、
 * 或云备份提取场景下可被直接读走 —— 而设备密钥就是这台扫码枪的
 * 全部凭据，读走即可冒名核销，等于凭证泄露。
 *
 * 现改用 androidx.security 的 EncryptedSharedPreferences：
 *   • 主密钥（MasterKey）由 Android Keystore 生成并保管，**不落盘**，
 *     无法离开本机、无法被备份导出；
 *   • 条目内容用 AES-256-GCM 加密，键名用 AES-256-SIV 确定性加密；
 *   • 若 Keystore/加密初始化失败（极少数定制 ROM），回退到普通
 *     SharedPreferences 以保证业务可用，但会把回退事件写进 Log，
 *     便于排查。安全与可用性之间的取舍在此显式记录，不静默降级。
 */
class DeviceStore(context: Context) {

    private val appContext = context.applicationContext

    /** 加密失败时的标志：此时用的是降级存储，界面可据此提示 */
    var usingEncryptedStorage: Boolean = true
        private set

    private val prefs: SharedPreferences = createPrefs(appContext)

    private fun createPrefs(ctx: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(ctx)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                ctx,
                PREF_NAME_ENC,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (e: Exception) {
            // Keystore 不可用等异常：降级到明文存储，但记录日志（不静默）。
            Log.w(TAG, "加密存储初始化失败，降级为普通 SharedPreferences：${e.message}")
            usingEncryptedStorage = false
            ctx.getSharedPreferences(PREF_NAME_PLAIN, Context.MODE_PRIVATE)
        }
    }

    /** 设备密钥。落盘时由 EncryptedSharedPreferences 加密 */
    var deviceKey: String?
        get() = prefs.getString(KEY_DEVICE_KEY, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_KEY, value).apply()

    /** 设备绑定的门店 id；设备未绑店时为 null */
    var storeId: String?
        get() = prefs.getString(KEY_STORE_ID, null)
        set(value) = prefs.edit().putString(KEY_STORE_ID, value).apply()

    /** 门店名，仅用于界面展示 */
    var storeName: String?
        get() = prefs.getString(KEY_STORE_NAME, null)
        set(value) = prefs.edit().putString(KEY_STORE_NAME, value).apply()

    /** 设备名（绑定成功后由服务端回传的 storeName 或用户填的备注） */
    var deviceName: String?
        get() = prefs.getString(KEY_DEVICE_NAME, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_NAME, value).apply()

    /** 是否已完成绑定 —— 启动页据此决定去绑定页还是扫码页 */
    val isBound: Boolean
        get() = !deviceKey.isNullOrBlank()

    /** 保存绑定信息 */
    fun save(deviceKey: String, storeId: String?, storeName: String?, deviceName: String? = null) {
        prefs.edit()
            .putString(KEY_DEVICE_KEY, deviceKey)
            .putString(KEY_STORE_ID, storeId)
            .putString(KEY_STORE_NAME, storeName)
            .putString(KEY_DEVICE_NAME, deviceName)
            .apply()
    }

    /** 解绑：清空全部绑定信息，下次启动回到绑定页 */
    fun clear() {
        prefs.edit().clear().apply()
        // 一并清掉可能残留的明文存储（历史版本升级上来的设备）
        runCatching {
            appContext.getSharedPreferences(PREF_NAME_PLAIN, Context.MODE_PRIVATE)
                .edit().clear().apply()
        }
    }

    companion object {
        private const val TAG = "DeviceStore"

        /** 加密存储文件名（实际落盘为密文） */
        private const val PREF_NAME_ENC = "canteen_scan_device_enc"

        /** 明文存储文件名 —— 仅作降级与历史清理用 */
        private const val PREF_NAME_PLAIN = "canteen_scan_device"

        private const val KEY_DEVICE_KEY = "device_key"
        private const val KEY_STORE_ID = "store_id"
        private const val KEY_STORE_NAME = "store_name"
        private const val KEY_DEVICE_NAME = "device_name"
    }
}
