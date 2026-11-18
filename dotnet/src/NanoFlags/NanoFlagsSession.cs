using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace NanoFlags
{
    /// <summary>
    /// Test-session propagation for servers. The session of the request being handled lives in an
    /// <see cref="AsyncLocal{T}"/>: it follows the request through awaits and the tasks it starts, is invisible to every
    /// other request, and ends with the scope. Nothing is stored on the client.
    /// </summary>
    /// <remarks>
    /// ASP.NET Core (no extra package is needed in the SDK):
    /// <code>
    /// app.Use(async (http, next) =>
    /// {
    ///     using (NanoFlagsSession.Begin(http.Request.Headers[NanoFlagsSession.Header].FirstOrDefault()))
    ///     {
    ///         await NanoFlagsSession.FlagsForAsync(flags); // resolve once, before the endpoint runs
    ///         await next();
    ///     }
    /// });
    ///
    /// app.MapGet("/cart", () => NanoFlagsSession.FlagsFor(flags).BoolVariation("checkout-v2", ctx, false));
    /// services.AddHttpClient("pricing").AddHttpMessageHandler(() => new NanoFlagsSessionHandler()); // next service joins
    /// </code>
    /// </remarks>
    public static class NanoFlagsSession
    {
        /// <summary>The header that carries a test-session token between services (<c>"x-nanoflags-session"</c>).</summary>
        public const string Header = Sessions.Header;

        private sealed class Scope
        {
            internal Scope(string? token) => Token = token;

            internal string? Token { get; } // null: outside any session
            internal readonly ConcurrentDictionary<NanoFlagsClient, Task<SessionEvaluator>> Evaluators = new ConcurrentDictionary<NanoFlagsClient, Task<SessionEvaluator>>();
        }

        private sealed class Restore : IDisposable
        {
            private readonly Scope? _previous;
            private int _done;

            internal Restore(Scope? previous) => _previous = previous;

            public void Dispose()
            {
                if (Interlocked.Exchange(ref _done, 1) == 0) Current.Value = _previous;
            }
        }

        private static readonly AsyncLocal<Scope?> Current = new AsyncLocal<Scope?>();

        private static string? Clean(string? token)
        {
            var t = token?.Trim();
            return Sessions.IsToken(t) ? t : null;
        }

        /// <summary>
        /// Makes <paramref name="token"/> the current test session of this async flow until the returned scope is disposed
        /// (which restores the previous one). An absent or malformed token runs the scope outside any session.
        /// </summary>
        public static IDisposable Begin(string? token)
        {
            var previous = Current.Value;
            Current.Value = new Scope(Clean(token));
            return new Restore(previous);
        }

        /// <summary>Runs <paramref name="fn"/> with <paramref name="token"/> as the current test session.</summary>
        public static T Run<T>(string? token, Func<T> fn)
        {
            if (fn == null) throw new ArgumentNullException(nameof(fn));
            using (Begin(token)) return fn();
        }

        /// <summary>Runs <paramref name="fn"/> (and everything it awaits) with <paramref name="token"/> as the current test session.</summary>
        public static async Task<T> RunAsync<T>(string? token, Func<Task<T>> fn)
        {
            if (fn == null) throw new ArgumentNullException(nameof(fn));
            using (Begin(token)) return await fn().ConfigureAwait(false);
        }

        /// <summary>Runs <paramref name="fn"/> (and everything it awaits) with <paramref name="token"/> as the current test session.</summary>
        public static async Task RunAsync(string? token, Func<Task> fn)
        {
            if (fn == null) throw new ArgumentNullException(nameof(fn));
            using (Begin(token)) await fn().ConfigureAwait(false);
        }

        /// <summary>The token of the test session the current request belongs to, or null.</summary>
        public static string? CurrentSession => Current.Value?.Token;

        /// <summary>Headers to add to downstream calls so that the next service joins the same session; empty outside a session.</summary>
        public static IReadOnlyDictionary<string, string> Headers()
        {
            var t = CurrentSession;
            return t == null ? new Dictionary<string, string>() : new Dictionary<string, string> { [Header] = t };
        }

        /// <summary>
        /// The evaluator for the current request: session-scoped inside <see cref="Begin"/> / <see cref="RunAsync{T}"/>,
        /// otherwise equivalent to the client. Resolved once per scope and client. Never throws.
        /// </summary>
        public static Task<SessionEvaluator> FlagsForAsync(NanoFlagsClient client, string? service = null, CancellationToken cancellationToken = default)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));
            var scope = Current.Value;
            if (scope?.Token == null) return Task.FromResult(new SessionEvaluator(client, null));
            var task = scope.Evaluators.GetOrAdd(client, c => c.SessionAsync(scope.Token, service));
            if (task.IsCompleted || !cancellationToken.CanBeCanceled) return task;
            return WaitAsync(client, task, cancellationToken);
        }

        private static async Task<SessionEvaluator> WaitAsync(NanoFlagsClient client, Task<SessionEvaluator> task, CancellationToken ct)
        {
            var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            using (ct.Register(() => cancelled.TrySetResult(true)))
            {
                return await Task.WhenAny(task, cancelled.Task).ConfigureAwait(false) == task ? await task.ConfigureAwait(false) : new SessionEvaluator(client, null);
            }
        }

        /// <summary>
        /// Synchronous evaluator for code that runs after the session was resolved (by <see cref="FlagsForAsync"/>, e.g. in
        /// a middleware). Never blocks: while the session is not resolved yet, or outside a session, it evaluates like the client.
        /// </summary>
        public static SessionEvaluator FlagsFor(NanoFlagsClient client)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));
            var scope = Current.Value;
            if (scope?.Token != null && scope.Evaluators.TryGetValue(client, out var task) && task.Status == TaskStatus.RanToCompletion) return task.Result;
            return new SessionEvaluator(client, null);
        }
    }

    /// <summary>
    /// An <see cref="HttpClient"/> handler that adds <c>x-nanoflags-session</c> to every outgoing request made inside a test
    /// session (see <see cref="NanoFlagsSession"/>), so downstream services join it. A header already set is kept.
    /// </summary>
    public sealed class NanoFlagsSessionHandler : DelegatingHandler
    {
        /// <summary>A handler for <c>IHttpClientFactory</c> pipelines (the inner handler is set by the factory).</summary>
        public NanoFlagsSessionHandler() { }

        /// <summary>A handler that sends through <paramref name="innerHandler"/>.</summary>
        public NanoFlagsSessionHandler(HttpMessageHandler innerHandler) : base(innerHandler) { }

        /// <inheritdoc/>
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var t = NanoFlagsSession.CurrentSession;
            if (t != null && !request.Headers.Contains(NanoFlagsSession.Header)) request.Headers.TryAddWithoutValidation(NanoFlagsSession.Header, t);
            return base.SendAsync(request, cancellationToken);
        }
    }
}
