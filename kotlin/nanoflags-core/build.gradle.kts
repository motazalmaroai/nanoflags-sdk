import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
}

description = "NanoFlags core SDK for Kotlin/JVM and Android: local flag evaluation, signed bundles, live updates"

java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
    withSourcesJar()
    withJavadocJar()
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
        freeCompilerArgs.add("-Xjdk-release=1.8")
    }
}

dependencies {
    api(libs.coroutines.core)
    api(libs.okhttp)
    implementation(libs.bouncycastle)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

tasks.test {
    // Fixture locations are resolved relative to the module directory.
    workingDir = projectDir
    systemProperty("nanoflags.version", project.version.toString())
    // Opt-in production checks (see README): NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=nf_pub_…
    environment("NANOFLAGS_PRODUCTION_TESTS", System.getenv("NANOFLAGS_PRODUCTION_TESTS") ?: "")
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
    maxHeapSize = "2g"
}

publishing {
    publications {
        create<MavenPublication>("release") {
            artifactId = "nanoflags-core"
            from(components["java"])
        }
    }
}
