package io.nanoflags.server;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Bundle signature verification settings (see {@link NanoFlagsOptions.Builder#verify(VerifyOptions)}). */
public final class VerifyOptions {
    final List<Jwk> publicKeys;
    final boolean fetchKeys;
    final Boolean require;

    private VerifyOptions(Builder b) {
        this.publicKeys = Collections.unmodifiableList(new ArrayList<>(b.publicKeys));
        this.fetchKeys = b.fetchKeys;
        this.require = b.require;
    }

    public static Builder builder() { return new Builder(); }

    public List<Jwk> publicKeys() { return publicKeys; }

    public boolean fetchKeys() { return fetchKeys; }

    /** {@code null}: required on the official edge, optional elsewhere. */
    public Boolean require() { return require; }

    public static final class Builder {
        private final List<Jwk> publicKeys = new ArrayList<>();
        private boolean fetchKeys;
        private Boolean require;

        private Builder() {}

        /**
         * Keys to verify with. None: {@link NanoFlagsOptions#OFFICIAL_SIGNING_KEYS} on the official edge, otherwise the
         * keys of {@code GET /v1/keys} on the configured edge. Pinning keys is stronger than fetching them: fetched keys
         * are only as trustworthy as the connection they arrived over.
         */
        public Builder publicKeys(List<Jwk> keys) {
            publicKeys.clear();
            publicKeys.addAll(keys);
            return this;
        }

        public Builder publicKey(Jwk key) {
            publicKeys.add(key);
            return this;
        }

        /** Also load keys from {@code GET /v1/keys} (once, then at most once a minute when a bundle names an unknown key id). */
        public Builder fetchKeys(boolean fetch) {
            this.fetchKeys = fetch;
            return this;
        }

        /** Refuse bundles that carry no signature. Default: true on the official edge, false elsewhere. */
        public Builder require(boolean require) {
            this.require = require;
            return this;
        }

        public VerifyOptions build() { return new VerifyOptions(this); }
    }
}
