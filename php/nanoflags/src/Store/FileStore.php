<?php

declare(strict_types=1);

namespace NanoFlags\Store;

/**
 * One file per key in a directory (created with mode 0700; files are written atomically with mode 0600). Shared by
 * every process of the machine that can read the directory, which makes it the simplest store for a sync daemon
 * (`bin/nanoflags-sync`) feeding web workers. Signed bundles read back are verified again.
 */
final class FileStore implements Store
{
    public function __construct(private readonly string $directory)
    {
    }

    /** The default directory: `<sys_get_temp_dir()>/nanoflags-<uid>`. */
    public static function defaultDirectory(): string
    {
        $uid = function_exists('posix_geteuid') ? (string) posix_geteuid() : (string) getmyuid();
        return rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'nanoflags-' . $uid;
    }

    private function path(string $key): string
    {
        return $this->directory . DIRECTORY_SEPARATOR . preg_replace('/[^A-Za-z0-9_.-]/', '_', $key) . '.json';
    }

    public function get(string $key): ?string
    {
        $p = $this->path($key);
        if (!is_file($p)) {
            return null;
        }
        $raw = @file_get_contents($p);
        if ($raw === false || strlen($raw) < 11) {
            return null;
        }
        // "<expiry 10 digits>\n<value>"
        $expires = (int) substr($raw, 0, 10);
        if ($expires > 0 && $expires < time()) {
            return null;
        }
        return substr($raw, 11);
    }

    public function set(string $key, string $value, int $ttl = 0): void
    {
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            throw new \RuntimeException('cannot create ' . $this->directory);
        }
        $tmp = @tempnam($this->directory, '.nanoflags-');
        if ($tmp === false) {
            throw new \RuntimeException('cannot write to ' . $this->directory);
        }
        $header = sprintf('%010d', $ttl > 0 ? time() + $ttl : 0) . "\n";
        if (@file_put_contents($tmp, $header . $value) === false) {
            @unlink($tmp);
            throw new \RuntimeException('cannot write ' . $tmp);
        }
        @chmod($tmp, 0600);
        if (!@rename($tmp, $this->path($key))) {
            @unlink($tmp);
            throw new \RuntimeException('cannot replace ' . $this->path($key));
        }
    }
}
