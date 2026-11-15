<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/** One line of the human-readable explanation of an evaluation. */
final class TraceStep implements \JsonSerializable
{
    public function __construct(
        /** "config", "rule", "allocation" or "result". */
        public readonly string $kind,
        public readonly string $title,
        public readonly string $detail,
        /** Set for rule and allocation steps. */
        public readonly ?bool $matched = null,
    ) {
    }

    /** @return array{kind: string, title: string, detail: string, matched?: bool} */
    public function toArray(): array
    {
        $a = ['kind' => $this->kind, 'title' => $this->title, 'detail' => $this->detail];
        if ($this->matched !== null) {
            $a['matched'] = $this->matched;
        }
        return $a;
    }

    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
