import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.canteen.scan"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.canteen.scan"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        buildConfigField("String", "API_BASE", "\"https://tuancan.gengle.xyz\"")
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    // P0-8 修复：签名密码从 keystore.properties 读取（已 .gitignore）
    val keystoreProperties = Properties().apply {
        val f = rootProject.file("keystore.properties")
        if (f.exists()) load(FileInputStream(f))
    }

    signingConfigs {
        create("internal") {
            storeFile = rootProject.file("keystore/internal-release.keystore")
            storePassword = keystoreProperties.getProperty("storePassword", "")
            keyAlias = keystoreProperties.getProperty("keyAlias", "canteen")
            keyPassword = keystoreProperties.getProperty("keyPassword", "")
        }
    }

    buildTypes {
        release {
            // P1-18 修复：启用代码混淆和裁剪，防逆向
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("internal")
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
       1.0
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.3")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.recyclerview:recyclerview:1.3.3")

    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    val camerax = "1.4.2"
    implementation("androidx.camera:camera-core:$camerax")
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")

    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.11.0")
}