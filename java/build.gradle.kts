// NanoFlags Java server SDK. Two artifacts, both plain Java 11 bytecode with no Kotlin runtime:
//   io.nanoflags:nanoflags-java              the client (no runtime dependencies)
//   io.nanoflags:nanoflags-java-openfeature  the OpenFeature provider (dev.openfeature:sdk)
// Publishing (see PUBLISHING.md): every module publishes to a local staging repository (build/staging-deploy);
// nothing in this build uploads anywhere. Signing is enabled only when a key is provided (-PsigningKey=… /
// ORG_GRADLE_PROJECT_signingKey), so local builds never need one.

val sdkVersion = providers.gradleProperty("nanoflags.version").get()

allprojects {
    group = "io.nanoflags"
    version = sdkVersion
}

subprojects {
    apply(plugin = "java-library")
    apply(plugin = "maven-publish")
    apply(plugin = "signing")

    extensions.configure<JavaPluginExtension> {
        withSourcesJar()
        withJavadocJar()
    }

    tasks.withType<JavaCompile>().configureEach {
        options.release.set(11)
        options.encoding = "UTF-8"
        options.compilerArgs.addAll(listOf("-Xlint:all,-serial,-try", "-Werror"))
    }

    tasks.withType<Javadoc>().configureEach {
        (options as StandardJavadocDocletOptions).apply {
            encoding = "UTF-8"
            addStringOption("Xdoclint:none", "-quiet")
        }
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        workingDir = projectDir
        systemProperty("nanoflags.version", sdkVersion)
        maxHeapSize = "2g"
        testLogging {
            events("passed", "skipped", "failed")
            showStandardStreams = true
            exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        }
    }

    tasks.withType<Jar>().configureEach {
        manifest {
            attributes(
                "Implementation-Title" to project.name,
                "Implementation-Version" to sdkVersion,
                "Implementation-Vendor" to "NanoFlags",
            )
        }
    }

    afterEvaluate {
        extensions.configure<PublishingExtension> {
            repositories {
                maven {
                    name = "staging"
                    url = uri(rootProject.layout.buildDirectory.dir("staging-deploy"))
                }
            }
            publications {
                create<MavenPublication>("release") {
                    artifactId = project.name
                    from(components["java"])
                    pom {
                        name.set(project.name)
                        description.set(project.description ?: "NanoFlags server SDK for Java")
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
                        issueManagement {
                            system.set("GitHub")
                            url.set("https://github.com/motazalmaroai/nanoflags-sdk/issues")
                        }
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
