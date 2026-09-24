plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.canteen.scan"
    // compileSdk 35：CameraX 1.4+ 的 16KB 页对齐修复要求 35；
    // targetSdk 保持 34，运行时行为不变
    compileSdk = 35

    defaultConfig {
        applicationId = "com.canteen.scan"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // 后端地址在编译期注入。
        //
        // 为什么不用运行时配置：核销员是食堂一线人员，让他们在 App 里手输
        // 服务器地址不现实（也容易输错）。地址是部署时就确定的，编译进去最省事。
        // 换服务器时改这一行重新打包即可。
        //
        // 生产地址请填 HTTPS 域名（如 https://canteen.example.com）。
        // 若暂时用 IP + HTTP，需要在 AndroidManifest 的网络配置里放行明文流量。
        // 生产地址：HTTPS 域名（ cleartext 放行配置保留，仅作为回退时手动填 IP 用）
        buildConfigField("String", "API_BASE", "\"https://tuancan.gengle.xyz\"")
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    // 内部分发签名配置：keystore 随工程提供，密码仅用于内部分发场景。
    // 正式对外发布请重新生成并妥善保管，不要提交到公共仓库
    signingConfigs {
        create("internal") {
            storeFile = rootProject.file("keystore/internal-release.keystore")
            storePassword = "canteen-internal-2026"
            keyAlias = "canteen"
            keyPassword = "canteen-internal-2026"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // 内部分发签名：让 release 包可直接安装，且消除
            // "可调试应用"系统警告（debug 包 debuggable=true 必弹）。
            // 正式对外发布时请另建 keystore 替换，勿复用内部分发密钥
            signingConfig = signingConfigs.getByName("internal")
        }
    }

    // so 库以未压缩方式打进 APK（extractNativeLibs=false）：
    // 这是 16KB 页对齐生效的前提，加载也更快
    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // 基础 UI
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.recyclerview:recyclerview:1.3.2")

    // 生命周期与协程
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // CameraX：相机预览与逐帧分析。
    // 1.4.2 起 libimage_processing_util_jni.so 完成 16KB 页对齐
    // （1.3.x 的旧编译产物在 Android 15+ 设备触发兼容性警告）
    val camerax = "1.4.2"
    implementation("androidx.camera:camera-core:$camerax")
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")

    // ML Kit 条码识别：**bundled 版本**，模型打包进 APK。
    // 不用 unbundled（依赖 Google Play 服务下载模型）——食堂网络环境不一定能
    // 访问 Google 服务，装完就能扫比 APK 小几 MB 重要得多。
    // 17.3.0：libbarhopper_v3.so 已 16KB 页对齐（17.2.0 未对齐会触发警告）
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    // 网络
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.11.0")
}
