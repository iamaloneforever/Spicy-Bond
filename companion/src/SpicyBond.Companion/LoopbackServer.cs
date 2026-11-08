using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace SpicyBond.Companion;

public sealed class LoopbackServer(string token, int port = LoopbackServer.Port, Func<string, CancellationToken, Task<string?>>? chooseExportPath = null)
{
    public const int Port = 43821;
    private static readonly HashSet<string> Origins = ["https://iamaloneforever.github.io", "http://127.0.0.1:4173", "http://127.0.0.1:5173"];
    public static bool IsAllowed(string host, string origin, int port = Port) => host == $"127.0.0.1:{port}" && Origins.Contains(origin);
    private readonly SemaphoreSlim connections = new(8);
    private readonly SemaphoreSlim exportDialog = new(1);
    private readonly object searchGate = new();
    private CancellationTokenSource? currentSearch;
    private readonly WallpaperSettingsStore wallpaperSettings = new();
    public async Task RunAsync(Func<PlaybackSnapshot> read, CancellationToken cancellation, Action<string, string, bool>? reportLyrics = null, Func<PlaybackSnapshot, string, string, CancellationToken, Task<MusicSearchResult>>? searchMusic = null)
    {
        var listener = new TcpListener(IPAddress.Loopback, port); listener.Start(16);
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                var client = await listener.AcceptTcpClientAsync(cancellation);
                if (!connections.Wait(0)) { client.Dispose(); continue; }
                _ = RespondAsync(client, read, cancellation, reportLyrics, searchMusic);
            }
        }
        finally { listener.Stop(); }
    }
    private async Task RespondAsync(TcpClient client, Func<PlaybackSnapshot> read, CancellationToken cancellation, Action<string, string, bool>? reportLyrics, Func<PlaybackSnapshot, string, string, CancellationToken, Task<MusicSearchResult>>? searchMusic)
    {
        using (client)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
        {
            timeout.CancelAfter(2000);
            try
            {
                using var stream = client.GetStream();
                var bytes = new byte[8192]; var count = 0; var end = -1;
                while (count < bytes.Length && end < 0)
                {
                    var loaded = await stream.ReadAsync(bytes.AsMemory(count, bytes.Length - count), timeout.Token);
                    if (loaded == 0) return;
                    count += loaded; end = Encoding.ASCII.GetString(bytes, 0, count).IndexOf("\r\n\r\n", StringComparison.Ordinal);
                }
                if (end < 0) return;
                var lines = Encoding.ASCII.GetString(bytes, 0, end).Split("\r\n");
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var line in lines.Skip(1))
                {
                    var colon = line.IndexOf(':');
                    if (colon <= 0 || !headers.TryAdd(line[..colon], line[(colon + 1)..].Trim())) return;
                }
                var request = lines[0].Split(' ');
                var allowed = IsAllowed(headers.GetValueOrDefault("Host", ""), headers.GetValueOrDefault("Origin", ""), port);
                var search = request.Length == 3 && request[1].StartsWith("/music-search?", StringComparison.Ordinal) && searchMusic is not null;
                var playbackEvents = request.Length == 3 && request[1] == "/playback-events";
                var preferences = request.Length == 3 && request[1] == "/wallpaper-settings";
                var export = request.Length == 3 && request[1] == "/effect-export";
                var receipt = request.Length == 3 && request[1] == "/lyrics-status" && reportLyrics is not null;
                var valid = request.Length == 3 && request[2] == "HTTP/1.1" && ((request[1] is "/now-playing" or "/now-playing?artwork=1" or "/inspector" or "/inspector?artwork=1" or "/playback-events") && request[0] is "GET" or "OPTIONS" || receipt && request[0] is "POST" or "OPTIONS" || search && request[0] is "GET" or "OPTIONS" || preferences && request[0] is "GET" or "POST" or "OPTIONS" || export && request[0] is "POST" or "OPTIONS");
                var supplied = headers.GetValueOrDefault("X-RetroWave-Key", "");
                var authenticated = request[0] == "OPTIONS" || System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(token));
                var code = !allowed || !authenticated ? "403 Forbidden" : !valid ? "404 Not Found" : "200 OK";
                if (allowed && authenticated && valid && playbackEvents && request[0] == "GET")
                {
                    timeout.CancelAfter(Timeout.Infinite);
                    var cors = $"Access-Control-Allow-Origin: {headers["Origin"]}\r\nAccess-Control-Allow-Private-Network: true\r\nVary: Origin\r\n";
                    await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\n{cors}Content-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: keep-alive\r\n\r\n"), timeout.Token);
                    await stream.FlushAsync(timeout.Token);
                    PlaybackSnapshot? previous = null;
                    long sentAt = 0;
                    while (!cancellation.IsCancellationRequested && client.Connected)
                    {
                        var current = read();
                        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        var changed = previous is null || current.TrackKey != previous.TrackKey || current.Status != previous.Status || current.IsPlaying != previous.IsPlaying || current.Rate != previous.Rate || current.Duration != previous.Duration;
                        var elapsed = previous is null ? 0 : Math.Max(0, (now - sentAt) / 1000d);
                        var expectedPosition = previous is null ? current.Position : previous.Position + (previous.IsPlaying ? elapsed * previous.Rate : 0);
                        var seeked = previous is not null && Math.Abs(current.Position - expectedPosition) >= 0.9;
                        var heartbeatMs = current.IsPlaying ? 1000 : 2000;
                        if (changed || seeked || previous is null || now - sentAt >= heartbeatMs)
                        {
                            var payload = current with { Thumbnail = "", Candidates = [], ProviderError = "", Providers = [], Genres = [] };
                            var message = Encoding.UTF8.GetBytes("data: " + JsonSerializer.Serialize(payload, PlaybackSnapshot.Json) + "\n\n");
                            await stream.WriteAsync(message, cancellation);
                            await stream.FlushAsync(cancellation);
                            previous = current; sentAt = now;
                        }
                        await Task.Delay(200, cancellation);
                    }
                    return;
                }
                if (allowed && authenticated && valid && receipt && request[0] == "POST")
                {
                    if (headers.ContainsKey("Transfer-Encoding") || !int.TryParse(headers.GetValueOrDefault("Content-Length"), out var length) || length is <= 0 or > 1024) code = "400 Bad Request";
                    else
                    {
                        var start = end + 4; var bodyBytes = new byte[length]; var available = Math.Min(length, count - start); Array.Copy(bytes, start, bodyBytes, 0, available);
                        while (available < length) { var loaded = await stream.ReadAsync(bodyBytes.AsMemory(available), timeout.Token); if (loaded == 0) return; available += loaded; }
                        try
                        {
                            using var json = JsonDocument.Parse(bodyBytes); var root = json.RootElement;
                            var key = Music.JsonFields.Text(root, "trackKey"); var source = Music.JsonFields.Text(root, "source");
                            if (key.Length != 64 || !key.All(Uri.IsHexDigit) || source is not ("" or "spicy_lyrics" or "lrclib")) code = "400 Bad Request";
                            else reportLyrics!(key, source, root.TryGetProperty("timed", out var timed) && timed.ValueKind == JsonValueKind.True);
                        }
                        catch (JsonException) { code = "400 Bad Request"; }
                    }
                }
                object? exportResult = null;
                if (allowed && authenticated && valid && export && request[0] == "POST")
                {
                    if (headers.ContainsKey("Transfer-Encoding") || !int.TryParse(headers.GetValueOrDefault("Content-Length"), out var length) || length <= 0 || length > WallpaperSettingsStore.MaxDocumentBytes) code = "400 Bad Request";
                    else
                    {
                        var start = end + 4; var bodyBytes = new byte[length]; var available = Math.Min(length, count - start); Array.Copy(bytes, start, bodyBytes, 0, available);
                        while (available < length) { var loaded = await stream.ReadAsync(bodyBytes.AsMemory(available), timeout.Token); if (loaded == 0) return; available += loaded; }
                        try
                        {
                            using var json = JsonDocument.Parse(bodyBytes);
                            var chooseLocation = json.RootElement.TryGetProperty("chooseLocation", out var choose) && choose.ValueKind == JsonValueKind.True;
                            if (!chooseLocation) exportResult = new { path = new EffectExportStore().Save(json.RootElement) };
                            else if (chooseExportPath is null) { code = "409 Conflict"; exportResult = new { error = "Update the companion to open a Save As dialog." }; }
                            else if (!exportDialog.Wait(0)) { code = "409 Conflict"; exportResult = new { error = "A Save As dialog is already open. Finish or cancel it first." }; }
                            else
                            {
                                try
                                {
                                    // Choosing a destination can take minutes; playback requests use the other connections.
                                    timeout.CancelAfter(Timeout.Infinite);
                                    var path = await new EffectExportStore().SaveAsAsync(json.RootElement, chooseExportPath, cancellation);
                                    exportResult = new { path, cancelled = path is null, dialog = true };
                                }
                                finally { exportDialog.Release(); timeout.CancelAfter(2000); }
                            }
                        }
                        catch (Exception ex) when (ex is JsonException or InvalidOperationException) { code = "400 Bad Request"; }
                        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or System.Runtime.InteropServices.COMException) { code = "503 Service Unavailable"; }
                    }
                }
                WallpaperSettingsState? settingsResult = null;
                if (allowed && authenticated && valid && preferences && request[0] is "GET" or "POST")
                {
                    try
                    {
                        if (request[0] == "GET") settingsResult = wallpaperSettings.Read();
                        else if (headers.ContainsKey("Transfer-Encoding") || !int.TryParse(headers.GetValueOrDefault("Content-Length"), out var length) || (length <= 0 || length > WallpaperSettingsStore.MaxDocumentBytes)) code = "400 Bad Request";
                        else
                        {
                            var start = end + 4; var bodyBytes = new byte[length]; var available = Math.Min(length, count - start); Array.Copy(bytes, start, bodyBytes, 0, available);
                            while (available < length) { var loaded = await stream.ReadAsync(bodyBytes.AsMemory(available), timeout.Token); if (loaded == 0) return; available += loaded; }
                            using var json = JsonDocument.Parse(bodyBytes);
                            var revision = Music.JsonFields.Text(json.RootElement, "expectedRevision");
                            if (revision.Length != 0 && (revision.Length != 64 || !revision.All(Uri.IsHexDigit))) code = "400 Bad Request";
                            else settingsResult = wallpaperSettings.Save(json.RootElement.GetProperty("settings"), revision);
                        }
                    }
                    catch (WallpaperSettingsConflictException) { code = "409 Conflict"; }
                    catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException) { code = "400 Bad Request"; }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { code = "503 Service Unavailable"; }
                }
                MusicSearchResult? searchResult = null;
                if (allowed && authenticated && valid && search && request[0] == "GET")
                {
                    var query = new Dictionary<string, string>(StringComparer.Ordinal);
                    try
                    {
                        foreach (var part in request[1][(request[1].IndexOf('?') + 1)..].Split('&'))
                        {
                            var pair = part.Split('=', 2);
                            if (pair.Length != 2 || !query.TryAdd(Uri.UnescapeDataString(pair[0]), Uri.UnescapeDataString(pair[1].Replace('+', ' ')))) { code = "400 Bad Request"; break; }
                        }
                        var native = read(); var title = query.GetValueOrDefault("title", ""); var artist = query.GetValueOrDefault("artist", "");
                        if (title.Trim().Length is < 2 or > 512 || artist.Length > 512 || native.TrackKey.Length != 64 || query.GetValueOrDefault("trackKey") != native.TrackKey) code = "400 Bad Request";
                        if (code == "200 OK")
                        {
                            timeout.CancelAfter(TimeSpan.FromSeconds(23));
                            using var searchTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); searchTimeout.CancelAfter(TimeSpan.FromSeconds(18));
                            lock (searchGate) { currentSearch?.Cancel(); currentSearch = searchTimeout; }
                            try { searchResult = await searchMusic!(native, title, artist, searchTimeout.Token); }
                            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
                            { searchResult = new(native.TrackKey, [], [], "Catalogue search did not finish. Try again or enable fewer providers."); }
                            finally { lock (searchGate) { if (ReferenceEquals(currentSearch, searchTimeout)) currentSearch = null; } }
                            if (read().TrackKey != native.TrackKey) { code = "409 Conflict"; searchResult = null; }
                        }
                    }
                    catch (UriFormatException) { code = "400 Bad Request"; }
                }
                var data = read(); if (request.Length < 2 || request[1] is not ("/now-playing?artwork=1" or "/inspector?artwork=1")) data = data with { Thumbnail = "" };
                if (request.Length < 2 || request[1] is not ("/inspector" or "/inspector?artwork=1")) data = data with { Candidates = [], ProviderError = "", Providers = [] };
                var body = Encoding.UTF8.GetBytes(exportResult is not null ? JsonSerializer.Serialize(exportResult, PlaybackSnapshot.Json) : code == "200 OK" && settingsResult is not null ? JsonSerializer.Serialize(settingsResult, PlaybackSnapshot.Json) : code == "200 OK" && request[0] == "GET" ? searchResult is not null ? JsonSerializer.Serialize(searchResult, PlaybackSnapshot.Json) : JsonSerializer.Serialize(data, PlaybackSnapshot.Json) : "{}");
                var cors = allowed ? $"Access-Control-Allow-Origin: {headers["Origin"]}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: X-RetroWave-Key, Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\nVary: Origin\r\n" : "";
                var response = Encoding.ASCII.GetBytes($"HTTP/1.1 {code}\r\n{cors}Content-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: {body.Length}\r\n\r\n");
                await stream.WriteAsync(response, timeout.Token); await stream.WriteAsync(body, timeout.Token);
            }
            catch (Exception ex) when (ex is IOException or SocketException or OperationCanceledException) { }
            finally { connections.Release(); }
        }
    }
}
