using System;
using System.Collections.Concurrent;
using System.Threading;

namespace NanoFlags
{
    /// <summary>Runs event handlers one at a time, in order, on one background thread. A handler never breaks the client.</summary>
    internal sealed class Dispatcher
    {
        private readonly BlockingCollection<Action> _queue = new BlockingCollection<Action>();
        private readonly Thread _thread;

        internal Dispatcher()
        {
            _thread = new Thread(Run) { IsBackground = true, Name = "nanoflags-events" };
            _thread.Start();
        }

        internal void Post(Action a)
        {
            try
            {
                _queue.Add(a);
            }
            catch (InvalidOperationException)
            {
                // shut down
            }
        }

        private void Run()
        {
            foreach (var a in _queue.GetConsumingEnumerable())
            {
                try
                {
                    a();
                }
                catch (Exception)
                {
                    // a handler must never break the client
                }
            }
        }

        internal void Shutdown()
        {
            _queue.CompleteAdding();
            if (Thread.CurrentThread != _thread) _thread.Join(1000);
        }
    }
}
