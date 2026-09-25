# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**

# Gson：用反射读写响应模型，字段名必须保留
-keep class com.canteen.scan.net.** { *; }
-keepattributes Signature
-keepattributes *Annotation*

# ML Kit
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**

# ── EncryptedSharedPreferences / Tink（漏洞 10325 引入）──
# androidx.security 的加密实现底层用 Tink，Tink 通过**反射**按类名
# 加载 KeyManager / ProtoSerialization 等实现类；R8 若把类名混淆掉，
# release 包在运行时会抛 GeneralSecurityException（debug 包不混淆所以
# 看不出问题，是典型的「debug 正常、release 崩溃」陷阱）。
# 此外 Tink 的部分实现来自 androidx 依赖，不在编译类路径上，
# 需显式 -dontwarn 压掉缺失引用警告。
-keep class com.google.crypto.tink.** { *; }
-keep class androidx.security.crypto.** { *; }
-keepclassmembers class * extends com.google.crypto.tink.shaded.protobuf.GeneratedMessageLite {
    <fields>;
}
-dontwarn com.google.crypto.tink.**
-dontwarn com.google.api.client.http.**
-dontwarn org.joda.time.**
-dontwarn javax.annotation.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn com.google.j2objc.annotations.**
-keepattributes InnerClasses
