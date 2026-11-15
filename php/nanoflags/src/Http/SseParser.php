<?php

declare(strict_types=1);

namespace NanoFlags\Http;

/** Incremental text/event-stream parser. @internal */
final class SseParser
{
    private string $buffer = '';
    private string $event = 'message';
    /** @var list<string> */
    private array $data = [];

    /**
     * Feeds a chunk; returns the complete events in it.
     *
     * @return list<array{string, string}>
     */
    public function feed(string $chunk): array
    {
        $this->buffer .= $chunk;
        $out = [];
        while (($p = strpos($this->buffer, "\n")) !== false) {
            $line = rtrim(substr($this->buffer, 0, $p), "\r");
            $this->buffer = substr($this->buffer, $p + 1);
            if ($line === '') {
                if ($this->data !== []) {
                    $out[] = [$this->event, implode("\n", $this->data)];
                }
                $this->event = 'message';
                $this->data = [];
                continue;
            }
            if ($line[0] === ':') {
                continue;
            }
            $colon = strpos($line, ':');
            $field = $colon === false ? $line : substr($line, 0, $colon);
            $value = $colon === false ? '' : substr($line, $colon + 1);
            if (str_starts_with($value, ' ')) {
                $value = substr($value, 1);
            }
            if ($field === 'event') {
                $this->event = $value;
            } elseif ($field === 'data') {
                $this->data[] = $value;
            }
        }
        if (strlen($this->buffer) > 65536) {
            $this->buffer = '';
        }
        return $out;
    }
}
