package nanoflags

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

// OfficialEdgeURL is the hosted NanoFlags edge. With this base URL (the default) every bundle is
// verified against OfficialSigningKeys, and unsigned bundles are refused.
const OfficialEdgeURL = "https://edge.nanoflags.io"

// JWK is a public Ed25519 key as published by `GET /v1/keys`.
type JWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Kid string `json:"kid,omitempty"`
	// D is the private member. A JWK that carries one is a private key and is refused.
	D string `json:"d,omitempty"`
}

// OfficialSigningKeys are the public halves of the production bundle-signing keys (safe to
// embed). A bundle signed with a key id that is not listed here — a rotation that happened after
// this release — makes the client load `GET /v1/keys` once (at most once a minute).
var OfficialSigningKeys = []JWK{
	{Kty: "OKP", Crv: "Ed25519", X: "wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", Kid: "k1"},
}

// VerifyOptions configures bundle signature verification.
type VerifyOptions struct {
	// PublicKeys to verify with. Empty: OfficialSigningKeys on the official edge, otherwise the
	// keys of `GET /v1/keys` on the configured edge (FetchKeys). Pinning keys is stronger than
	// fetching them: fetched keys are only as trustworthy as the connection they arrived over.
	PublicKeys []JWK
	// FetchKeys loads keys from `GET /v1/keys` (once, and again at most once a minute when a bundle
	// names an unknown key id), in addition to PublicKeys.
	FetchKeys bool
	// Require refuses bundles that carry no signature (the edge's unsigned fallback). nil: true
	// on the official edge, false elsewhere.
	Require *bool
}

type signatureInfo struct {
	Signature     string `json:"signature"`
	Kid           string `json:"kid,omitempty"`
	EnvironmentID string `json:"environmentId"`
	Revision      int64  `json:"revision"`
	Checksum      string `json:"checksum"`
}

type publicKey struct {
	kid string // "" = no key id
	key ed25519.PublicKey
}

func isPublicEd25519(k JWK) bool {
	return k.Kty == "OKP" && k.Crv == "Ed25519" && k.X != "" && k.D == ""
}

func importKeys(jwks []JWK) []publicKey {
	var out []publicKey
	for _, k := range jwks {
		if !isPublicEd25519(k) {
			continue
		}
		raw, err := base64URLDecode(k.X)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			continue
		}
		out = append(out, publicKey{kid: k.Kid, key: ed25519.PublicKey(raw)})
	}
	return out
}

func base64URLDecode(s string) ([]byte, error) {
	s = strings.TrimRight(strings.NewReplacer("+", "-", "/", "_").Replace(s), "=")
	return base64.RawURLEncoding.DecodeString(s)
}

// canonicalString is the signed text: "nanoflags-bundle-v1\n<environment>\n<revision>\n<checksum>\n<sha256 hex of the bundle text>".
func canonicalString(environmentID string, revision int64, checksum string, bundleText []byte) []byte {
	sum := sha256.Sum256(bundleText)
	return []byte("nanoflags-bundle-v1\n" + environmentID + "\n" + strconv.FormatInt(revision, 10) + "\n" + checksum + "\n" + hex.EncodeToString(sum[:]))
}

// verifyBundleText reports whether info.Signature is a valid signature by one of keys over the
// canonical string for bundleText. A key id narrows the candidates; an unknown key id matches no key.
func verifyBundleText(keys []publicKey, info signatureInfo, bundleText []byte) bool {
	sig, err := base64URLDecode(info.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	msg := canonicalString(info.EnvironmentID, info.Revision, info.Checksum, bundleText)
	for _, k := range keys {
		if info.Kid != "" && k.kid != "" && k.kid != info.Kid {
			continue
		}
		if ed25519.Verify(k.key, msg, sig) {
			return true
		}
	}
	return false
}

// rawMember returns the exact source bytes of the top-level member `name` of a JSON object
// (the last one when it repeats, like JSON.parse), or nil. The edge embeds the stored, signed
// bundle text byte-for-byte; hashing that span avoids any re-serialisation.
func rawMember(text []byte, name string) []byte {
	i, n := 0, len(text)
	ws := func() {
		for i < n && (text[i] == ' ' || text[i] == '\n' || text[i] == '\r' || text[i] == '\t') {
			i++
		}
	}
	str := func() (int, int, bool) {
		if i >= n || text[i] != '"' {
			return 0, 0, false
		}
		start := i
		i++
		for i < n {
			switch text[i] {
			case '\\':
				i += 2
			case '"':
				i++
				return start, i, true
			default:
				i++
			}
		}
		return 0, 0, false
	}
	value := func() bool {
		ws()
		if i >= n {
			return false
		}
		switch text[i] {
		case '"':
			_, _, ok := str()
			return ok
		case '{', '[':
			depth := 0
			for i < n {
				switch text[i] {
				case '"':
					if _, _, ok := str(); !ok {
						return false
					}
					continue
				case '{', '[':
					depth++
				case '}', ']':
					depth--
				}
				i++
				if depth == 0 {
					return true
				}
			}
			return false
		}
		start := i
		for i < n && !strings.ContainsRune(",}] \n\r\t", rune(text[i])) {
			i++
		}
		return i > start
	}
	ws()
	if i >= n || text[i] != '{' {
		return nil
	}
	i++
	var found []byte
	for {
		ws()
		if i < n && text[i] == '}' {
			return found
		}
		ks, ke, ok := str()
		if !ok {
			return nil
		}
		ws()
		if i >= n || text[i] != ':' {
			return nil
		}
		i++
		ws()
		start := i
		if !value() {
			return nil
		}
		if key, err := engine.ParseJSON(text[ks:ke]); err == nil {
			if k, _ := key.Str(); k == name {
				found = text[start:i]
			}
		}
		ws()
		if i < n && text[i] == ',' {
			i++
		} else if i < n && text[i] == '}' {
			return found
		} else {
			return nil
		}
	}
}
