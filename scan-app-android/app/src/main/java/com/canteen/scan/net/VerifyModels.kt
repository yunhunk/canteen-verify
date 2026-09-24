package com.canteen.scan.net

import com.google.gson.annotations.SerializedName

/**
 * 核销接口的响应数据。
 *
 * 字段与 backend/src/modules/verify/verify.service.ts 的 VerifyResult 一一对应。
 * 用 @SerializedName 显式标注而不依赖字段名推断：后端若用驼峰以外的命名，
 * 或将来加了同义字段，显式标注能立刻暴露不匹配，而不是静默读到 null。
 */
data class VerifyResult(
    @SerializedName("success") val success: Boolean,

    @SerializedName("consumptionId") val consumptionId: String?,

    @SerializedName("employeeId") val employeeId: String?,

    /** 员工姓名 —— 成功页要显示"给谁核销的" */
    @SerializedName("employeeName") val employeeName: String?,

    @SerializedName("companyId") val companyId: String?,

    @SerializedName("storeId") val storeId: String?,

    @SerializedName("storeName") val storeName: String?,

    @SerializedName("verifyTime") val verifyTime: String?,

    /** 公司剩余总次数 */
    @SerializedName("remainQuota") val remainQuota: Int?,

    /** 员工个人额度总数；null = 公司未设限 */
    @SerializedName("employeeQuotaTotal") val employeeQuotaTotal: Int?,

    @SerializedName("employeeQuotaUsed") val employeeQuotaUsed: Int?,

    /** 员工个人剩余次数；null = 不限制 */
    @SerializedName("employeeQuotaRemain") val employeeQuotaRemain: Int?,

    /** 公司餐标（元）；null = 未设置 */
    @SerializedName("mealStandard") val mealStandard: Double?,

    /**
     * 语音播报文本，形如 `核销成功，餐标15元`。
     *
     * **直接念这个字符串，不要在客户端拼** —— 服务端已经处理了
     * "有没有餐标""金额去尾零"这些细节。客户端一旦自己拼，
     * 就等于把业务规则复制到每一台设备上，改口径时要挨个升级 APK。
     */
    @SerializedName("voiceText") val voiceText: String?,

    /** 命中的时段信息；公司未配规则时为 null */
    @SerializedName("window") val window: WindowInfo?,
) {
    data class WindowInfo(
        @SerializedName("name") val name: String?,
        @SerializedName("text") val text: String?,
        @SerializedName("limit") val limit: Int?,
        @SerializedName("used") val used: Int?,
        /** null = 该时段不限次数 */
        @SerializedName("remain") val remain: Int?,
    )
}

/** 核销请求体，对应 DeviceVerifyDto */
data class VerifyRequest(
    /**
     * 一机一密钥。
     *
     * 只发 deviceKey，**不发 deviceToken**：后端那条旧的全局密钥通道
     * 需 ALLOW_LEGACY_DEVICE_TOKEN=1 才放行，生产本就该关闭。
     * 客户端主动不用它，等于少留一条被滥用的路径。
     */
    @SerializedName("deviceKey") val deviceKey: String,

    /** 员工核销码里的 token */
    @SerializedName("qrToken") val qrToken: String,

    /**
     * 门店 id。
     *
     * 设备若已在后台绑定了门店，后端**会忽略这个字段**（以设备绑定为准）。
     * 这里仍然带上，是为了兼容"设备未绑店、由扫码端选店"的用法。
     */
    @SerializedName("storeId") val storeId: String? = null,
)
