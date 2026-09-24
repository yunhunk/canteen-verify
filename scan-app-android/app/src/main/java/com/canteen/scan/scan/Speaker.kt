package com.canteen.scan.scan

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * 语音播报。
 *
 * 直接念后端返回的 voiceText（如 `核销成功，餐标15元`），
 * **不在客户端拼接任何业务文案** —— 金额去尾零、有没有餐标这些规则
 * 都在服务端统一了；客户端一旦自己拼，就等于把规则复制到每台设备上，
 * 将来改口径要挨个升级 APK。
 *
 * 初始化是异步的：TTS 引擎加载要几百毫秒到一两秒。
 * 因此这里做了"待播队列"—— 初始化完成前调 speak() 的内容不会丢，
 * 会在就绪后依次补播。这一点很重要：冷启动后第一次核销往往就在
 * 初始化窗口内，如果直接丢弃，核销员会以为播报坏了。
 */
class Speaker(context: Context) {

    private companion object {
        const val TAG = "Speaker"
        const val UTTERANCE_ID = "canteen_verify"
    }

    private var tts: TextToSpeech? = null

    /** TTS 是否已就绪 */
    @Volatile
    private var ready = false

    /** 就绪前收到的播报请求，按顺序暂存 */
    private val pending = ArrayDeque<String>()

    @Volatile
    private var initFailed = false

    init {
        tts = TextToSpeech(context.applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                configureLanguage()
                ready = true
                flushPending()
            } else {
                initFailed = true
                Log.w(TAG, "TTS 初始化失败，语音播报将不可用（不影响核销）")
                pending.clear()
            }
        }
    }

    /**
     * 设置中文发音。
     *
     * 优先 zh-CN；不可用时退回 zh；再不行就退回默认 Locale。
     * 设备没装中文语音包的情况真实存在（部分精简 ROM），
     * 这时用英文引擎念中文会念不出来 —— 但也不能因此让播报流程报错，
     * 所以只降级、不抛异常。
     */
    private fun configureLanguage() {
        val engine = tts ?: return
        try {
            val cn = Locale.SIMPLIFIED_CHINESE
            val result = engine.setLanguage(cn)
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                Log.w(TAG, "缺少中文语音包，尝试 zh")
                val zh = Locale.CHINESE
                val r2 = engine.setLanguage(zh)
                if (r2 == TextToSpeech.LANG_MISSING_DATA || r2 == TextToSpeech.LANG_NOT_SUPPORTED) {
                    Log.w(TAG, "中文语音包不可用，退回系统默认语言")
                    engine.setLanguage(Locale.getDefault())
                }
            }
            // 语速略快一点：核销排队时，播报越快越不占时间
            engine.setSpeechRate(1.05f)
            engine.setPitch(1.0f)
        } catch (e: Exception) {
            Log.w(TAG, "配置 TTS 语言失败：${e.message}")
        }
    }

    /**
     * 播报一句话。
     *
     * 用 QUEUE_FLUSH 而不是 QUEUE_ADD：连续扫两个人时，
     * 我们想听的是**最新一次**的结果，而不是把队列念完 ——
     * 念到第三个时人已经走了。
     */
    fun speak(text: String) {
        val content = text.trim()
        if (content.isEmpty()) return

        if (initFailed) return

        if (!ready) {
            // 最多积压 3 条，避免异常情况下无限增长
            if (pending.size < 3) pending.addLast(content)
            return
        }
        doSpeak(content)
    }

    private fun flushPending() {
        while (pending.isNotEmpty()) {
            pending.removeFirst().let { doSpeak(it) }
        }
    }

    private fun doSpeak(content: String) {
        try {
            tts?.speak(content, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE_ID)
            Log.d(TAG, "播报：$content")
        } catch (e: Exception) {
            Log.w(TAG, "播报失败：${e.message}")
        }
    }

    /**
     * 释放引擎。
     *
     * 必须在 Activity onDestroy 调用：TTS 引擎是**跨进程**的共享资源，
     * 不释放会导致它常驻占用音频通道，其他 App 放音乐会没声音。
     */
    fun release() {
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (e: Exception) {
            // 忽略：释放阶段出错不影响用户
        } finally {
            tts = null
            ready = false
            pending.clear()
        }
    }
}
