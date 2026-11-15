package io.nanoflags.server.engine;

import java.util.ArrayList;
import java.util.List;

/** {@code JSON.parse}. */
final class JsonParser {
    private final String s;
    private int i;

    JsonParser(String s) { this.s = s; }

    JsonValue parseDocument() {
        ws();
        JsonValue v = value(0);
        ws();
        if (i != s.length()) throw fail("unexpected trailing data");
        return v;
    }

    private InvalidJsonException fail(String msg) {
        return new InvalidJsonException("invalid JSON: " + msg + " at offset " + i);
    }

    private void ws() {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
            else return;
        }
    }

    private JsonValue value(int depth) {
        if (depth > 10_000) throw fail("nesting too deep");
        if (i >= s.length()) throw fail("unexpected end");
        char c = s.charAt(i);
        if (c == '{') {
            i++;
            JsonValue.Obj.Builder b = new JsonValue.Obj.Builder();
            ws();
            if (i < s.length() && s.charAt(i) == '}') {
                i++;
                return b.build();
            }
            while (true) {
                ws();
                if (i >= s.length() || s.charAt(i) != '"') throw fail("expected a string key");
                String k = str();
                ws();
                if (i >= s.length() || s.charAt(i) != ':') throw fail("expected ':'");
                i++;
                ws();
                b.put(k, value(depth + 1));
                ws();
                if (i < s.length() && s.charAt(i) == ',') {
                    i++;
                    continue;
                }
                if (i < s.length() && s.charAt(i) == '}') {
                    i++;
                    return b.build();
                }
                throw fail("expected ',' or '}'");
            }
        }
        if (c == '[') {
            i++;
            List<JsonValue> out = new ArrayList<>();
            ws();
            if (i < s.length() && s.charAt(i) == ']') {
                i++;
                return new JsonValue.Arr(out, true);
            }
            while (true) {
                ws();
                out.add(value(depth + 1));
                ws();
                if (i < s.length() && s.charAt(i) == ',') {
                    i++;
                    continue;
                }
                if (i < s.length() && s.charAt(i) == ']') {
                    i++;
                    return new JsonValue.Arr(out, true);
                }
                throw fail("expected ',' or ']'");
            }
        }
        if (c == '"') return new JsonValue.Str(str());
        if (c == 't') return lit("true", JsonValue.TRUE);
        if (c == 'f') return lit("false", JsonValue.FALSE);
        if (c == 'n') return lit("null", JsonValue.NULL);
        if (c == '-' || (c >= '0' && c <= '9')) return number();
        throw fail("unexpected character");
    }

    private JsonValue lit(String word, JsonValue v) {
        if (!s.startsWith(word, i)) throw fail("invalid literal");
        i += word.length();
        return v;
    }

    private int digits() {
        int n = 0;
        while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
            i++;
            n++;
        }
        return n;
    }

    private JsonValue number() {
        int start = i;
        if (s.charAt(i) == '-') i++;
        if (i < s.length() && s.charAt(i) == '0') i++;
        else if (digits() == 0) throw fail("invalid number");
        if (i < s.length() && s.charAt(i) == '.') {
            i++;
            if (digits() == 0) throw fail("invalid number");
        }
        if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
            i++;
            if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
            if (digits() == 0) throw fail("invalid number");
        }
        return new JsonValue.Num(Double.parseDouble(s.substring(start, i)));
    }

    private String str() {
        i++; // opening quote
        StringBuilder sb = new StringBuilder();
        while (true) {
            int start = i;
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == '"' || c == '\\' || c < ' ') break;
                i++;
            }
            sb.append(s, start, i);
            if (i >= s.length()) throw fail("unterminated string");
            char c = s.charAt(i);
            if (c == '"') {
                i++;
                return sb.toString();
            }
            if (c < ' ') throw fail("control character in string");
            i++;
            if (i >= s.length()) throw fail("unterminated escape");
            char e = s.charAt(i++);
            switch (e) {
                case '"':
                case '\\':
                case '/':
                    sb.append(e);
                    break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'n': sb.append('\n'); break;
                case 'r': sb.append('\r'); break;
                case 't': sb.append('\t'); break;
                case 'u': {
                    if (s.length() - i < 4) throw fail("invalid unicode escape");
                    int u = 0;
                    for (int j = 0; j < 4; j++) {
                        char h = s.charAt(i + j);
                        int d = h > 0x7f ? -1 : Character.digit(h, 16);
                        if (d < 0) throw fail("invalid unicode escape");
                        u = (u << 4) | d;
                    }
                    i += 4;
                    sb.append((char) u); // surrogates, paired or lone, are code units as in JavaScript
                    break;
                }
                default:
                    throw fail("invalid escape");
            }
        }
    }
}
