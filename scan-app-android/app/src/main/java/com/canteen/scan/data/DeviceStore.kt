package com.canteen.scan.data

import android.content.Context
import android.content.SharedPreferences

/**
 * 设备绑定信息的本地存储。
 *
 * 只存三样东西：设备密钥、门店 id、门店名。
 * 不存 openid / 账号 / 密码 —— 设备身份完全由设备密钥承担，
 * 本机不留任何自然人凭据，设备丢了只需要在后台停用或换发密钥。
 *
 * 用 SharedPreferences 而不是 DataStore：只有三个字段、无并发写入，
 * 引 DataStore 会额外带进 kotlinx-serialization 或 protobuf，
 * 为一个"读三个字符串"的场景不值得。
 */
class DeviceStore(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)

    /** 设备密钥（明文）。不加密的原因见类注释上方说明 */
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
    }

    companion object {
        private const val PREF_NAME = "canteen_scan_device"
        private const val KEY_DEVICE_KEY = "device_key"
        private const val KEY_STORE_ID = "store_id"
        private const val KEY_STORE_NAME = "store_name"
        private const val KEY_DEVICE_NAME = "device_name"
    }
}
