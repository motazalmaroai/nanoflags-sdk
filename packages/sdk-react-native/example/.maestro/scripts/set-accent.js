// Maestro script: set `demo-accent` to env VALUE through the public demo endpoint (used to restore the original value).
var EDGE = "https://edge.nanoflags.io";
var HEADERS = { "User-Agent": "nanoflags-react-native-e2e", "Content-Type": "application/json" };
if (typeof VALUE === "string" && VALUE !== "") {
  var res = http.post(EDGE + "/v1/demo/toggle", { headers: HEADERS, body: JSON.stringify({ flag: "demo-accent", value: VALUE }) });
  console.log("restore demo-accent=" + VALUE + ": HTTP " + res.status + " " + res.body);
}
