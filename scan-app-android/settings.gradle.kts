pluginManagement {
    repositories {
        // 阿里云镜像放最前：国内拉 AGP/Kotlin 插件快几个数量级；
        // 镜像没有的会 fallback 到官方源
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/central") }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/central") }
        google()
        mavenCentral()
        // ML Kit bundled 版在阿里云镜像与 google() 均可拉取
    }
}

rootProject.name = "CanteenScan"
include(":app")
