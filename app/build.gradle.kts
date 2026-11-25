plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.killerx.yt"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.killerx.yt"
        minSdk = 24
        targetSdk = 35
        versionCode = 6
        versionName = "2.3"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    signingConfigs {
        create("release") {
            val ksFile = file("killerx-release.jks")
            if (ksFile.exists()) {
                storeFile = ksFile
                storePassword = System.getenv("KEYSTORE_PASSWORD") ?: "KillerX2026!"
                keyAlias = System.getenv("KEY_ALIAS") ?: "killerx"
                keyPassword = System.getenv("KEY_PASSWORD") ?: "KillerX2026!"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            val ksFile = file("killerx-release.jks")
            signingConfig = if (ksFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    // Real Mozilla Firefox Engine (arm64-v8a) — Native Gmail Login + Real WebExtensions!
    implementation("org.mozilla.geckoview:geckoview-arm64-v8a:131.0.+")
}
