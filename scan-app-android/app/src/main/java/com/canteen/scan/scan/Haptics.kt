package com.canteen.scan.scan

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * 扫到即震的触觉反馈。
 *
 * 为什么震动比声音优先：食堂在饭点是**非常吵**的环境（打菜声、说话声），
 * 提示音基本听不见；而手机握在手里，震动一定能感知到。
 * 成功和失败用不同节奏，闭着眼也能分辨。
 *
 * 且震动与语音播报互不干扰 —— 语音是给员工听的确认，震动是给核销员自己的信号。
 */
object Haptics {

    /** 成功：短促一下 */
    fun success(context: Context) {
        vibrate(context, longArrayOf(0, 60))
    }

    /** 失败：两下短震，明确区分于成功 */
    fun fail(context: Context) {
        vibrate(context, longArrayOf(0, 60, 90, 60))
    }

    /** 扫码识别到码的瞬间：极短一下，表示"我看到了，正在处理" */
    fun detected(context: Context) {
        vibrate(context, longArrayOf(0, 30))
    }

    private fun vibrate(context: Context, pattern: LongArray) {
        // 旋钮关掉时不打扰用户；读取失败也不该让核销流程崩掉
        val vibrator = resolveVibrator(context) ?: return
        if (!vibrator.hasVibrator()) return

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(
                    VibrationEffect.createWaveform(pattern, -1),
                )
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, -1)
            }
        } catch (e: Exception) {
            // 部分定制 ROM 在免打扰模式下会抛异常。震动只是增强，失败就静默跳过
        }
    }

    private fun resolveVibrator(context: Context): Vibrator? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE)
                    as? VibratorManager
            manager?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    } catch (e: Exception) {
        null
    }
}
