plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.android.application) apply false
}

// Single source of truth for the release: also written into BuildInfo.VERSION (nanoflags-core).
val sdkVersion = providers.gradleProperty("nanoflags.version").get()

allprojects {
    group = "io.nanoflags"
    version = sdkVersion
}

/*
 * Publishing (see PUBLISHING.md). Every module publishes to a local staging repository
 * (build/staging-deploy at the root); CI zips that directory and uploads it to the Sonatype Central Portal.
 * Signing is enabled only when a key is provided (-PsigningKey=… / ORG_GRADLE_PROJECT_signingKey), so local
 * builds never need one.
 */
subprojects {
    if (name == "sample") return@subprojects
    apply(plugin = "maven-publish")
    apply(plugin = "signing")

    afterEvaluate {
        extensions.configure<PublishingExtension> {
            repositories {
                maven {
                    name = "staging"
                    url = uri(rootProject.layout.buildDirectory.dir("staging-deploy"))
                }
            }
            publications.withType<MavenPublication>().configureEach {
                pom {
                    name.set(project.name)
                    description.set(project.description ?: "NanoFlags SDK for Android and Kotlin")
                    url.set("https://nanoflags.io")
                    licenses {
                        license {
                            name.set("The Apache License, Version 2.0")
                            url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                            distribution.set("repo")
                        }
                    }
                    developers {
                        developer {
                            id.set("nanoflags")
                            name.set("NanoFlags")
                            email.set("support@nanoflags.io")
                            organization.set("NanoFlags")
                            organizationUrl.set("https://nanoflags.io")
                        }
                    }
                    scm {
                        url.set("https://github.com/motazalmaroai/nanoflags-sdk")
                        connection.set("scm:git:https://github.com/motazalmaroai/nanoflags-sdk.git")
                        developerConnection.set("scm:git:ssh://git@github.com/motazalmaroai/nanoflags-sdk.git")
                    }
                }
            }
        }
        val signingKey = providers.gradleProperty("signingKey").orNull
        if (!signingKey.isNullOrBlank()) {
            extensions.configure<SigningExtension> {
                useInMemoryPgpKeys(signingKey, providers.gradleProperty("signingPassword").orNull ?: "")
                sign(extensions.getByType<PublishingExtension>().publications)
            }
        }
    }
}
