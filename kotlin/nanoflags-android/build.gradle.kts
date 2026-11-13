import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

description = "NanoFlags for Android: lifecycle, network awareness, on-device storage and Jetpack Compose helpers"

android {
    namespace = "io.nanoflags.android"
    compileSdk = 34

    defaultConfig {
        minSdk = 21
        consumerProguardFiles("consumer-rules.pro")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    buildFeatures {
        compose = true
        buildConfig = false
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                it.workingDir = projectDir
                it.systemProperty("robolectric.logging", "stdout")
                // Robolectric downloads its android-all jar from Maven Central; honour a mirror when one is configured.
                System.getProperty("robolectric.dependency.repo.url")?.let { url -> it.systemProperty("robolectric.dependency.repo.url", url) }
                it.testLogging {
                    events("passed", "skipped", "failed")
                    showStandardStreams = true
                    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
                }
            }
        }
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
    }
}

dependencies {
    api(project(":nanoflags-core"))
    implementation(libs.lifecycle.process)
    implementation(libs.compose.runtime)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.coroutines.test)

    // Device tests (src/androidTest): run on an emulator in CI (see ci/mobile-android.yml).
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(libs.bouncycastle)
}

publishing {
    publications {
        create<MavenPublication>("release") {
            artifactId = "nanoflags-android"
            afterEvaluate { from(components["release"]) }
        }
    }
}
