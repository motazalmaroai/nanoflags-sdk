// Maestro script (GraalJS): publish the next `demo-accent` value through the PUBLIC live-demo endpoint of the edge
// (no key needed; rate limited — the flows toggle at most twice and restore the value afterwards).
// Outputs: output.previous (value before), output.next (value published).
var EDGE = "https://edge.nanoflags.io";
var HEADERS = { "User-Agent": "nanoflags-react-native-e2e", "Content-Type": "application/json" };
var COLORS = ["blue", "orange", "green"];

var state = json(http.get(EDGE + "/v1/demo", { headers: HEADERS }).body);
var current = state.values["demo-accent"];
var next = COLORS[(COLORS.indexOf(current) + 1) % COLORS.length];

var res = http.post(EDGE + "/v1/demo/toggle", { headers: HEADERS, body: JSON.stringify({ flag: "demo-accent", value: next }) });
if (res.status !== 200) throw new Error("demo toggle failed: HTTP " + res.status + " " + res.body);
var body = json(res.body);
if (body.status !== "published" && body.status !== "unchanged") throw new Error("demo toggle answered " + res.body);

output.previous = current;
output.next = next;
console.log("demo-accent " + current + " -> " + next + " (" + body.status + (body.revision ? ", r" + body.revision : "") + ")");
