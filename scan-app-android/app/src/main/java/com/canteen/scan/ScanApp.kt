package com.canteen.scan

import android.app.Application
import android.util.Log
import com.canteen.scan.data.DeviceStore
import com.canteen.scan.data.HistoryStore

/**
 * 应用入口。
 *
 * 只做一件事：把两个 Store 的构造集中到一处（持有 ApplicationContext，
 * 不会泄漏 Activity）。不做网络预连接、不初始化 TTS ——
 * 这两件事都该在真正用到时再做，避免拖慢冷启动。
 */
class ScanApp : Application() {

    /** 设备绑定信息 */
    val deviceStore: DeviceStore by lazy { DeviceStore(this) }

    /** 本机核销记录 */
    val historyStore: HistoryStore by lazy { HistoryStore(this) }

    override fun onCreate() {
        super.onCreate()
        // 把后端地址打进日志：装错包（连了测试环境）时，看一眼 logcat 就能发现，
        // 不用去翻代码或重打包确认
        Log.i("ScanApp", "启动，后端地址 = ${BuildConfig.API_BASE}")
    }

    companion object {
        /** 便于 Activity 里取用（生命周期与进程一致，无需担心泄漏） */
        fun from(context: android.content.Context): ScanApp =
            context.applicationContext as ScanApp
    }
}
