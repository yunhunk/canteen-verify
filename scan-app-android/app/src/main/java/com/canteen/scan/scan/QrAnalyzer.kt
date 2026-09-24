package com.canteen.scan.scan

import android.annotation.SuppressLint
import android.util.Log
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

/**
 * CameraX 图像分析器：逐帧交给 ML Kit 识别二维码。
 *
 * 三个必须处理对的点：
 *
 * 1. **旋转信息**。ImageProxy 传的是 sensor 坐标系的原始帧，
 *    竖屏手机拿到的帧通常是旋转 90° 的。不把 rotationDegrees 传给 ML Kit，
 *    二维码会横躺着永远识别不出来 —— 这是接 CameraX + ML Kit 最常踩的坑。
 *
 * 2. **只识别我们需要的格式**。指定 QR_CODE 而不扫全部格式：
 *    ML Kit 内部对每种格式都要跑一遍检测，限定了能明显降低单帧耗时。
 *
 * 3. **同一帧只上报一次**。识别回调可能对同一次检测触发多次（多个码），
 *    用 reported 门闩保证交给上层去重的只有一个值。
 */
class QrAnalyzer(
    private val onQrDetected: (String) -> Unit,
) : ImageAnalysis.Analyzer {

    private companion object {
        const val TAG = "QrAnalyzer"
    }

    /**
     * 只扫二维码。
     *
     * 不加 FORMAT_EAN_13 之类的商品码：食堂场景只会出现小程序生成的二维码，
     * 放开格式会让贴着商品条码的餐盘、饮料瓶被误识别成核销码。
     */
    private val scanner: BarcodeScanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build(),
    )

    /** 本次检测是否已经上报过 —— 避免同一张码连发多次 */
    @Volatile
    private var reported = false

    /** 外部在处理完一次核销后调用，重新武装分析器 */
    fun reset() {
        reported = false
    }

    @SuppressLint("UnsafeOptInUsageError")
    override fun analyze(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }

        // 已上报过就跳过这帧，但**必须 close**，
        // 否则 ImageAnalysis 的缓冲池很快耗尽，预览会卡死
        if (reported) {
            imageProxy.close()
            return
        }

        // 第 1 个坑：rotationDegrees 必须传，否则横竖颠倒识别不到
        val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)

        scanner.process(image)
            .addOnSuccessListener { barcodes ->
                if (reported) return@addOnSuccessListener

                val value = barcodes
                    .firstOrNull { it.format == Barcode.FORMAT_QR_CODE }
                    ?.rawValue
                    ?.trim()

                if (!value.isNullOrEmpty()) {
                    reported = true
                    Log.d(TAG, "识别到二维码：${value.take(12)}…")
                    onQrDetected(value)
                }
            }
            .addOnFailureListener { e ->
                // 单帧识别失败是常态（模糊、反光），不该打断扫码流程，
                // 也不该刷日志把真正的问题淹掉
                Log.v(TAG, "单帧识别失败：${e.message}")
            }
            .addOnCompleteListener {
                // 无论成功失败都要关闭，否则缓冲池耗尽
                imageProxy.close()
            }
    }

    /** 页面销毁时释放 ML Kit 客户端 */
    fun close() {
        try {
            scanner.close()
        } catch (e: Exception) {
            Log.w(TAG, "释放 scanner 失败：${e.message}")
        }
    }
}
