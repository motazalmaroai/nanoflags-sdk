/**
 * @nanoflags/sdk/node — test-session propagation for Node servers.
 *
 * The session of the request being handled lives in AsyncLocalStorage: it follows the request
 * through awaits, timers and callbacks, is invisible to every other request, and disappears when
 * the request's async chain ends. Nothing is stored on the client or in module-level variables.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { SESSION_HEADER, isSessionToken, type FlagEvaluator, type NanoFlagsClient, type SessionEvaluator, type SessionOptions } from "./index.js";

export { SESSION_HEADER } from "./index.js";

interface Scope {
  token: string;
  /** Evaluators resolved for this request, per client. */
  evaluators: Map<object, SessionEvaluator>;
}

const storage = new AsyncLocalStorage<Scope | null>();

type SessionClient = Pick<NanoFlagsClient, "session"> & FlagEvaluator & Pick<NanoFlagsClient, "revision">;

/** Run `fn` with `token` as the current test session. An absent or malformed token runs `fn` outside any session. */
export function withSession<T>(token: string | null | undefined, fn: () => T): T {
  return storage.run(isSessionToken(token) ? { token, evaluators: new Map() } : null, fn);
}

/** Token of the test session the current request belongs to, if any. */
export function currentSession(): string | undefined {
  return storage.getStore()?.token;
}

/** Headers to add to downstream calls so the next service joins the same session. `{}` outside a session. */
export function sessionHeaders(): Record<string, string> {
  const token = currentSession();
  return token === undefined ? {} : { [SESSION_HEADER]: token };
}

function passthrough(client: SessionClient): SessionEvaluator {
  return {
    active: false,
    id: null,
    expiresAt: null,
    get revision() {
      return client.revision;
    },
    boolean: (k, f, c) => client.boolean(k, f, c),
    string: (k, f, c) => client.string(k, f, c),
    number: (k, f, c) => client.number(k, f, c),
    json: (k, f, c) => client.json(k, f, c),
    evaluate: (k, f, c) => client.evaluate(k, f, c),
  };
}

/**
 * Evaluator for the current request: session-scoped inside `withSession` / the middleware,
 * otherwise equivalent to the client. Resolved once per request and client. Never rejects.
 */
export async function sessionFlags(client: SessionClient, options?: SessionOptions): Promise<SessionEvaluator> {
  const scope = storage.getStore();
  if (!scope) return passthrough(client);
  const hit = scope.evaluators.get(client);
  if (hit) return hit;
  let evaluator: SessionEvaluator;
  try {
    evaluator = await client.session(scope.token, options);
  } catch {
    evaluator = passthrough(client);
  }
  scope.evaluators.set(client, evaluator);
  return evaluator;
}

/**
 * Synchronous variant for code that runs after `sessionMiddleware` / `withSessionHandler` (which
 * resolve the session before the handler starts). Outside a resolved session it evaluates like the client.
 */
export function flagsFor(client: SessionClient): SessionEvaluator {
  return storage.getStore()?.evaluators.get(client) ?? passthrough(client);
}

function headerValue(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" ? first.trim() : undefined;
}

export interface NodeRequestLike {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Express/Connect middleware. Reads `x-nanoflags-session`, resolves the session once, and runs the
 * rest of the request inside it. `req.flags` (and `flagsFor(client)`) is the request's evaluator —
 * session-scoped when the session is active, otherwise the plain client behaviour.
 */
export function sessionMiddleware(client: SessionClient, options?: SessionOptions) {
  return function nanoflagsSession(req: NodeRequestLike & { flags?: SessionEvaluator }, _res: unknown, next: (err?: unknown) => void): void {
    const token = headerValue(req.headers?.[SESSION_HEADER]);
    withSession(token, () => {
      if (currentSession() === undefined) {
        req.flags = passthrough(client);
        return next();
      }
      // The continuation runs inside this request's async scope, so `next` keeps the session.
      void sessionFlags(client, options).then((flags) => {
        req.flags = flags;
        next();
      });
    });
  };
}

/**
 * Wrap a fetch-style handler (`(request, ...rest) => Response`): Node fetch servers, Hono, Next.js
 * route handlers on the Node runtime. The handler runs inside the request's session.
 */
export function withSessionHandler<A extends unknown[], R>(client: SessionClient, handler: (request: Request, ...rest: A) => R | Promise<R>, options?: SessionOptions): (request: Request, ...rest: A) => Promise<R> {
  return (request, ...rest) =>
    withSession(request.headers.get(SESSION_HEADER)?.trim(), async () => {
      await sessionFlags(client, options);
      return handler(request, ...rest);
    });
}
