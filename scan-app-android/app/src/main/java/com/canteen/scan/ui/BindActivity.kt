package com.canteen.scan.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.canteen.scan.BuildConfig
import com.canteen.scan.ScanApp
import com.canteen.scan.databinding.ActivityBindBinding
import com.canteen.scan.net.ApiClient
import com.canteen.scan.net.ApiException
import com.canteen.scan.net.DeviceKeyCheck
import kotlinx.coroutines.launch

/**
 * 绑定核销设备。
 *
 * 流程：输入设备密钥 → 调后端校验 →（有效）保存并进入扫码页。
 *
 * 关于门店：设备在后台「设备管理」里可以绑定门店。若已绑定，
 * 核销时的门店**以设备绑定为准**（后端 resolveStoreId 会忽略请求里的 storeId），
 * 所以这里不需要让核销员选门店 —— 让他选反而会制造"我选了 A 店，
 * 为什么记录落在 B 店"的困惑。门店信息由核销结果回传后展示。
 */
class BindActivity : AppCompatActivity() {

    private lateinit var binding: ActivityBindBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityBindBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 把当前后端地址显示出来：部署多套环境时，一眼能确认装的是哪套
        binding.tvApiBase.text = getString(
            com.canteen.scan.R.string.bind_help_title_api,
            BuildConfig.API_BASE,
        )

        // 已绑定时预填，便于"换密钥"时看清当前用的是哪把
        ScanApp.from(this).deviceStore.deviceKey?.let {
            binding.etDeviceKey.setText(it)
        }

        binding.btnBind.setOnClickListener { doBind() }
    }

    private fun doBind() {
        val key = binding.etDeviceKey.text?.toString()?.trim().orEmpty()

        if (key.isEmpty()) {
            binding.keyLayout.error = getString(com.canteen.scan.R.string.bind_key_empty)
            return
        }
        binding.keyLayout.error = null

        setLoading(true)

        lifecycleScope.launch {
            try {
                when (val result = ApiClient.checkDeviceKey(key)) {
                    is DeviceKeyCheck.Valid -> onBindSuccess(key)
                    is DeviceKeyCheck.Invalid -> {
                        setLoading(false)
                        binding.keyLayout.error = result.message
                            ?: getString(com.canteen.scan.R.string.bind_key_invalid)
                    }
                }
            } catch (e: ApiException.Network) {
                setLoading(false)
                // 网络异常单独提示：密钥可能根本没错，只是连不上，
                // 这时说"密钥无效"会让人白跑一趟去要新密钥
                AlertDialog.Builder(this@BindActivity)
                    .setTitle(com.canteen.scan.R.string.common_network_error)
                    .setMessage(
                        getString(com.canteen.scan.R.string.bind_network_detail, BuildConfig.API_BASE)
                    )
                    .setPositiveButton(com.canteen.scan.R.string.common_ok, null)
                    .show()
            } catch (e: Exception) {
                // 防御兜底：绝不让绑定流程把 App 崩掉
                // （lifecycleScope 里未捕获的异常会直接终止进程）
                setLoading(false)
                binding.keyLayout.error =
                    getString(com.canteen.scan.R.string.bind_key_invalid)
            }
        }
    }

    private fun onBindSuccess(key: String) {
        val store = ScanApp.from(this).deviceStore
        // 门店信息此刻拿不到（校验用的探测请求会被二维码无效挡在前面），
        // 等第一次真实核销成功后，结果里会带回 storeName，届时再落库展示
        store.save(deviceKey = key, storeId = null, storeName = null)

        Toast.makeText(this, com.canteen.scan.R.string.bind_ok, Toast.LENGTH_SHORT).show()

        startActivity(Intent(this, ScanActivity::class.java))
        setLoading(false)
        finish()
    }

    private fun setLoading(loading: Boolean) {
        binding.progress.visibility = if (loading) View.VISIBLE else View.GONE
        binding.btnBind.isEnabled = !loading
        binding.btnBind.text = if (loading) {
            getString(com.canteen.scan.R.string.bind_checking)
        } else {
            getString(com.canteen.scan.R.string.bind_submit)
        }
    }
}
