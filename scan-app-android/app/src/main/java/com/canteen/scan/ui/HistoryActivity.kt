package com.canteen.scan.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.canteen.scan.R
import com.canteen.scan.ScanApp
import com.canteen.scan.data.HistoryItem
import com.canteen.scan.databinding.ActivityHistoryBinding
import com.canteen.scan.databinding.ItemHistoryBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 本机核销记录。
 *
 * 定位是"交班核对"工具，不是审计报表：只显示本机扫过的、
 * 最多 200 条，不进服务端。完整数据在管理后台。
 *
 * 界面上刻意不做搜索和筛选 —— 核销员一次交班通常几十到一百多单，
 * 时间倒序翻两屏就能找到，加筛选反而增加操作步骤。
 */
class HistoryActivity : AppCompatActivity() {

    private lateinit var binding: ActivityHistoryBinding
    private lateinit var adapter: HistoryAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityHistoryBinding.inflate(layoutInflater)
        setContentView(binding.root)

        supportActionBar?.title = getString(R.string.history_title)

        adapter = HistoryAdapter(emptyList())
        binding.recycler.layoutManager = LinearLayoutManager(this)
        binding.recycler.adapter = adapter

        binding.btnClear.setOnClickListener {
            AlertDialog.Builder(this)
                .setMessage(R.string.history_clear_confirm)
                .setNegativeButton(R.string.common_cancel, null)
                .setPositiveButton(R.string.common_confirm) { _, _ ->
                    ScanApp.from(this).historyStore.clear()
                    refresh()
                }
                .show()
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val items = ScanApp.from(this).historyStore.load()
        adapter.submit(items)

        val empty = items.isEmpty()
        binding.emptyPanel.visibility = if (empty) View.VISIBLE else View.GONE
        binding.recycler.visibility = if (empty) View.GONE else View.VISIBLE
        // 没有记录时"清空"按钮没有意义，隐藏掉
        binding.btnClear.visibility = if (empty) View.GONE else View.VISIBLE
    }
}

class HistoryAdapter(
    private var items: List<HistoryItem>,
) : RecyclerView.Adapter<HistoryAdapter.VH>() {

    private val timeFmt = SimpleDateFormat("MM-dd HH:mm", Locale.CHINA)

    fun submit(list: List<HistoryItem>) {
        items = list
        notifyDataSetChanged()
    }

    class VH(val binding: ItemHistoryBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val binding = ItemHistoryBinding.inflate(
            LayoutInflater.from(parent.context), parent, false,
        )
        return VH(binding)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val item = items[position]
        val b = holder.binding
        val ctx = b.root.context

        // 成功绿、失败红，与结果页同一套色，形成一致的心智
        b.statusBar.setBackgroundColor(
            ContextCompat.getColor(ctx, if (item.success) R.color.success else R.color.danger),
        )

        b.tvName.text = item.employeeName?.takeIf { it.isNotBlank() }
            ?: if (item.success) ctx.getString(R.string.history_unknown_employee)
            else ctx.getString(R.string.result_fail)

        b.tvTime.text = timeFmt.format(Date(item.timestamp))
        b.tvMessage.text = item.message

        // 元信息：门店 + 消费记录 id 尾号，便于和后端对账时定位
        val meta = buildList {
            item.storeName?.takeIf { it.isNotBlank() }?.let { add(it) }
            item.consumptionId?.takeLast(6)?.let { add("#$it") }
        }.joinToString(" · ")

        if (meta.isBlank()) {
            b.tvMeta.visibility = View.GONE
        } else {
            b.tvMeta.visibility = View.VISIBLE
            b.tvMeta.text = meta
        }
    }
}
