package engine

import (
	"errors"
	"math"
)

// ErrInvalidBundle is returned by ParseBundle for a document that is not a bundle.
var ErrInvalidBundle = errors.New("nanoflags: not a valid bundle")

// Bundle is a parsed, immutable configuration bundle: one revision of one environment.
// It is safe for concurrent use.
type Bundle struct {
	v        Value
	revision int64
}

// ParseBundle parses bundle JSON text. It accepts what the SDKs accept (`schema` 1, a numeric
// `revision`, an object `flags`, an object `segments`); the flags themselves are evaluated as they
// are, malformed or not, exactly as the TypeScript engine evaluates them.
func ParseBundle(data []byte) (*Bundle, error) {
	v, err := ParseJSON(data)
	if err != nil {
		return nil, err
	}
	return NewBundle(v)
}

// NewBundle wraps a parsed bundle document (see ParseBundle).
func NewBundle(v Value) (*Bundle, error) {
	if !IsBundle(v) {
		return nil, ErrInvalidBundle
	}
	r := v.Field("revision").n
	if math.IsNaN(r) || math.IsInf(r, 0) {
		r = 0
	}
	return &Bundle{v: v, revision: int64(r)}, nil
}

// IsBundle reports whether v has the shape the SDKs accept as a bundle.
func IsBundle(v Value) bool {
	if v.k != kObject {
		return false
	}
	schema, rev, flags, segs := v.Field("schema"), v.Field("revision"), v.Field("flags"), v.Field("segments")
	return schema.k == kNumber && schema.n == 1 && rev.k == kNumber && flags.k == kObject && (segs.k == kObject || segs.k == kArray)
}

// Value returns the bundle document.
func (b *Bundle) Value() Value {
	if b == nil {
		return Null
	}
	return b.v
}

// Revision is the bundle's revision number.
func (b *Bundle) Revision() int64 {
	if b == nil {
		return 0
	}
	return b.revision
}

// Engine is the bundle's `engine` member (Undefined when absent).
func (b *Bundle) Engine() Value { return b.Value().Field("engine") }

// SupportsEngine reports whether this engine can evaluate the bundle.
func (b *Bundle) SupportsEngine() bool { return SupportsEngine(b.Engine()) }

// FlagKeys lists the bundle's flag keys in document order.
func (b *Bundle) FlagKeys() []string { return b.Value().Field("flags").Keys() }

// Evaluate evaluates one flag (a nil bundle means "no configuration loaded").
func (b *Bundle) Evaluate(flagKey string, ctx Context, fallback Value) Result {
	return Evaluate(b.Value(), flagKey, ctx, fallback)
}

// MarshalJSON encodes the bundle as JSON.stringify would.
func (b *Bundle) MarshalJSON() ([]byte, error) { return b.Value().MarshalJSON() }

// UnmarshalJSON decodes and validates bundle JSON.
func (b *Bundle) UnmarshalJSON(data []byte) error {
	x, err := ParseBundle(data)
	if err != nil {
		return err
	}
	*b = *x
	return nil
}

// AttributesUsedBy lists the context attributes that the rules of flagKey reference (through
// segments up to the engine's nesting limit) plus the bucketing attribute of rollouts. The SDKs
// report only these attribute names, never values, with sampled evaluation events.
func AttributesUsedBy(bundle Value, flagKey string) (names []string) {
	seen := map[string]bool{}
	add := func(n string) {
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	defer func() {
		if recover() != nil {
			names = nil
		}
	}()
	segments := bundle.Field("segments")
	var visit func(conds Value, depth int) bool
	visit = func(conds Value, depth int) bool {
		if conds.k != kArray {
			// `for…of` over a non-iterable throws in the TypeScript SDK: nothing is reported.
			return conds.k == kString
		}
		for _, c := range conds.a {
			op, err := c.get("op")
			if err != nil {
				return false
			}
			if isStr(op, "segment") || isStr(op, "not_segment") {
				value, _ := c.get("value")
				if value.k == kString {
					seg := own(segments, value.s)
					if seg.truthy() && depth < 4 {
						sc, err := seg.get("conditions")
						if err != nil || !visit(sc, depth+1) {
							return false
						}
					}
				}
			} else if attr, _ := c.get("attribute"); attr.truthy() {
				add(attr.toString())
			}
		}
		return true
	}
	flag := own(bundle.Field("flags"), flagKey)
	rules, _ := flag.get("rules")
	if rules.k != kArray {
		return nil
	}
	for _, r := range rules.a {
		conds, err := r.get("conditions")
		if err != nil || !visit(conds, 0) {
			return nil
		}
		serve, _ := r.get("serve")
		if t, err := serve.get("type"); err != nil {
			return nil
		} else if isStr(t, "rollout") {
			by, _ := serve.get("bucketBy")
			if by.k == kUndefined || by.k == kNull {
				add("key")
			} else {
				add(by.toString())
			}
		}
	}
	return names
}
