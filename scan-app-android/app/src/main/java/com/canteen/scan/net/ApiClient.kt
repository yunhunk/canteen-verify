package com.canteen.scan.net

import android.util.Log
import com.canteen.scan.BuildConfig
import com.google.gson.Gson
import com.google.gson.JsonSyntaxException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 核销 API 客户端。
 *
 * 设计取舍：
 * - 只用 OkHttp + Gson，不引入 Retrofit/Coroutines-adapter。
 *   核销链路只有两个接口，多一层框架只会让"为什么这个请求没发出去"更难查。
 * - 超时给到 15 秒：食堂 WiFi 常有高延迟，5 秒会误报网络异常，
 *   让核销员以为没成功、重复扫一次，反而制造麻烦。
 */
object ApiClient {

    private const val TAG = "ApiClient"

    private val gson = Gson()

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            // 核销是"一发一收"的短请求，不重试：
            // 网络层自动重试可能让一个已经成功的核销再发一次，
            // 虽然后端有防重（占位），但徒增日志噪音和一线困惑。
            .retryOnConnectionFailure(false)
            .build()
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    /**
     * 核销。
     *
     * 返回 [ApiResponse]，成功与业务失败都以正常返回值表达；
     * 只有网络层异常才抛 [ApiException.Network]，由调用方转成统一失败卡片。
     *
     * 为什么不把业务失败也做成异常：
     * 核销失败是**预期内的高频路径**（不在时段、次数用完都会天天发生），
     * 用异常表达会让正常流程被 try/catch 包起来，代码读起来像在处理意外。
     */
    suspend fun verify(request: VerifyRequest): ApiResponse<VerifyResult> =
        post("/api/device/verify", request, VerifyResult::class.java)

    /**
     * 校验设备密钥是否有效。
     *
     * 实现方式：拿一个明显不存在的二维码 token 去打核销接口，
     * 然后看返回的**错误码类型**：
     * - 2006（DEVICE_INVALID）→ 密钥无效
     * - 其他任何码（2001 二维码无效等）→ 说明密钥这关过了
     *
     * 为什么不新增一个专门的校验接口：设备校验是设备身份的事，
     * 为一个"绑定前试探"加接口，等于给攻击者多一个可暴力猜测的端点。
     * 复用核销接口既不加攻击面，也不用改后端。
     *
     * 代价：这个试探会留下一条 verify_reject 操作日志。
     * 可以接受 —— 它记录的正是"有人用某密钥尝试核销"，
     * 而绑定失败恰恰是值得留痕的事件。
     */
    suspend fun checkDeviceKey(deviceKey: String): DeviceKeyCheck {
        val resp = verify(
            VerifyRequest(
                deviceKey = deviceKey,
                qrToken = "__key_probe__",
                storeId = null,
            ),
        )
        return when (resp.code) {
            BizCode.DEVICE_INVALID -> DeviceKeyCheck.Invalid(resp.message)
            else -> DeviceKeyCheck.Valid
        }
    }

    /**
     * 发起 POST 请求并解析统一响应包。
     *
     * 解析策略刻意宽松：
     * - HTTP 状态码只看"能不能读到 JSON"。后端业务失败会给 4xx，
     *   但 body 里带着业务码和可读 message，这才是我们要的信息。
     *   若把 4xx 一律当异常，就会丢掉这些 message，只能显示"请求失败"。
     * - 只有连 JSON 都解析不出来（网关 502、被劫持的 HTML）才当网络异常。
     */
    private suspend fun <T> post(
        path: String,
        body: Any,
        dataClass: Class<T>,
    ): ApiResponse<T> = withContext(Dispatchers.IO) {
        val url = BuildConfig.API_BASE.trimEnd('/') + path
        val json = gson.toJson(body)

        // 请求/响应日志只在 debug 包打：请求体里有设备密钥，
        // release 包带出去等于把设备身份留在 logcat 里，谁拿手机都能捞到
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "POST $url body=$json")
        }

        val request = Request.Builder()
            .url(url)
            .post(json.toRequestBody(jsonMediaType))
            .header("Accept", "application/json")
            .build()

        val rawText: String = try {
            client.newCall(request).execute().use { response ->
                response.body?.string().orEmpty()
            }
        } catch (e: IOException) {
            Log.w(TAG, "网络异常: ${e.message}")
            throw ApiException.Network(e)
        }

        if (rawText.isBlank()) {
            throw ApiException.Network(IOException("响应为空"))
        }

        if (BuildConfig.DEBUG) {
            Log.d(TAG, "resp=$rawText")
        }

        try {
            @Suppress("UNCHECKED_CAST")
            val wrapper = gson.fromJson(rawText, ApiResponse::class.java) as ApiResponse<*>
            val code = wrapper.code
            val message = wrapper.message
            val data: T? = if (wrapper.data == null) {
                null
            } else {
                // 先按原始 JsonElement 挂回来第二次解析成具体类型。
                // 直接让 Gson 一次性反序列化泛型需要 TypeToken，
                // 而 TypeToken 在运行时拼 Class 很别扭，分两步更直白。
                gson.fromJson(gson.toJson(wrapper.data), dataClass)
            }
            ApiResponse(code, message, data)
        } catch (e: JsonSyntaxException) {
            Log.w(TAG, "响应不是合法 JSON: ${rawText.take(200)}")
            throw ApiException.Network(IOException("服务器返回异常，请检查后端地址是否正确"))
        }
    }
}

/** 设备密钥校验结果 */
sealed interface DeviceKeyCheck {
    /** 密钥有效 */
    data object Valid : DeviceKeyCheck

    /** 密钥无效，附带后端给的原因 */
    data class Invalid(val message: String?) : DeviceKeyCheck
}

/** 网络层异常（区别于业务失败） */
sealed class ApiException(message: String) : Exception(message) {
    /** 连不上 / 超时 / 响应不是合法 JSON */
    class Network(cause: Throwable) : ApiException(cause.message ?: "网络异常")
}
