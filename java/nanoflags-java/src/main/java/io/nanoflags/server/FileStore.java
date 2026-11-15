package io.nanoflags.server;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;

/** Keeps the last good configuration in a file (written atomically; owner read/write only where POSIX permissions exist). */
public final class FileStore implements Store {
    private final Path path;

    public FileStore(Path path) { this.path = path.toAbsolutePath(); }

    public Path path() { return path; }

    @Override
    public byte[] load() throws IOException {
        try {
            return Files.readAllBytes(path);
        } catch (NoSuchFileException e) {
            return null;
        }
    }

    @Override
    public void save(byte[] data) throws IOException {
        Path dir = path.getParent();
        if (dir != null) Files.createDirectories(dir);
        Path tmp = Files.createTempFile(dir, ".nanoflags-", ".tmp");
        try {
            try {
                Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-------"));
            } catch (UnsupportedOperationException ignored) {
                // not a POSIX file system
            }
            Files.write(tmp, data);
            try {
                Files.move(tmp, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }
}
