using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using NanoFlags.Engine;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;

namespace NanoFlags.Tests
{
    /// <summary>
    /// A fake NanoFlags edge (Kestrel) that signs like the real publisher (Ed25519 over the canonical string, kid in a
    /// header), serves /v1/bundle (ETag / 304), /v1/keys, /v1/live (WebSocket: hello, rev, ping/pong, close codes),
    /// /v1/stream (SSE), /v1/session (test sessions) and records /v1/events.
    /// </summary>
    internal sealed class FakeEdge : IAsyncDisposable
    {
        internal const string Flags = "{\"new-checkout\":{\"type\":\"boolean\",\"enabled\":true,\"clientExposed\":true,\"default\":false,\"off\":false,\"rules\":["
            + "{\"id\":\"pro\",\"match\":\"all\",\"conditions\":[{\"attribute\":\"plan\",\"op\":\"eq\",\"value\":\"pro\"}],\"serve\":{\"type\":\"fixed\",\"value\":true}},"
            + "{\"id\":\"beta\",\"match\":\"all\",\"conditions\":[{\"op\":\"segment\",\"value\":\"beta-testers\"}],\"serve\":{\"type\":\"fixed\",\"value\":true}}]},"
            + "\"accent\":{\"type\":\"string\",\"enabled\":true,\"clientExposed\":true,\"default\":\"blue\",\"off\":\"blue\",\"rules\":[]},"
            + "\"limit\":{\"type\":\"number\",\"enabled\":true,\"clientExposed\":true,\"default\":3,\"off\":0,\"rules\":[]},"
            + "\"ratio\":{\"type\":\"number\",\"enabled\":true,\"clientExposed\":true,\"default\":0.25,\"off\":0,\"rules\":[]},"
            + "\"theme\":{\"type\":\"json\",\"enabled\":true,\"clientExposed\":true,\"default\":{\"dark\":true,\"radius\":4},\"off\":null,\"rules\":[]},"
            + "\"disabled\":{\"type\":\"boolean\",\"enabled\":false,\"clientExposed\":true,\"default\":true,\"off\":false,\"rules\":[]},"
            + "\"rollout\":{\"type\":\"boolean\",\"enabled\":true,\"clientExposed\":true,\"default\":false,\"off\":false,\"rules\":["
            + "{\"id\":\"half\",\"match\":\"all\",\"conditions\":[],\"serve\":{\"type\":\"rollout\",\"percentage\":50,\"value\":true,\"otherwise\":false}}]}}";

        internal const string Segments = "{\"beta-testers\":{\"match\":\"any\",\"conditions\":[{\"attribute\":\"email\",\"op\":\"ends_with\",\"value\":\"@example.com\"}]}}";

        internal sealed class Key
        {
            internal Key(string kid)
            {
                Kid = kid;
                var gen = new Ed25519KeyPairGenerator();
                gen.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
                var pair = gen.GenerateKeyPair();
                Priv = (Ed25519PrivateKeyParameters)pair.Private;
                Jwk = Jwk.Ed25519(B64Url(((Ed25519PublicKeyParameters)pair.Public).GetEncoded()), kid);
            }

            internal string Kid { get; }
            internal Ed25519PrivateKeyParameters Priv { get; }
            internal Jwk Jwk { get; }

            internal string Sign(byte[] msg)
            {
                var s = new Ed25519Signer();
                s.Init(true, Priv);
                s.BlockUpdate(msg, 0, msg.Length);
                return B64Url(s.GenerateSignature());
            }
        }

        internal static string B64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private readonly WebApplication _app;
        internal readonly Key Key1 = new Key("t1");
        internal volatile Key SigningKey;
        internal readonly ConcurrentBag<Key> Published = new ConcurrentBag<Key>();
        internal volatile string EnvironmentId = "env-test-1";

        private long _revision;
        internal long Revision => Interlocked.Read(ref _revision);
        internal volatile string BundleText = "";
        internal volatile string Checksum = "";
        internal volatile bool Signed = true;
        internal volatile bool TamperHttp;
        internal volatile int BundleStatus = 200;
        internal volatile bool StaleHeader;
        internal volatile bool LiveEnabled = true;
        internal volatile bool SseEnabled;
        internal long? CommittedAt;

        internal int BundleRequests, NotModified, KeysRequests, LiveConnects, StreamRequests;
        internal readonly ConcurrentQueue<(string Path, string Authorization, string UserAgent)> Requests = new ConcurrentQueue<(string, string, string)>();
        internal readonly ConcurrentQueue<JsonValue> Events = new ConcurrentQueue<JsonValue>();
        /// <summary>GET /v1/session: token → (status, body); unknown tokens answer 404 like the edge.</summary>
        internal readonly ConcurrentDictionary<string, Func<(int Status, string Body)>> Sessions = new ConcurrentDictionary<string, Func<(int, string)>>();
        internal readonly ConcurrentQueue<IHeaderDictionary> SessionRequests = new ConcurrentQueue<IHeaderDictionary>();
        private readonly ConcurrentDictionary<WebSocket, SemaphoreSlim> _sockets = new ConcurrentDictionary<WebSocket, SemaphoreSlim>();

        internal int SocketCount => _sockets.Count;

        private FakeEdge()
        {
            SigningKey = Key1;
            Published.Add(Key1);
            SetFlags(1, Flags, 1);
            var builder = WebApplication.CreateSlimBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            _app = builder.Build();
            _app.UseWebSockets();
            _app.Run(HandleAsync);
        }

        internal static async Task<FakeEdge> StartAsync()
        {
            var e = new FakeEdge();
            await e._app.StartAsync().ConfigureAwait(false);
            e.BaseUrl = e._app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First().TrimEnd('/');
            return e;
        }

        internal string BaseUrl { get; private set; } = "";

        /// <summary>Replaces the configuration with a new revision (JSON text exactly as the publisher stores it).</summary>
        internal void SetFlags(long rev, string flags, int? engine)
        {
            var text = "{\"schema\":1," + (engine != null ? "\"engine\":" + engine + "," : "") + "\"project\":\"p\",\"environment\":\"production\",\"revision\":" + rev
                + ",\"flags\":" + flags + ",\"segments\":" + Segments + "}";
            BundleText = text;
            Checksum = "c" + rev + "-" + ((uint)text.GetHashCode()).ToString("x");
            Interlocked.Exchange(ref _revision, rev);
        }

        internal string Signature(string text, long rev, string sum, string env) => SigningKey.Sign(Signatures.CanonicalString(env, rev, sum, Encoding.UTF8.GetBytes(text)));

        internal string RevMessage(string type, bool tamper, string env)
        {
            var text = tamper ? BundleText.Replace("\"default\":false", "\"default\":true") : BundleText;
            return new JsonValue.Obj.Builder()
                .Put("t", new JsonValue.Str(type)).Put("revision", new JsonValue.Num(Revision)).Put("checksum", new JsonValue.Str(Checksum))
                .Put("signature", new JsonValue.Str(Signature(BundleText, Revision, Checksum, env))).Put("kid", new JsonValue.Str(SigningKey.Kid))
                .Put("environmentId", new JsonValue.Str(env)).Put("bundle", new JsonValue.Str(text))
                .Put("committedAt", CommittedAt == null ? JsonValue.Null : new JsonValue.Num(CommittedAt.Value))
                .Put("sentAt", new JsonValue.Num(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))
                .Build().ToJson()!;
        }

        private static async Task SendAsync(WebSocket ws, SemaphoreSlim l, string text)
        {
            await l.WaitAsync().ConfigureAwait(false);
            try
            {
                await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // the client went away
            }
            finally
            {
                l.Release();
            }
        }

        /// <summary>Pushes the current revision to every connected socket.</summary>
        internal async Task PushAsync(bool tamper = false, string? env = null)
        {
            var msg = RevMessage("rev", tamper, env ?? EnvironmentId);
            foreach (var kv in _sockets) await SendAsync(kv.Key, kv.Value, msg).ConfigureAwait(false);
        }

        internal async Task CloseSocketsAsync(int code, string reason)
        {
            foreach (var kv in _sockets)
            {
                await kv.Value.WaitAsync().ConfigureAwait(false);
                try
                {
                    await kv.Key.CloseOutputAsync((WebSocketCloseStatus)code, reason, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // gone
                }
                finally
                {
                    kv.Value.Release();
                }
            }
        }

        private static bool Authed(HttpContext ctx)
        {
            var a = ctx.Request.Headers.Authorization.ToString();
            return a.StartsWith("Bearer nf_srv_", StringComparison.Ordinal) || a.StartsWith("Bearer nf_pub_", StringComparison.Ordinal);
        }

        private async Task HandleAsync(HttpContext ctx)
        {
            var path = ctx.Request.Path.Value ?? "";
            Requests.Enqueue((path, ctx.Request.Headers.Authorization.ToString(), ctx.Request.Headers.UserAgent.ToString()));
            switch (path)
            {
                case "/v1/keys":
                {
                    Interlocked.Increment(ref KeysRequests);
                    var keys = string.Join(",", Published.Select(k => $"{{\"kty\":\"OKP\",\"crv\":\"Ed25519\",\"x\":\"{k.Jwk.X}\",\"kid\":\"{k.Kid}\",\"alg\":\"EdDSA\",\"use\":\"sig\"}}"));
                    await ctx.Response.WriteAsync("{\"keys\":[" + keys + "]}").ConfigureAwait(false);
                    return;
                }
                case "/v1/bundle":
                {
                    Interlocked.Increment(ref BundleRequests);
                    if (!Authed(ctx))
                    {
                        ctx.Response.StatusCode = 401;
                        await ctx.Response.WriteAsync("{\"error\":{\"code\":\"unauthorized\"}}").ConfigureAwait(false);
                        return;
                    }
                    if (BundleStatus != 200)
                    {
                        ctx.Response.StatusCode = BundleStatus;
                        return;
                    }
                    var text0 = BundleText;
                    var rev = Revision;
                    var sum = Checksum;
                    var etag = "\"" + sum + "-server\"";
                    var h = ctx.Response.Headers;
                    h["ETag"] = etag;
                    h["X-NanoFlags-Environment-Id"] = EnvironmentId;
                    h["X-NanoFlags-Signed"] = Signed ? "true" : "false";
                    if (StaleHeader) h["X-NanoFlags-Stale"] = "true";
                    if (Signed)
                    {
                        h["X-NanoFlags-Signature"] = Signature(text0, rev, sum, EnvironmentId);
                        h["X-NanoFlags-Key-Id"] = SigningKey.Kid;
                    }
                    if (ctx.Request.Headers.IfNoneMatch.ToString() == etag)
                    {
                        Interlocked.Increment(ref NotModified);
                        ctx.Response.StatusCode = 304;
                        return;
                    }
                    var text = TamperHttp ? text0.Replace("\"default\":false", "\"default\":true") : text0;
                    await ctx.Response.WriteAsync("{\"revision\":" + rev + ",\"checksum\":\"" + sum + "\",\"bundle\":" + text + "}").ConfigureAwait(false);
                    return;
                }
                case "/v1/live":
                {
                    Interlocked.Increment(ref LiveConnects);
                    if (!ctx.WebSockets.IsWebSocketRequest || !Authed(ctx) || !LiveEnabled || ctx.Request.Query.ContainsKey("key"))
                    {
                        ctx.Response.StatusCode = 503;
                        return;
                    }
                    if (!ctx.WebSockets.WebSocketRequestedProtocols.Contains(NanoFlagsClient.LiveProtocol))
                    {
                        ctx.Response.StatusCode = 400;
                        return;
                    }
                    using var ws = await ctx.WebSockets.AcceptWebSocketAsync(NanoFlagsClient.LiveProtocol).ConfigureAwait(false);
                    var l = new SemaphoreSlim(1, 1);
                    _sockets[ws] = l;
                    await SendAsync(ws, l, RevMessage("hello", false, EnvironmentId)).ConfigureAwait(false);
                    var buf = new byte[65536];
                    try
                    {
                        while (true)
                        {
                            var r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), ctx.RequestAborted).ConfigureAwait(false);
                            if (r.MessageType == WebSocketMessageType.Close)
                            {
                                if (ws.State == WebSocketState.CloseReceived)
                                {
                                    await l.WaitAsync().ConfigureAwait(false);
                                    try
                                    {
                                        await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None).ConfigureAwait(false);
                                    }
                                    finally
                                    {
                                        l.Release();
                                    }
                                }
                                break;
                            }
                            if (Encoding.UTF8.GetString(buf, 0, r.Count) == "ping") await SendAsync(ws, l, "pong").ConfigureAwait(false);
                        }
                    }
                    catch (Exception)
                    {
                        // client gone
                    }
                    finally
                    {
                        _sockets.TryRemove(ws, out _);
                    }
                    return;
                }
                case "/v1/stream":
                {
                    Interlocked.Increment(ref StreamRequests);
                    if (!Authed(ctx))
                    {
                        ctx.Response.StatusCode = 401;
                        return;
                    }
                    if (!SseEnabled)
                    {
                        ctx.Response.StatusCode = 503;
                        return;
                    }
                    ctx.Response.ContentType = "text/event-stream";
                    await ctx.Response.WriteAsync(": hello\n\nevent: revision\ndata: {\"revision\":" + Revision + ",\"checksum\":\"" + Checksum + "\"}\n\n").ConfigureAwait(false);
                    return;
                }
                case "/v1/session":
                {
                    SessionRequests.Enqueue(new HeaderDictionary(ctx.Request.Headers.ToDictionary(h => h.Key, h => h.Value)));
                    if (!Authed(ctx))
                    {
                        ctx.Response.StatusCode = 401;
                        return;
                    }
                    if (!Sessions.TryGetValue(ctx.Request.Headers["X-NanoFlags-Session"].ToString(), out var make))
                    {
                        ctx.Response.StatusCode = 404;
                        await ctx.Response.WriteAsync("{\"error\":{\"code\":\"session_not_found\",\"message\":\"x\"}}").ConfigureAwait(false);
                        return;
                    }
                    var (status, body) = make();
                    ctx.Response.StatusCode = status;
                    ctx.Response.Headers.CacheControl = "no-store";
                    await ctx.Response.WriteAsync(body).ConfigureAwait(false);
                    return;
                }
                case "/v1/events":
                {
                    using var reader = new StreamReader(ctx.Request.Body, Encoding.UTF8);
                    Events.Enqueue(JsonValue.Parse(await reader.ReadToEndAsync().ConfigureAwait(false)));
                    ctx.Response.StatusCode = 202;
                    await ctx.Response.WriteAsync("{\"accepted\":1}").ConfigureAwait(false);
                    return;
                }
                default:
                    ctx.Response.StatusCode = 404;
                    return;
            }
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                await CloseSocketsAsync(1001, "shutdown").ConfigureAwait(false);
            }
            catch (Exception)
            {
                // ignore
            }
            await _app.StopAsync().ConfigureAwait(false);
            await _app.DisposeAsync().ConfigureAwait(false);
        }
    }
}
