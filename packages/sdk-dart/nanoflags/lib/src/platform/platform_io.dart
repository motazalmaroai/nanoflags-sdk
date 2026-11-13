// Native platforms (Dart VM, Flutter on Android, iOS, macOS, Windows, Linux): dart:io networking.
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Short platform name for the User-Agent and telemetry.
String platformName() => Platform.operatingSystem;

/// Native WebSockets can carry headers: the key travels in `Authorization`, never in the URL.
const bool keyInSubprotocol = false;

/// A native client with the SDK's User-Agent. Proxies from the environment (`HTTPS_PROXY`,
/// `NO_PROXY`) are honoured, as most native HTTP stacks do.
HttpClient _newHttpClient(String userAgent) => HttpClient()
  ..userAgent = userAgent
  ..connectionTimeout = const Duration(seconds: 10)
  ..idleTimeout = const Duration(seconds: 30)
  ..findProxy = HttpClient.findProxyFromEnvironment;

http.Client createHttpClient(String userAgent) => IOClient(_newHttpClient(userAgent));

WebSocketChannel connectWebSocket(Uri uri, {required List<String> protocols, required Map<String, String> headers, required String userAgent, required Duration connectTimeout}) =>
    IOWebSocketChannel.connect(uri, protocols: protocols, headers: headers, connectTimeout: connectTimeout, customClient: _newHttpClient(userAgent));
