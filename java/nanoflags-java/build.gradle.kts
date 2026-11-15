description = "NanoFlags server SDK for Java: local flag evaluation, signed bundles, live updates (no runtime dependencies)"

dependencies {
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.bouncycastle)
}

// The SDK version, readable at runtime (reported to the edge as "java/<version>").
val generateBuildInfo by tasks.registering {
    val out = layout.buildDirectory.dir("generated/resources/buildinfo")
    val v = project.version.toString()
    inputs.property("version", v)
    outputs.dir(out)
    doLast {
        val f = out.get().file("io/nanoflags/server/version.properties").asFile
        f.parentFile.mkdirs()
        f.writeText("version=$v\n")
    }
}
sourceSets["main"].resources.srcDir(generateBuildInfo)

tasks.jar {
    manifest { attributes("Automatic-Module-Name" to "io.nanoflags.server") }
}

tasks.test {
    // Opt-in production check (see README): NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=nf_…
    environment("NANOFLAGS_PRODUCTION_TESTS", System.getenv("NANOFLAGS_PRODUCTION_TESTS") ?: "")
}
