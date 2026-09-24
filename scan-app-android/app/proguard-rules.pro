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
