package com.canteen.scan.ui

import android.content.Intent
import android.os.Bundle
import android.os.CountDownTimer
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import com.canteen.scan.R
import com.canteen.scan.databinding.ActivityResultBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 核销结果页。
 *
 * 设计上的两个不对称，都是刻意的：
 *
 * 1. **成功自动返回，失败不自动返回**。
 *    成功没什么好停留的，倒计时 4 秒自动回扫码页，避免核销员
 *    每次都要点一下"继续"（饭点一小时要扫上百次，这一步很烦）。
 *    失败则需要时间读原因、向员工解释，自动跳走会让核销员
 *    根本没看清为什么被拒。
 *
 * 2. **成功显示"谁 + 多少钱 + 剩几次"，失败显示"为什么 + 该找谁"**。
 *    两类页面回答的问题不同，硬套同一个模板会让两边都不好用。
 *
 * 倒计时在失败时不启动；用户点任意处可取消（见 tvAutoBack 点击）。
 */
class ResultActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_SUCCESS = "success"
        const val EXTRA_CODE = "code"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_ADVICE = "advice"
        const val EXTRA_EMPLOYEE = "employee"
        const val EXTRA_STORE = "store"
        const val EXTRA_MEAL = "meal"
        const val EXTRA_QUOTA_REMAIN = "quota_remain"
        const val EXTRA_QUOTA_TOTAL = "quota_total"
        const val EXTRA_VOICE = "voice"
        const val EXTRA_WINDOW_TEXT = "window_text"

        /** 成功页自动返回扫码的秒数 */
        private const val AUTO_BACK_SECONDS = 4
    }

    private lateinit var binding: ActivityResultBinding
    private var countDown: CountDownTimer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityResultBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val success = intent.getBooleanExtra(EXTRA_SUCCESS, false)

        if (success) {
            renderSuccess()
        } else {
            renderFail()
        }

        binding.btnPrimary.setOnClickListener { finish() }
        binding.btnHistory.setOnClickListener {
            cancelCountDown()
            startActivity(Intent(this, HistoryActivity::class.java))
        }
    }

    private fun renderSuccess() {
        binding.iconWrap.setBackgroundResource(R.drawable.bg_circle_success)
        binding.ivIcon.setImageResource(R.drawable.ic_check_circle)
        binding.tvTitle.setText(R.string.result_success)
        binding.tvTitle.setTextColor(getColor(R.color.success))

        binding.successCard.visibility = View.VISIBLE
        binding.failCard.visibility = View.GONE

        val employee = intent.getStringExtra(EXTRA_EMPLOYEE)?.takeIf { it.isNotBlank() }
        if (employee.isNullOrBlank()) {
            binding.tvEmployee.visibility = View.GONE
        } else {
            binding.tvEmployee.visibility = View.VISIBLE
            binding.tvEmployee.text = employee
        }

        // 餐标：null 表示公司未设置，显示"—"而不是"0 元"
        val meal = intent.getDoubleExtra(EXTRA_MEAL, Double.NaN)
        binding.tvMeal.text = if (meal.isNaN()) {
            getString(R.string.result_meal_unset)
        } else {
            getString(R.string.result_meal_value, formatYuan(meal))
        }

        // 剩余次数：扫码页只在员工确有额度时才放 EXTRA_QUOTA_TOTAL，
        // "没放 = 不限制"（公司或该员工未设额度）
        val hasQuota = intent.hasExtra(EXTRA_QUOTA_TOTAL)
        binding.tvQuota.text = if (!hasQuota) {
            getString(R.string.result_quota_unlimited)
        } else {
            val quotaRemain = intent.getIntExtra(EXTRA_QUOTA_REMAIN, 0)
            getString(R.string.result_quota_value, quotaRemain)
        }

        intent.getStringExtra(EXTRA_WINDOW_TEXT)?.takeIf { it.isNotBlank() }?.let {
            binding.tvWindow.visibility = View.VISIBLE
            binding.tvWindow.text = it
        }

        intent.getStringExtra(EXTRA_STORE)?.takeIf { it.isNotBlank() }?.let {
            binding.tvStore.text = getString(R.string.result_store_line, it)
        }

        binding.tvTime.text = getString(
            R.string.result_time_line,
            SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(Date()),
        )

        // 播报回显。员工说"我没听清"时，核销员可以直接把这句话念一遍，
        // 不用去猜机器刚才说了什么
        intent.getStringExtra(EXTRA_VOICE)?.takeIf { it.isNotBlank() }?.let {
            binding.tvVoice.visibility = View.VISIBLE
            binding.tvVoice.text = getString(R.string.result_spoken, it)
        }

        binding.btnPrimary.setText(R.string.result_continue)
        startCountDown()
    }

    private fun renderFail() {
        binding.iconWrap.setBackgroundResource(R.drawable.bg_circle_danger)
        binding.ivIcon.setImageResource(R.drawable.ic_close_circle)
        binding.tvTitle.setText(R.string.result_fail)
        binding.tvTitle.setTextColor(getColor(R.color.danger))

        binding.successCard.visibility = View.GONE
        binding.failCard.visibility = View.VISIBLE

        // 失败页没有员工姓名可展示，藏掉占位避免留一段空白
        binding.tvEmployee.visibility = View.GONE

        val message = intent.getStringExtra(EXTRA_MESSAGE)?.takeIf { it.isNotBlank() }
            ?: getString(R.string.common_unknown_error)
        binding.tvFailReason.text = message

        // 行动建议：这是失败页最有价值的部分 ——
        // 一线核销员需要的不是"业务码2005"，而是"现在该跟员工说什么"
        val advice = intent.getStringExtra(EXTRA_ADVICE)
        if (!advice.isNullOrBlank()) {
            binding.tvFailAdvice.visibility = View.VISIBLE
            binding.tvFailAdvice.text = advice
        } else {
            binding.tvFailAdvice.visibility = View.GONE
        }

        binding.btnPrimary.setText(R.string.result_continue)
        // 失败不自动返回：给核销员时间解释
        binding.tvAutoBack.visibility = View.GONE
    }

    private fun startCountDown() {
        binding.tvAutoBack.visibility = View.VISIBLE
        binding.tvAutoBack.text = getString(R.string.result_auto_back, AUTO_BACK_SECONDS)
        // 点一下倒计时文字即可取消自动返回 —— 核销员想多看两眼详情时用
        binding.tvAutoBack.setOnClickListener { cancelCountDown() }

        countDown = object : CountDownTimer(AUTO_BACK_SECONDS * 1000L, 1000L) {
            override fun onTick(millisUntilFinished: Long) {
                val sec = (millisUntilFinished / 1000).toInt() + 1
                binding.tvAutoBack.text = getString(R.string.result_auto_back, sec)
            }

            override fun onFinish() {
                finish()
            }
        }.start()
    }

    private fun cancelCountDown() {
        countDown?.cancel()
        countDown = null
        binding.tvAutoBack.visibility = View.GONE
    }

    override fun onDestroy() {
        super.onDestroy()
        // 必须取消：否则 Activity 已销毁而定时器还在跑，会泄漏
        countDown?.cancel()
        countDown = null
    }

    /** 去掉无意义的小数尾零：15.0 → "15"，15.5 → "15.5" */
    private fun formatYuan(value: Double): String {
        return if (value == value.toLong().toDouble()) {
            value.toLong().toString()
        } else {
            String.format(Locale.CHINA, "%.2f", value)
                .trimEnd('0')
                .trimEnd('.')
        }
    }
}
