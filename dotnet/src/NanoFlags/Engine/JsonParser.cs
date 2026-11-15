using System.Collections.Generic;
using System.Text;

namespace NanoFlags.Engine
{
    /// <summary><c>JSON.parse</c>.</summary>
    internal sealed class JsonParser
    {
        private readonly string _s;
        private int _i;

        internal JsonParser(string s) => _s = s ?? throw new System.ArgumentNullException(nameof(s));

        internal JsonValue ParseDocument()
        {
            Ws();
            var v = Value(0);
            Ws();
            if (_i != _s.Length) throw Fail("unexpected trailing data");
            return v;
        }

        private InvalidJsonException Fail(string msg) => new InvalidJsonException("invalid JSON: " + msg + " at offset " + _i);

        private void Ws()
        {
            while (_i < _s.Length)
            {
                char c = _s[_i];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') _i++;
                else return;
            }
        }

        private JsonValue Value(int depth)
        {
            // Deep enough for any configuration; bounded so that hostile input cannot exhaust the stack.
            if (depth > JsonValue.MaxDepth) throw Fail("nesting too deep");
            if (_i >= _s.Length) throw Fail("unexpected end");
            char c = _s[_i];
            if (c == '{')
            {
                _i++;
                var b = new JsonValue.Obj.Builder();
                Ws();
                if (_i < _s.Length && _s[_i] == '}')
                {
                    _i++;
                    return b.Build();
                }
                while (true)
                {
                    Ws();
                    if (_i >= _s.Length || _s[_i] != '"') throw Fail("expected a string key");
                    var k = Str();
                    Ws();
                    if (_i >= _s.Length || _s[_i] != ':') throw Fail("expected ':'");
                    _i++;
                    Ws();
                    b.Put(k, Value(depth + 1));
                    Ws();
                    if (_i < _s.Length && _s[_i] == ',')
                    {
                        _i++;
                        continue;
                    }
                    if (_i < _s.Length && _s[_i] == '}')
                    {
                        _i++;
                        return b.Build();
                    }
                    throw Fail("expected ',' or '}'");
                }
            }
            if (c == '[')
            {
                _i++;
                var list = new List<JsonValue>();
                Ws();
                if (_i < _s.Length && _s[_i] == ']')
                {
                    _i++;
                    return new JsonValue.Arr(list, true);
                }
                while (true)
                {
                    Ws();
                    list.Add(Value(depth + 1));
                    Ws();
                    if (_i < _s.Length && _s[_i] == ',')
                    {
                        _i++;
                        continue;
                    }
                    if (_i < _s.Length && _s[_i] == ']')
                    {
                        _i++;
                        return new JsonValue.Arr(list, true);
                    }
                    throw Fail("expected ',' or ']'");
                }
            }
            if (c == '"') return new JsonValue.Str(Str());
            if (c == 't') return Lit("true", JsonValue.True);
            if (c == 'f') return Lit("false", JsonValue.False);
            if (c == 'n') return Lit("null", JsonValue.Null);
            if (c == '-' || (c >= '0' && c <= '9')) return Number();
            throw Fail("unexpected character");
        }

        private JsonValue Lit(string word, JsonValue v)
        {
            if (string.CompareOrdinal(_s, _i, word, 0, word.Length) != 0) throw Fail("invalid literal");
            _i += word.Length;
            return v;
        }

        private int Digits()
        {
            int n = 0;
            while (_i < _s.Length && _s[_i] >= '0' && _s[_i] <= '9')
            {
                _i++;
                n++;
            }
            return n;
        }

        private JsonValue Number()
        {
            int start = _i;
            if (_s[_i] == '-') _i++;
            if (_i < _s.Length && _s[_i] == '0') _i++;
            else if (Digits() == 0) throw Fail("invalid number");
            if (_i < _s.Length && _s[_i] == '.')
            {
                _i++;
                if (Digits() == 0) throw Fail("invalid number");
            }
            if (_i < _s.Length && (_s[_i] == 'e' || _s[_i] == 'E'))
            {
                _i++;
                if (_i < _s.Length && (_s[_i] == '+' || _s[_i] == '-')) _i++;
                if (Digits() == 0) throw Fail("invalid number");
            }
            return new JsonValue.Num(DoubleConv.ParseDecimal(_s.Substring(start, _i - start)));
        }

        private static int Hex(char h)
        {
            if (h >= '0' && h <= '9') return h - '0';
            if (h >= 'a' && h <= 'f') return h - 'a' + 10;
            if (h >= 'A' && h <= 'F') return h - 'A' + 10;
            return -1;
        }

        private string Str()
        {
            _i++; // opening quote
            var sb = new StringBuilder();
            while (true)
            {
                int start = _i;
                while (_i < _s.Length)
                {
                    char ch = _s[_i];
                    if (ch == '"' || ch == '\\' || ch < ' ') break;
                    _i++;
                }
                sb.Append(_s, start, _i - start);
                if (_i >= _s.Length) throw Fail("unterminated string");
                char c = _s[_i];
                if (c == '"')
                {
                    _i++;
                    return sb.ToString();
                }
                if (c < ' ') throw Fail("control character in string");
                _i++;
                if (_i >= _s.Length) throw Fail("unterminated escape");
                char e = _s[_i++];
                switch (e)
                {
                    case '"':
                    case '\\':
                    case '/':
                        sb.Append(e);
                        break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                    {
                        if (_s.Length - _i < 4) throw Fail("invalid unicode escape");
                        int u = 0;
                        for (int j = 0; j < 4; j++)
                        {
                            int d = Hex(_s[_i + j]);
                            if (d < 0) throw Fail("invalid unicode escape");
                            u = (u << 4) | d;
                        }
                        _i += 4;
                        sb.Append((char)u); // surrogates, paired or lone, are code units as in JavaScript
                        break;
                    }
                    default:
                        throw Fail("invalid escape");
                }
            }
        }
    }
}
