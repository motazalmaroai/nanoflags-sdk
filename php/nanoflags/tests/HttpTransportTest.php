<?php

declare(strict_types=1);

namespace NanoFlags\Tests;

use NanoFlags\Client;
use NanoFlags\Http\CurlTransport;
use NanoFlags\Http\StreamTransport;
use NanoFlags\Http\Transport;
use NanoFlags\Status;
use NanoFlags\Store\FileStore;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The built-in transports against a real local HTTP server (`php -S` with tests/fixtures/edge-router.php). */
final class HttpTransportTest extends TestCase
{
    /** @var resource|null */
    private static $server = null;
    private static string $state = '';
    private static string $base = '';

    public static function setUpBeforeClass(): void
    {
        self::$state = sys_get_temp_dir() . '/nanoflags-http-' . bin2hex(random_bytes(4));
        mkdir(self::$state);
        file_put_contents(self::$state . '/bundle.json', (string) json_encode(FakeEdge::bundle(4)));
        $sock = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr((string) stream_socket_get_name($sock, false), strrpos((string) stream_socket_get_name($sock, false), ':') + 1);
        fclose($sock);
        self::$base = "http://127.0.0.1:$port";
        $cmd = [PHP_BINARY, '-S', "127.0.0.1:$port", __DIR__ . '/fixtures/edge-router.php'];
        $env = ['NANOFLAGS_TEST_STATE' => self::$state, 'PATH' => (string) getenv('PATH')];
        self::$server = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, null, $env);
        for ($i = 0; $i < 100; $i++) {
            $c = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.1);
            if ($c !== false) {
                fclose($c);
                return;
            }
            usleep(50000);
        }
        self::fail('php -S did not start');
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$server !== null) {
            proc_terminate(self::$server);
            proc_close(self::$server);
        }
        foreach (glob(self::$state . '/{,.}*', GLOB_BRACE) ?: [] as $f) {
            if (is_file($f)) {
                unlink($f);
            }
        }
        @rmdir(self::$state . '/cache');
        @rmdir(self::$state);
    }

    /** @return array<string, array{Transport}> */
    public static function transports(): array
    {
        $out = ['stream' => [new StreamTransport()]];
        if (CurlTransport::available()) {
            $out['curl'] = [new CurlTransport()];
        }
        return $out;
    }

    #[DataProvider('transports')]
    public function testBundleEtagAndEvents(Transport $t): void
    {
        $res = $t->send('GET', self::$base . '/v1/bundle', ['Authorization' => 'Bearer nf_srv_x'], null, 5);
        self::assertSame(200, $res->status);
        $etag = $res->header('ETag');
        self::assertNotNull($etag);
        self::assertSame(304, $t->send('GET', self::$base . '/v1/bundle', ['If-None-Match' => $etag], null, 5)->status);
        self::assertSame(302, $t->send('GET', self::$base . '/redirect', [], null, 5)->status); // never followed
        self::assertSame(202, $t->send('POST', self::$base . '/v1/events', ['Content-Type' => 'application/json'], '{"x":1}', 5)->status);
    }

    public function testClientEndToEndWithFileStore(): void
    {
        $store = new FileStore(self::$state . '/cache');
        $opts = ['sdkKey' => 'nf_srv_http', 'baseUrl' => self::$base, 'cache' => $store, 'verify' => false, 'events' => ['sampleRate' => 1.0]];
        $c = new Client(...$opts);
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        self::assertSame(Status::READY, $c->status());
        self::assertSame(4, $c->revision());
        $c->flush();
        $events = (string) file_get_contents(self::$state . '/events.log');
        self::assertStringContainsString('"flagKey":"accent"', $events);
        self::assertSame(0700, fileperms(self::$state . '/cache') & 0777);
        $files = glob(self::$state . '/cache/*.json') ?: [];
        self::assertNotEmpty($files);
        self::assertSame(0600, fileperms($files[0]) & 0777);
        $c2 = new Client(...$opts);
        self::assertSame('cache', $c2->source());
        self::assertStringContainsString('Bearer nf_srv_http', (string) file_get_contents(self::$state . '/requests.log'));
    }

    public function testSyncDaemonFollowsTheStream(): void
    {
        if (!CurlTransport::available()) {
            self::markTestSkipped('ext-curl is needed for the event stream');
        }
        $syncs = 0;
        $c = new Client('nf_srv_daemon', baseUrl: self::$base, cache: new FileStore(self::$state . '/cache'), verify: false, events: false);
        $c->run(pollInterval: 30.0, stream: true, duration: 1.5, onSync: function () use (&$syncs): void {
            $syncs++;
        });
        // The first sync, then one more as soon as the stream announced a newer revision.
        self::assertGreaterThanOrEqual(2, $syncs);
        self::assertStringContainsString('GET /v1/stream', (string) file_get_contents(self::$state . '/requests.log'));
    }
}
