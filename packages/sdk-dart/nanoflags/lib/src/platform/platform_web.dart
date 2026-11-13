// Web (Flutter web, dart2js, dart2wasm): fetch and the browser WebSocket.
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

String platformName() => 'web';

/// Browsers cannot set headers on a WebSocket: the key travels as a second subprotocol entry
/// (`["nanoflags.v1", "key.<key>"]`), never in the URL.
const bool keyInSubprotocol = true;

/// The browser sets its own User-Agent; it cannot be overridden here.
http.Client createHttpClient(String userAgent) => http.Client();

WebSocketChannel connectWebSocket(Uri uri, {required List<String> protocols, required Map<String, String> headers, required String userAgent, required Duration connectTimeout}) =>
    WebSocketChannel.connect(uri, protocols: protocols);
