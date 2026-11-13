pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "nanoflags-kotlin"

include(":nanoflags-core")
include(":nanoflags-openfeature")

// The Android module needs the Android SDK (ANDROID_HOME, or sdk.dir in local.properties). Without it the
// pure-JVM modules still build: `-Pnanoflags.skipAndroid=true` leaves the Android module out explicitly.
val skipAndroid = providers.gradleProperty("nanoflags.skipAndroid").orNull == "true"
if (!skipAndroid) {
    include(":nanoflags-android")
    // Sample app (Compose) used by the device smoke test; never published.
    include(":sample")
}
