package io.nanoflags

import java.io.File
import java.io.IOException

/**
 * On-device persistence of the last verified bundle, so that the app starts offline-first with the configuration it
 * last saw (re-verified on load). Calls happen on a background thread; implementations may block.
 *
 * The stored text is opaque to the store. It contains no SDK key, only a non-secret fingerprint of it.
 */
interface BundleStore {
    /** The saved text, or `null` when nothing is saved. */
    @Throws(IOException::class)
    fun load(): String?

    @Throws(IOException::class)
    fun save(data: String)
}

/** Keeps the bundle in memory only (tests, or apps that do not want persistence). */
class InMemoryBundleStore : BundleStore {
    @Volatile
    private var data: String? = null
    override fun load(): String? = data
    override fun save(data: String) {
        this.data = data
    }
}

/**
 * Stores the bundle in one file, replaced atomically (write to a temporary file, then rename), so a crash never
 * leaves a half-written copy behind. On Android use `FileBundleStore(File(context.noBackupFilesDir, …))` (what
 * `NanoFlagsAndroid` does by default): the file is excluded from cloud backups.
 */
class FileBundleStore(private val file: File) : BundleStore {
    override fun load(): String? = synchronized(this) {
        if (!file.isFile) null else file.readText(Charsets.UTF_8)
    }

    override fun save(data: String) = synchronized(this) {
        file.parentFile?.mkdirs()
        val tmp = File(file.path + ".tmp")
        tmp.outputStream().use { out ->
            out.write(data.toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        if (!tmp.renameTo(file)) {
            // Some file systems refuse to rename over an existing file.
            file.delete()
            if (!tmp.renameTo(file)) throw IOException("could not replace $file")
        }
    }
}
