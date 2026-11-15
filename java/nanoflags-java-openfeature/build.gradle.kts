description = "OpenFeature provider for the NanoFlags Java server SDK (dev.openfeature:sdk)"

dependencies {
    api(project(":nanoflags-java"))
    api(libs.openfeature)
    compileOnly(libs.spotbugs.annotations)
    testCompileOnly(libs.spotbugs.annotations)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
}

tasks.jar {
    manifest { attributes("Automatic-Module-Name" to "io.nanoflags.server.openfeature") }
}
