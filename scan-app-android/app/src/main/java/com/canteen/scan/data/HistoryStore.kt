package com.canteen.scan.data

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * 本机核销记录。
 *
 * **只存本机扫过的**，不是服务端的全量记录 —— 完整数据在管理后台看。
 * 保留这个本地列表的用途是：交班时核销员想核对"我刚才扫了哪些人"，
 * 而翻后台要登录、要筛选，太重。
 *
 * 上限 200 条，超出丢最旧的：这是给核销员随手回看的，
 * 不是审计数据（审计数据在服务端 operation_logs 和 consumptions 里）。
 */
class HistoryStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)

    private val gson = Gson()

    /** 读取全部记录，最新的在前 */
    fun load(): MutableList<HistoryItem> {
        val json = prefs.getString(KEY_ITEMS, null) ?: return mutableListOf()
        return try {
            val type = object : TypeToken<List<HistoryItem>>() {}.type
            val list: List<HistoryItem> = gson.fromJson(json, type) ?: emptyList()
            list.toMutableList()
        } catch (e: Exception) {
            // 数据损坏时宁可丢弃本地记录，也不能让页面打不开 ——
            // 本地记录本就是可再生的辅助信息
            mutableListOf()
        }
    }

    /** 追加一条记录（插到最前，并裁剪到上限） */
    fun append(item: HistoryItem) {
        val list = load()
        list.add(0, item)
        val trimmed = if (list.size > MAX_ITEMS) list.subList(0, MAX_ITEMS) else list
        prefs.edit().putString(KEY_ITEMS, gson.toJson(trimmed)).apply()
    }

    /** 清空本机记录 */
    fun clear() {
        prefs.edit().remove(KEY_ITEMS).apply()
    }

    companion object {
        private const val PREF_NAME = "canteen_scan_history"
        private const val KEY_ITEMS = "items"
        private const val MAX_ITEMS = 200
    }
}

/** 一条本机核销记录 */
data class HistoryItem(
    /** 核销发生时间（本机时刻，毫秒） */
    val timestamp: Long,
    val success: Boolean,
    /** 员工姓名；失败时可能为 null（还没走到识别员工那一步） */
    val employeeName: String?,
    /** 结果文案：成功时是"核销成功"，失败时是后端 message */
    val message: String,
    /** 餐标，仅成功时有 */
    val mealStandard: Double?,
    val storeName: String?,
    /** 消费记录 id，仅成功时有，可用于与后端对账 */
    val consumptionId: String?,
)
