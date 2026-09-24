package com.canteen.scan.net

/**
 * 后端统一响应包装：{ code, message, data }
 *
 * 与 backend/src/modules/common/interceptors/response.interceptor.ts 一一对应。
 * code = 0 表示成功，其余为业务错误（BizCode）。
 *
 * data 用泛型而不是 Any：调用方拿到的就是具体类型，
 * 不必在每个使用点做一次强制转换。
 */
data class ApiResponse<T>(
    val code: Int,
    val message: String?,
    val data: T?,
)

/**
 * 业务错误码。
 *
 * **必须与 backend/src/modules/common/biz-code.ts 保持一致** ——
 * 后端新增码时这里要同步加，否则 App 落到 else 分支只能显示
 * 后端给的 message（可读但缺少"该怎么办"的引导）。
 *
 * 只列核销链路上会遇到的码，不把 16 个码全搬过来：
 * 用不到的定义在这里只会让人以为它会出现。
 */
object BizCode {
    const val OK = 0

    /** 参数校验失败 */
    const val BAD_REQUEST = 1003

    /** 未登录 / token 失效（设备通道用不到，保留以防后端调整鉴权） */
    const val UNAUTHORIZED = 1001
    const val FORBIDDEN = 1002

    /** 二维码无效 / 过期 / 已使用 */
    const val QR_INVALID = 2001

    /** 公司剩余次数不足 —— 要找平台管理员充值 */
    const val QUOTA_EXHAUSTED = 2002

    /** 重复核销（并发同时到达时才会出现） */
    const val DUPLICATE_VERIFY = 2003

    /** 员工或公司已停用 */
    const val ACCOUNT_DISABLED = 2004

    /** 不在可核销时段 / 时段内次数已用完 —— 注意：message 里带具体时段提示 */
    const val OUT_OF_WINDOW = 2005

    /** 设备密钥无效或已失效 —— 换绑密钥的触发条件 */
    const val DEVICE_INVALID = 2006

    /** 员工个人次数用完 —— 要找公司管理员加次数（与 2002 处置动作不同） */
    const val EMPLOYEE_QUOTA_EXHAUSTED = 2007
}

/**
 * 核销失败原因的分类。
 *
 * 为什么要分类而不是直接显示 message：
 * 一线核销员遇到失败时，需要的是**下一步该做什么**，
 * 而不是一句业务描述。"次数不足"他自己解决不了，
 * 得知道是"让员工找公司管理员"还是"找平台充值"。
 */
enum class FailKind {
    /** 二维码问题：让员工刷新小程序重新出示 */
    QR,

    /** 时段问题：现在不能核销，告知员工可核销时间 */
    WINDOW,

    /** 员工个人次数用完：让员工找公司管理员加次数 */
    EMPLOYEE_QUOTA,

    /** 公司次数不足：需要联系平台管理员充值 */
    COMPANY_QUOTA,

    /** 员工/公司已停用：联系公司管理员 */
    DISABLED,

    /** 设备密钥失效：核销员需要重新绑定 */
    DEVICE,

    /** 重复核销：这张码已经用过了 */
    DUPLICATE,

    /** 网络/服务器异常 */
    NETWORK,

    /** 其他 */
    OTHER,
}

/**
 * 把业务码映射成失败分类。
 *
 * 顺带产出给核销员看的引导语 —— 与后端 message 分开：
 * message 描述"发生了什么"，引导语说明"你该做什么"。
 */
object FailKindMapper {

    fun kindOf(code: Int): FailKind = when (code) {
        BizCode.QR_INVALID -> FailKind.QR
        BizCode.OUT_OF_WINDOW -> FailKind.WINDOW
        BizCode.EMPLOYEE_QUOTA_EXHAUSTED -> FailKind.EMPLOYEE_QUOTA
        BizCode.QUOTA_EXHAUSTED -> FailKind.COMPANY_QUOTA
        BizCode.ACCOUNT_DISABLED -> FailKind.DISABLED
        BizCode.DEVICE_INVALID -> FailKind.DEVICE
        BizCode.DUPLICATE_VERIFY -> FailKind.DUPLICATE
        else -> FailKind.OTHER
    }

    /** 给核销员的行动建议；返回 null 表示无需额外提示 */
    fun adviceOf(kind: FailKind): String? = when (kind) {
        FailKind.QR -> "请员工在小程序里刷新核销码后重新出示"
        FailKind.WINDOW -> "当前不在用餐时段，请按上方时间再来"
        FailKind.EMPLOYEE_QUOTA -> "该员工个人次数已用完，需联系公司管理员增加次数"
        FailKind.COMPANY_QUOTA -> "公司剩余次数不足，需联系平台管理员充值"
        FailKind.DISABLED -> "该员工或公司已停用，请联系公司管理员"
        FailKind.DEVICE -> "本机设备密钥已失效，请重新绑定新密钥"
        FailKind.DUPLICATE -> "这张码刚刚已经核销过了，请勿重复操作"
        FailKind.NETWORK -> "请确认手机已连接食堂 WiFi 后重试"
        FailKind.OTHER -> null
    }
}
