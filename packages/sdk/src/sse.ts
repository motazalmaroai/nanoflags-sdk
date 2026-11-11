/** Minimal server-sent-events reader for fetch streams (Node, workers, browsers without EventSource auth). */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) onEvent(event, data.join("\n"));
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n?/g, "\n");
      let i: number;
      while ((i = buffer.indexOf("\n\n")) !== -1) {
        dispatch(buffer.slice(0, i));
        buffer = buffer.slice(i + 2);
      }
      if (buffer.length > 65_536) buffer = ""; // defensive: never buffer unbounded garbage
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
