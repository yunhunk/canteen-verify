package com.canteen.scan.ui

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.canteen.scan.ScanApp

/**
 * 启动页 —— 只做路由，不停留。
 *
 * 判断本机是否已绑定设备密钥：
 * - 已绑定 → 直接进扫码页（核销员开机就要用，多一步点击都是浪费）
 * - 未绑定 → 进绑定页
 *
 * 刻意不在这里做"密钥是否仍然有效"的网络预检：
 * 那会让每次冷启动都卡在等待网络上。真失效了，第一次扫码会立刻
 * 返回 2006，届时再引导重新绑定，体验反而更好（且有明确的失败现场）。
 */
class SplashActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val store = ScanApp.from(this).deviceStore
        val target = if (store.isBound) {
            Intent(this, ScanActivity::class.java)
        } else {
            Intent(this, BindActivity::class.java)
        }

        startActivity(target)
        finish()
    }
}
