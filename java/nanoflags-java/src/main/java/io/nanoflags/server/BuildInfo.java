package io.nanoflags.server;

import java.io.InputStream;
import java.util.Properties;

/** The SDK version, written into {@code version.properties} by the build. */
final class BuildInfo {
    private BuildInfo() {}

    static final String VERSION = load();

    private static String load() {
        try (InputStream in = BuildInfo.class.getResourceAsStream("version.properties")) {
            if (in != null) {
                Properties p = new Properties();
                p.load(in);
                String v = p.getProperty("version");
                if (v != null && !v.isEmpty()) return v;
            }
        } catch (Exception ignored) {
            // fall through
        }
        return "0.2.0";
    }
}
