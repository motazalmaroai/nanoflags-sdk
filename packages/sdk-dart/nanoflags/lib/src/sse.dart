import 'dart:async';
import 'dart:convert';

/// Minimal server-sent-events reader: calls [onEvent] with each event's name and data.
Future<void> readSse(Stream<List<int>> body, void Function(String event, String data) onEvent) async {
  var buffer = '';
  void dispatch(String block) {
    var event = 'message';
    final data = <String>[];
    for (final line in block.split('\n')) {
      if (line.isEmpty || line.startsWith(':')) continue;
      final i = line.indexOf(':');
      final field = i == -1 ? line : line.substring(0, i);
      var value = i == -1 ? '' : line.substring(i + 1);
      if (value.startsWith(' ')) value = value.substring(1);
      if (field == 'event') {
        event = value;
      } else if (field == 'data') {
        data.add(value);
      }
    }
    if (data.isNotEmpty) onEvent(event, data.join('\n'));
  }

  await for (final chunk in body.transform(const Utf8Decoder(allowMalformed: true))) {
    buffer = (buffer + chunk).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    int i;
    while ((i = buffer.indexOf('\n\n')) != -1) {
      dispatch(buffer.substring(0, i));
      buffer = buffer.substring(i + 2);
    }
    if (buffer.length > 65536) buffer = ''; // never buffer unbounded garbage
  }
}
