package io.nanoflags.server.engine;

import java.util.Objects;

/** One line of the human-readable explanation of an evaluation. */
public final class TraceStep {
    private final String kind;
    private final String title;
    private final String detail;
    private final Boolean matched;

    public TraceStep(String kind, String title, String detail, Boolean matched) {
        this.kind = kind;
        this.title = title;
        this.detail = detail;
        this.matched = matched;
    }

    public TraceStep(String kind, String title, String detail) { this(kind, title, detail, null); }

    /** "config", "rule", "allocation" or "result". */
    public String kind() { return kind; }

    public String title() { return title; }

    public String detail() { return detail; }

    /** Set for rule and allocation steps, otherwise {@code null}. */
    public Boolean matched() { return matched; }

    @Override public boolean equals(Object o) {
        if (!(o instanceof TraceStep)) return false;
        TraceStep t = (TraceStep) o;
        return kind.equals(t.kind) && title.equals(t.title) && detail.equals(t.detail) && Objects.equals(matched, t.matched);
    }

    @Override public int hashCode() { return Objects.hash(kind, title, detail, matched); }

    @Override public String toString() { return String.format("%-10s %s — %s", kind, title, detail); }
}
