package com.canteen.scan.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.animation.Animation
import android.view.animation.LinearInterpolator
import android.view.animation.TranslateAnimation
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.canteen.scan.R
import com.canteen.scan.ScanApp
import com.canteen.scan.data.HistoryItem
import com.canteen.scan.databinding.ActivityScanBinding
import com.canteen.scan.net.ApiClient
import com.canteen.scan.net.ApiException
import com.canteen.scan.net.BizCode
import com.canteen.scan.net.FailKind
import com.canteen.scan.net.FailKindMapper
import com.canteen.scan.net.VerifyRequest
import com.canteen.scan.scan.Haptics
import com.canteen.scan.scan.QrAnalyzer
import com.canteen.scan.scan.Speaker
import kotlinx.coroutines.launch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 扫码核销主界面。
 *
 * 核心循环：识别到二维码 → 立刻停止识别（防重复提交）→ 调核销接口 →
 * 播报 + 震动 → 跳结果页 → 回来后重新武装识别器。
 *
 * 三个关键设计：
 *
 * 1. **识别到即停**。识别器一旦上报就置 reported 门闩，
 *    后续帧直接丢弃。否则一次扫码会连发十几次请求 ——
 *    后端虽然后端有防重（Redis 占位），但十几个请求打过去
 *    既浪费流量，又会让"失败"和"重复"两种返回混在一起难以判断。
 *
 * 2. **结果页而非 Toast**。核销结果需要展示员工姓名、餐标、剩余次数，
 *    这些信息核销员要能看清、必要时念给员工听。Toast 一闪而过做不到。
 *
 * 3. **失败不自动返回，成功才自动返回**。失败时核销员需要读原因、
 *    和员工解释，自动跳走会让他来不及看；成功则没什么好停留的。
 */
class ScanActivity : AppCompatActivity() {

    private companion object {
        const val TAG = "ScanActivity"
    }

    private lateinit var binding: ActivityScanBinding
    private lateinit var cameraExecutor: ExecutorService
    private lateinit var analyzer: QrAnalyzer
    private var speaker: Speaker? = null

    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: androidx.camera.core.Camera? = null
    private var lensFacing = CameraSelector.LENS_FACING_BACK
    private var torchOn = false

    /** 是否正在处理一次核销 —— 防连点与重复上报。
     *  收敛到主线程后所有读写都在主线程；@Volatile 只是给未来
     *  可能的跨线程访问留一道保险，成本为零。 */
    @Volatile
    private var processing = false

    /** 本次会话（App 启动以来）成功核销的笔数，顶部展示 */
    private var sessionCount = 0

    /** 相机权限请求 */
    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            binding.permissionPanel.visibility = View.GONE
            startCamera()
        } else {
            binding.permissionPanel.visibility = View.VISIBLE
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityScanBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 屏幕常亮：核销员连续举机扫码，自动熄屏会打断工作流。
        // 用 FLAG 而不是 manifest 的 keepScreenOn —— 那是 View 属性，
        // 写在 <activity> 上无效。
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        cameraExecutor = Executors.newSingleThreadExecutor()
        analyzer = QrAnalyzer { qrToken -> onQrDetected(qrToken) }
        speaker = Speaker(this)

        // 未绑定设备密钥时不该出现在这里（启动页已分流），
        // 但热重载/异常路径下仍可能发生，兜一道底
        val store = ScanApp.from(this).deviceStore
        if (!store.isBound) {
            startActivity(Intent(this, BindActivity::class.java))
            finish()
            return
        }

        binding.tvStoreName.text = store.storeName?.takeIf { it.isNotBlank() }
            ?: getString(R.string.scan_store_unbound)

        binding.btnManual.setOnClickListener { showManualInput() }
        binding.btnHistory.setOnClickListener {
            startActivity(Intent(this, HistoryActivity::class.java))
        }
        binding.btnTorch.setOnClickListener { toggleTorch() }
        binding.btnSwitchCamera.setOnClickListener { switchCamera() }
        binding.btnGrant.setOnClickListener {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }

        startScanLineAnimation()
        updateSessionCount()

        if (hasCameraPermission()) {
            startCamera()
        } else {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onResume() {
        super.onResume()
        // 从结果页/记录页回来：重新武装识别器，恢复扫码能力
        processing = false
        analyzer.reset()
        binding.processingOverlay.visibility = View.GONE
        binding.tvStoreName.text = ScanApp.from(this).deviceStore.storeName
            ?.takeIf { it.isNotBlank() }
            ?: getString(R.string.scan_store_unbound)
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraProvider?.unbindAll()
        analyzer.close()
        cameraExecutor.shutdown()
        // TTS 是跨进程共享资源，必须释放，否则会占着音频通道
        speaker?.release()
    }

    // ---------------------------------------------------------------
    // 相机
    // ---------------------------------------------------------------

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                val provider = future.get()
                cameraProvider = provider

                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(binding.previewView.surfaceProvider)
                }

                val analysis = ImageAnalysis.Builder()
                    // 只保留最新帧：核销场景下不需要处理积压的旧帧，
                    // 保留最新能显著降低"扫到了但延时很高"的体感
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also { it.setAnalyzer(cameraExecutor, analyzer) }

                val selector = CameraSelector.Builder()
                    .requireLensFacing(lensFacing)
                    .build()

                provider.unbindAll()
                camera = provider.bindToLifecycle(this, selector, preview, analysis)

                // 切换/重建相机后补光状态重置，同步一下按钮图标
                torchOn = false
                updateTorchIcon()
            } catch (e: Exception) {
                Toast.makeText(
                    this,
                    getString(R.string.scan_camera_failed, e.message ?: ""),
                    Toast.LENGTH_LONG,
                ).show()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun switchCamera() {
        lensFacing = if (lensFacing == CameraSelector.LENS_FACING_BACK) {
            CameraSelector.LENS_FACING_FRONT
        } else {
            CameraSelector.LENS_FACING_BACK
        }
        // 前置摄像头一般没有闪光灯：这里只重置补光状态，
        // 真按下补光按钮时 toggleTorch 会因 hasFlashUnit()=false 提示"无补光"
        torchOn = false
        startCamera()
    }

    private fun toggleTorch() {
        val cam = camera
        if (cam == null || !cam.cameraInfo.hasFlashUnit()) {
            Toast.makeText(this, R.string.scan_no_torch, Toast.LENGTH_SHORT).show()
            return
        }
        torchOn = !torchOn
        cam.cameraControl.enableTorch(torchOn)
        updateTorchIcon()
    }

    private fun updateTorchIcon() {
        binding.btnTorch.setImageResource(
            if (torchOn) R.drawable.ic_torch_on else R.drawable.ic_torch_off,
        )
    }

    /** 扫描线上下往复动画。用 TranslateAnimation 而不是属性动画：
     *  这是个纯装饰效果，不需要在动画过程中读值。 */
    private fun startScanLineAnimation() {
        val travel = resources.getDimensionPixelSize(R.dimen.scan_frame_size) - 4
        val anim = TranslateAnimation(0f, 0f, 0f, travel.toFloat()).apply {
            duration = 1800
            repeatCount = Animation.INFINITE
            repeatMode = Animation.REVERSE
            interpolator = LinearInterpolator()
        }
        binding.scanLine.startAnimation(anim)
    }

    // ---------------------------------------------------------------
    // 核销
    // ---------------------------------------------------------------

    private fun onQrDetected(qrToken: String) {
        // QrAnalyzer 在相机线程回调，必须先切回主线程再继续：
        // 后续 doVerify 的空密钥分支会直接摸 UI（Overlay / startActivity / finish），
        // 留在相机线程执行会抛 CalledFromWrongThreadException 崩掉核销页
        runOnUiThread {
            if (processing) return@runOnUiThread
            processing = true

            // 立即反馈"看到了"：短震一下，核销员不必盯着屏幕确认有没有扫上
            Haptics.detected(this)
            binding.processingOverlay.visibility = View.VISIBLE

            doVerify(qrToken)
        }
    }

    private fun doVerify(qrToken: String) {
        val store = ScanApp.from(this).deviceStore
        val deviceKey = store.deviceKey
        if (deviceKey.isNullOrBlank()) {
            processing = false
            binding.processingOverlay.visibility = View.GONE
            startActivity(Intent(this, BindActivity::class.java))
            finish()
            return
        }

        lifecycleScope.launch {
            try {
                val resp = ApiClient.verify(
                    VerifyRequest(
                        deviceKey = deviceKey,
                        qrToken = qrToken,
                        // 设备已绑店时后端会忽略这个值，以设备绑定为准
                        storeId = store.storeId,
                    ),
                )

                // 用局部变量替代 resp.data!!：data?.success == true 时
                // Kotlin 会智能转换为非空，不必留强制解包
                val data = resp.data
                if (resp.code == BizCode.OK && data?.success == true) {
                    onVerifySuccess(data)
                } else {
                    onVerifyFail(resp.code, resp.message)
                }
            } catch (e: ApiException.Network) {
                onNetworkFail()
            } catch (e: Exception) {
                // 防御兜底：任何意外异常都不能让核销页当场崩溃 ——
                // 柜台前 App 一崩，整条队伍都得停。按通用失败走结果页
                Log.w(TAG, "核销处理意外异常", e)
                onUnexpectedFail(e)
            }
        }
    }

    private fun onVerifySuccess(data: com.canteen.scan.net.VerifyResult) {
        // 播报**后端给的整句**，客户端不拼接任何业务文案
        val voice = data.voiceText?.takeIf { it.isNotBlank() } ?: "核销成功"
        speaker?.speak(voice)
        Haptics.success(this)

        sessionCount++
        updateSessionCount()

        // 门店信息回填本地：设备绑店时首次核销后才知道自己在哪个店
        if (!data.storeName.isNullOrBlank()) {
            ScanApp.from(this).deviceStore.storeName = data.storeName
            binding.tvStoreName.text = data.storeName
        }

        ScanApp.from(this).historyStore.append(
            HistoryItem(
                timestamp = System.currentTimeMillis(),
                success = true,
                employeeName = data.employeeName,
                message = voice,
                mealStandard = data.mealStandard,
                storeName = data.storeName,
                consumptionId = data.consumptionId,
            ),
        )

        goToResult(success = true, result = data, rawCode = BizCode.OK, rawMessage = null)
    }

    private fun onVerifyFail(code: Int, message: String?) {
        val kind = FailKindMapper.kindOf(code)
        val text = message?.takeIf { it.isNotBlank() } ?: getString(R.string.common_unknown_error)
        val advice = FailKindMapper.adviceOf(kind)

        // 失败播报：后端只给成功播报文本，失败这里给一句短的，
        // 让排队的员工立刻知道"这次没过"，不必等核销员解释
        speaker?.speak(if (kind == FailKind.WINDOW) "不在用餐时段" else "核销失败")
        Haptics.fail(this)

        ScanApp.from(this).historyStore.append(
            HistoryItem(
                timestamp = System.currentTimeMillis(),
                success = false,
                employeeName = null,
                message = text,
                mealStandard = null,
                storeName = ScanApp.from(this).deviceStore.storeName,
                consumptionId = null,
            ),
        )

        // 密钥失效是最需要当场处理的一类：直接弹窗引导重新绑定
        if (kind == FailKind.DEVICE) {
            ScanApp.from(this).deviceStore.clear()
            AlertDialog.Builder(this)
                .setTitle(R.string.result_device_invalid_title)
                .setMessage(getString(R.string.result_device_invalid_body, text))
                .setCancelable(false)
                .setPositiveButton(R.string.result_device_invalid_action) { _, _ ->
                    startActivity(Intent(this, BindActivity::class.java))
                    finish()
                }
                .show()
            return
        }

        goToResult(
            success = false,
            result = null,
            rawCode = code,
            rawMessage = text,
            advice = advice,
        )
    }

    private fun onNetworkFail() {
        speaker?.speak("网络异常")
        Haptics.fail(this)

        ScanApp.from(this).historyStore.append(
            HistoryItem(
                timestamp = System.currentTimeMillis(),
                success = false,
                employeeName = null,
                message = getString(R.string.common_network_error),
                mealStandard = null,
                storeName = ScanApp.from(this).deviceStore.storeName,
                consumptionId = null,
            ),
        )

        goToResult(
            success = false,
            result = null,
            rawCode = -1,
            rawMessage = getString(R.string.common_network_error),
            advice = FailKindMapper.adviceOf(FailKind.NETWORK),
        )
    }

    /** 意外异常的兜底失败：播报 + 记录 + 走结果页，保证流程闭环。
     *  与 onNetworkFail 分开：原因不同，提示与建议也不同。 */
    private fun onUnexpectedFail(e: Exception) {
        speaker?.speak("核销失败")
        Haptics.fail(this)

        val text = e.message?.takeIf { it.isNotBlank() }
            ?: getString(R.string.common_unknown_error)

        ScanApp.from(this).historyStore.append(
            HistoryItem(
                timestamp = System.currentTimeMillis(),
                success = false,
                employeeName = null,
                message = text,
                mealStandard = null,
                storeName = ScanApp.from(this).deviceStore.storeName,
                consumptionId = null,
            ),
        )

        goToResult(
            success = false,
            result = null,
            rawCode = -2,
            rawMessage = text,
            advice = FailKindMapper.adviceOf(FailKind.OTHER),
        )
    }

    /** 跳结果页。用 startActivity 而非 Fragment：
     *  结果页需要独立于扫码页存在（返回后扫码页 onResume 会重新武装识别器），
     *  同一 Activity 内切 View 反而要手动管状态。 */
    private fun goToResult(
        success: Boolean,
        result: com.canteen.scan.net.VerifyResult?,
        rawCode: Int,
        rawMessage: String?,
        advice: String? = null,
    ) {
        val intent = Intent(this, ResultActivity::class.java).apply {
            putExtra(ResultActivity.EXTRA_SUCCESS, success)
            putExtra(ResultActivity.EXTRA_CODE, rawCode)
            putExtra(ResultActivity.EXTRA_MESSAGE, rawMessage)
            putExtra(ResultActivity.EXTRA_ADVICE, advice)
            result?.let { r ->
                putExtra(ResultActivity.EXTRA_EMPLOYEE, r.employeeName)
                putExtra(ResultActivity.EXTRA_STORE, r.storeName)
                putExtra(ResultActivity.EXTRA_VOICE, r.voiceText)
                // 数值字段可能是 null（未设额度/未设餐标）。
                // putExtra 的 int/double 重载不接受可空值 —— 传了编译不过；
                // 所以用"不传 = 未设置"的约定，结果页用 hasExtra 判断。
                r.mealStandard?.let { v -> putExtra(ResultActivity.EXTRA_MEAL, v) }
                r.employeeQuotaRemain?.let { v ->
                    putExtra(ResultActivity.EXTRA_QUOTA_REMAIN, v)
                }
                r.employeeQuotaTotal?.let { v ->
                    putExtra(ResultActivity.EXTRA_QUOTA_TOTAL, v)
                }
                r.window?.text?.let { t -> putExtra(ResultActivity.EXTRA_WINDOW_TEXT, t) }
            }
        }
        startActivity(intent)

        // 回到本页时 onResume 会重置 processing。
        // 但若用户从结果页直接按返回键回到这里，onResume 同样会执行重置 ——
        // 这正是我们要的：可以立刻扫下一个人。
        runOnUiThread { binding.processingOverlay.visibility = View.GONE }
    }

    private fun updateSessionCount() {
        binding.tvTodayCount.text = getString(R.string.scan_session_count, sessionCount)
    }

    // ---------------------------------------------------------------
    // 手动输入
    // ---------------------------------------------------------------

    /**
     * 手动输入核销码。
     *
     * 存在的意义：二维码是屏幕上的动态码，遇到员工手机屏幕碎屏、
     * 亮度极低、或贴了防窥膜时，扫码会反复失败。
     * 这时让员工把码念出来手输，比让一行人卡在窗口前强。
     */
    private fun showManualInput() {
        if (processing) return

        val input = EditText(this).apply {
            hint = getString(R.string.manual_hint)
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            setSingleLine()
        }
        val container = android.widget.FrameLayout(this).apply {
            setPadding(48, 16, 48, 0)
            addView(input)
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.manual_title)
            .setView(container)
            .setNegativeButton(R.string.common_cancel, null)
            .setPositiveButton(R.string.manual_submit) { _, _ ->
                val token = input.text?.toString()?.trim().orEmpty()
                if (token.isNotEmpty()) {
                    processing = true
                    binding.processingOverlay.visibility = View.VISIBLE
                    doVerify(token)
                }
            }
            .show()
    }
}
