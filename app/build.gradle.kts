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
        versionCode = 3
        versionName = "2.0"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
