package io.nanoflags.server;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Listener registry; callbacks run one at a time, in order, on one thread of the client. A listener never breaks the client. */
final class Listeners {
    final List<Consumer<ChangeEvent>> change = new CopyOnWriteArrayList<>();
    final List<Consumer<NanoFlagsException>> errors = new CopyOnWriteArrayList<>();
    final List<Consumer<Status>> status = new CopyOnWriteArrayList<>();

    private final ExecutorService executor;

    Listeners() {
        ThreadPoolExecutor e = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<>(), NanoFlagsClient.daemon("nanoflags-listeners"));
        e.allowCoreThreadTimeOut(true);
        this.executor = e;
    }

    <T> Subscription add(List<Consumer<T>> list, Consumer<T> listener) {
        java.util.Objects.requireNonNull(listener, "listener");
        // A wrapper so that registering the same listener twice yields two independent subscriptions.
        Consumer<T> entry = listener::accept;
        list.add(entry);
        return () -> list.remove(entry);
    }

    <T> void emit(List<Consumer<T>> list, T value) {
        if (list.isEmpty()) return;
        Object[] snapshot = list.toArray();
        try {
            executor.execute(() -> {
                for (Object o : snapshot) {
                    try {
                        @SuppressWarnings("unchecked")
                        Consumer<T> c = (Consumer<T>) o;
                        c.accept(value);
                    } catch (RuntimeException ignored) {
                        // a listener must never break the client
                    }
                }
            });
        } catch (RejectedExecutionException ignored) {
            // closed
        }
    }

    void shutdown() {
        executor.shutdown();
        try {
            executor.awaitTermination(1, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
