<?php

// Router for `php -S`: a minimal edge for the HTTP transport tests. State lives in NANOFLAGS_TEST_STATE (a directory).
declare(strict_types=1);

$dir = getenv('NANOFLAGS_TEST_STATE');
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
file_put_contents("$dir/requests.log", $_SERVER['REQUEST_METHOD'] . ' ' . $path . ' ' . ($_SERVER['HTTP_AUTHORIZATION'] ?? '-') . "\n", FILE_APPEND);
$text = (string) file_get_contents("$dir/bundle.json");
$checksum = md5($text);
$etag = '"' . $checksum . '-server"';

if ($path === '/v1/bundle') {
    header('ETag: ' . $etag);
    header('X-NanoFlags-Signed: false');
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        return true;
    }
    header('Content-Type: application/json');
    $revision = json_decode($text, true)['revision'];
    echo '{"revision":' . $revision . ',"checksum":"' . $checksum . '","bundle":' . $text . '}';
    return true;
}
if ($path === '/v1/events') {
    file_put_contents("$dir/events.log", file_get_contents('php://input') . "\n", FILE_APPEND);
    http_response_code(202);
    echo '{"accepted":1}';
    return true;
}
if ($path === '/v1/stream') {
    header('Content-Type: text/event-stream');
    echo ": hello\n\n";
    @ob_flush();
    flush();
    usleep(200000);
    $revision = json_decode($text, true)['revision'];
    echo "event: revision\ndata: {\"revision\":" . ($revision + 1) . ",\"checksum\":\"new\"}\n\n";
    @ob_flush();
    flush();
    usleep(300000);
    return true;
}
if ($path === '/redirect') {
    header('Location: /v1/bundle', true, 302);
    return true;
}
http_response_code(404);
return true;
