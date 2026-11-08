using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SpicyBond.Companion;
using SpicyBond.Companion.Music;
using SpicyBond.Setup;

var root = Path.Combine(Path.GetFullPath("artifacts"), "test-install-" + Guid.NewGuid().ToString("N"));
Environment.SetEnvironmentVariable("SPICY_BOND_DATA_ROOT", Path.Combine(root, "data"));
var checks = 0;
void Check(bool condition, string name) { if (!condition) throw new Exception(name); checks++; Console.WriteLine("PASS " + name); }
var now = DateTimeOffset.UtcNow;
Check(PlaybackSnapshot.TimelinePosition(4, 20, true, 2, now.AddSeconds(-2), now) == 8, "native playback rate extrapolation");
Check(PlaybackSnapshot.TimelinePosition(4, 20, false, 2, now.AddSeconds(-2), now) == 4, "pause freezes playback");
Check(PlaybackSnapshot.TimelinePosition(1, 20, true, 1, now, now) == 1, "backward seek resets native anchor");
Check(PlaybackSnapshot.TimelinePosition(19, 20, true, 1, now.AddSeconds(-5), now) == 20, "duration clamp");
Check(PlaybackSnapshot.TimelinePosition(4, 20, true, 1, DateTimeOffset.MinValue, now) == 4, "missing native timestamp does not jump to end");
var track = new PlaybackSnapshot { Title = "Test song", Artist = "Test artist", Album = "Test album", Duration = 180 };
var spotify = track with { Player = "Spotify.exe", IsPlaying = false };
foreach (var player in new[] { "TIDAL.exe", "AppleMusic.exe", "MusicBee.exe", "wmplayer.exe", "chrome.exe", "firefox.exe", "UnknownPlayer.exe" })
{
    var other = track with { Player = player, IsPlaying = true };
    Check(SessionSelection.Select(spotify, new[] { spotify, other }, s => s.IsPlaying)?.Player == player, $"{player} eligible without a player allowlist");
    Check(SessionSelection.Select(other, new[] { spotify with { IsPlaying = true }, other }, s => s.IsPlaying)?.Player == player, $"current playing {player} preferred over Spotify");
}
Check(SessionSelection.Select<PlaybackSnapshot>(null, [], s => s.IsPlaying) is null, "no media session handled");
var row = "{\"track_name\":\"Test song\",\"artist_name\":\"Test artist\",\"release_name\":\"Test album\",\"spotify_track_ids\":[\"invalid\",\"aaaaaaaaaaaaaaaaaaaaaa\"]}";
using (var result = JsonDocument.Parse("[" + row + "]"))
{
    Check(TrackResolver.Match(result.RootElement, track) == new string('a', 22), "documented catalogue match");
    Check(TrackResolver.Match(result.RootElement, track with { Artist = "Other" }) == "", "different artist rejected");
    Check(TrackResolver.Match(result.RootElement, track with { Album = "Other" }) == new string('a', 22), "album edition differences do not veto a recording");
}
using (var result = JsonDocument.Parse("[" + row + "," + row + "]")) Check(TrackResolver.Match(result.RootElement, track) == "", "competing catalogue rows rejected");
var handler = new FixtureHandler("[" + row + "]");
using (var resolver = new TrackResolver(handler))
{
    Check(await resolver.ResolveAsync(track, CancellationToken.None) == new string('a', 22), "resolver HTTP contract");
    await resolver.ResolveAsync(track, CancellationToken.None); Check(handler.Calls == 1, "matching catalogue result cached");
    await resolver.ResolveAsync(track with { Album = "" }, CancellationToken.None); Check(handler.Calls == 2, "missing album still resolves");
}
var candidate = new TrackCandidate(track.Title, track.Artist, track.Album, 180, "Fixture", new string('a', 22));
Check(TrackMatcher.Match(track, [candidate]).Match == candidate, "exact weighted match");
Check(TrackMatcher.Score(track with { Title = "Tést söng" }, candidate).Accepted, "Unicode normalization");
Check(TrackMatcher.Score(track with { Title = "Test song (Official Audio)" }, candidate).Accepted, "browser title noise");
Check(TrackMatcher.Score(track with { Title = "Test artist - Test song (Official Audio)" }, candidate).Accepted, "browser artist prefix removed for matching");
Check(TrackMatcher.Score(track with { Artist = "Test artist feat. Guest" }, candidate).Accepted, "featured artist variation");
Check(!TrackMatcher.Score(track, candidate with { Title = "Test song (Live)" }).Accepted, "live recording rejected");
Check(!TrackMatcher.Score(track, candidate with { Title = "Test song Remastered" }).Accepted, "remaster conflict rejected");
Check(!TrackMatcher.Score(track, candidate with { Duration = 210 }).Accepted, "wrong duration rejected");
Check(!TrackMatcher.Score(track with { Isrc = "US0000000001" }, candidate with { Isrc = "US0000000002" }).Accepted, "conflicting ISRC rejected");
Check(TrackMatcher.Match(track, [candidate, candidate with { SpotifyId = new string('b', 22) }]).Status == "Match ambiguous", "winner margin preserves ambiguity");
var fixtureProvider = new MockProvider([candidate]);
using (var resolver = new TrackResolver([fixtureProvider]))
{
    var config = new AppSettings { ExternalConsent = false, Providers = [new("Fixture", true)] };
    Check((await resolver.ResolveDetailedAsync(track, config, default)).Match is null && fixtureProvider.Calls == 0, "no consent means no network");
    config = config with { ExternalConsent = true };
    await Task.WhenAll(resolver.ResolveDetailedAsync(track, config, default), resolver.ResolveDetailedAsync(track, config, default));
    Check(fixtureProvider.Calls == 1, "concurrent searches deduplicated");
    using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
    var cancellationObserved = false;
    try { await resolver.ResolveDetailedAsync(track, config, cancelled.Token); } catch (OperationCanceledException) { cancellationObserved = true; }
    Check(cancellationObserved, "obsolete lookup cancellation");
}
foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.TooManyRequests })
{
    using var providerHttp = new ProviderHttp(new ErrorHandler(status)); var category = "";
    try { await providerHttp.GetAsync("https://musicbrainz.org/test", default); } catch (ProviderException ex) { category = ex.Message; }
    Check(category == (status == HttpStatusCode.TooManyRequests ? "Rate limited" : "Authentication or access denied"), "sanitized HTTP " + (int)status);
}
Check(!new AppSettings().Startup && !new AppSettings().ExperimentalConsent, "startup and experimental consent default off");
var disabledExperiment = new MockProvider([candidate], "Experimental Spotify");
using (var resolver = new TrackResolver([disabledExperiment]))
{
    await resolver.ResolveDetailedAsync(track, new AppSettings { ExternalConsent = true, Providers = [new("Experimental Spotify", true)] }, default);
    Check(disabledExperiment.Calls == 0, "experimental provider requires separate consent");
}
var noMatchProvider = new MockProvider([]);
using (var resolver = new TrackResolver([noMatchProvider]))
{
    var config = new AppSettings { ExternalConsent = true, Providers = [new("Fixture", true)] };
    await resolver.ResolveDetailedAsync(track, config, default); await resolver.ResolveDetailedAsync(track, config, default);
    Check(noMatchProvider.Calls == 1, "negative results cached");
}
var secondProvider = new MockProvider([candidate], "Second");
using (var resolver = new TrackResolver([new MockProvider([candidate]), secondProvider]))
{
    await resolver.ResolveDetailedAsync(track, new AppSettings { ExternalConsent = true, Providers = [new("Fixture", true), new("Second", true)] }, default);
    Check(secondProvider.Calls == 0, "high-confidence result stops later searches");
}
var pickerFirst = new MockProvider([candidate]);
var pickerSecond = new MockProvider([candidate with { SpotifyId = new string('b', 22), Title = "Test song (Live)" }], "Second");
var pickerExperiment = new MockProvider([candidate], "Experimental Spotify");
using (var resolver = new TrackResolver([pickerFirst, pickerSecond, pickerExperiment]))
{
    var settings = new AppSettings { Providers = [new("Fixture", true, 85), new("Second", true, 25), new("Experimental Spotify", true)], LrcLibPopularity = 70 };
    var native = track with { Title = "Test song 2008 version", TrackKey = new string('a', 64), TrackId = new string('c', 22), Mbid = "old-recording", Isrc = "old-isrc" };
    await resolver.SearchCandidatesAsync(native, "Test song", "Test artist", settings, default);
    Check(pickerFirst.Calls == 0 && pickerSecond.Calls == 0, "interactive search respects external consent");
    var result = await resolver.SearchCandidatesAsync(native, "Test song", "Test artist", settings with { ExternalConsent = true }, default);
    Check(result.Candidates.Length == 2 && pickerSecond.Calls == 1, "picker returns alternate recordings across all enabled providers");
    Check(result.Candidates.Any(c => c.Provider == "Fixture" && c.SourcePopularity == 85) && result.SourcePopularity["LRCLIB"] == 70, "saved source weights accompany catalogue and public search results");
    Check(pickerFirst.LastTrack is { Title: "Test song", Album: "", TrackId: "", Mbid: "", Isrc: "", Duration: 0 } && native.Title == "Test song 2008 version", "edited title only changes search identity without old recording constraints");
    Check(pickerExperiment.Calls == 0 && result.TrackKey == native.TrackKey, "picker respects experimental consent and native song identity");
    await resolver.SearchCandidatesAsync(native, "x", "Test artist", settings with { ExternalConsent = true }, default);
    Check(pickerFirst.Calls == 1, "short picker input makes no provider request");
}
var slowPicker = new WaitingProvider();
var fastApple = new MockProvider([candidate with { Provider = "Apple iTunes", SpotifyId = "", CatalogueId = "123" }], "Apple iTunes");
using (var resolver = new TrackResolver([slowPicker, fastApple]))
{
    var searching = resolver.SearchCandidatesAsync(track, track.Title, track.Artist, new AppSettings { ExternalConsent = true, Providers = [new("Waiting", true), new("Apple iTunes", true)] }, default);
    await slowPicker.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
    Check(fastApple.Calls == 1, "all enabled sources start while an earlier source is still waiting");
    slowPicker.Result.SetResult([candidate]);
    var found = await searching;
    Check(found.Candidates.Any(c => c.CatalogueId == "123") && found.Queries.Length == 2, "Apple IDs and every enabled source remain in finder results");
}
using (var transport = new ParallelHostHandler())
using (var http = new ProviderHttp(transport))
{
    var slow = http.GetTextAsync("https://slow.example.test/track", default);
    await transport.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
    Check(await http.GetTextAsync("https://fast.example.test/track", default).WaitAsync(TimeSpan.FromSeconds(2)) == "{}", "provider HTTP transport does not serialize different sources");
    transport.Release.SetResult(); await slow;
}
using (var http = new ProviderHttp(new ExperimentalFixtureHandler()))
{
    var rows = await new SpotifyExperimentalProvider(http).SearchAsync(track, default);
    Check(rows.Single().SpotifyId == new string('a', 22) && !JsonSerializer.Serialize(rows).Contains("private-session-token"), "experimental embed token and pathfinder parsing keep token private");
}
var genreProvider = new MockProvider([candidate with { Provider = "Apple iTunes", SpotifyId = "", CatalogueId = "123", Genres = ["Jazz"] }], "Apple iTunes");
using (var resolver = new TrackResolver([genreProvider]))
{
    var settings = new AppSettings { ExternalConsent = false, Providers = [new("Apple iTunes", true)] };
    var recording = new ResolutionResult("Match found", candidate, 100, []);
    Check((await resolver.ResolveGenresAsync(track, recording, settings, default)).Length == 0 && genreProvider.Calls == 0, "genre enrichment respects external consent");
    settings = settings with { ExternalConsent = true };
    Check((await resolver.ResolveGenresAsync(track, recording, settings, default)).SequenceEqual(new[] { "Jazz" }), "enabled catalogue resolves missing genres");
    await resolver.ResolveGenresAsync(track, recording, settings, default);
    Check(genreProvider.Calls == 1, "genre results cached separately from recording IDs");
    Check((await resolver.ResolveGenresAsync(track with { Genres = ["Rock"] }, recording, settings, default)).SequenceEqual(new[] { "Rock" }) && genreProvider.Calls == 1, "native genres take priority without a request");
    Check((await resolver.ResolveGenresAsync(track with { Title = "Different song" }, recording, settings, default)).Length == 0, "genre lookup rejects a different recording");
    await resolver.ResolveGenresAsync(track with { Title = "Different song" }, recording, settings, default);
    Check(genreProvider.Calls == 2, "negative genre result cached");
    var resolved = await resolver.ResolveDetailedAsync(track, settings, default);
    Check(resolved.Genres.SequenceEqual(new[] { "Jazz" }) && resolved.Match is null, "accepted Apple genre survives when no Spotify ID is available");
    await resolver.ResolveGenresAsync(track, resolved, settings, default);
    Check(genreProvider.Calls == 3, "accepted provider genres do not repeat the catalogue request");
}
var mbid = "00000000-0000-0000-0000-000000000001";
using (var transport = new ArtistGenreFixtureHandler())
using (var http = new ProviderHttp(transport))
using (var resolver = new TrackResolver([new MusicBrainzProvider(http), new MockProvider([candidate with { Provider = "Experimental Spotify" }], "Experimental Spotify")]))
{
    var settings = new AppSettings { ExternalConsent = true, ExperimentalConsent = true, Providers = [new("MusicBrainz", true), new("Experimental Spotify", true)] };
    var recording = await resolver.ResolveDetailedAsync(track, settings, default);
    Check(recording.Match?.SpotifyId == candidate.SpotifyId && recording.Candidates.Count(c => c.Candidate.Provider == "MusicBrainz") == 2, "Spotify identity survives ambiguous MusicBrainz recordings without genres");
    var genres = await resolver.ResolveGenreMetadataAsync(track, recording, settings, default);
    Check(genres.Genres.SequenceEqual(new[] { "pop" }) && genres.Source == "MusicBrainz artist", "previous recording search does not suppress artist genre fallback");
    Check(recording.Match?.SpotifyId == candidate.SpotifyId && transport.RecordingSearches == 1, "artist genre fallback does not repeat recording search or replace Spotify ID");
    await resolver.ResolveGenreMetadataAsync(track, recording, settings, default);
    await resolver.ResolveGenreMetadataAsync(track with { Title = "Another song" }, recording, settings, default);
    Check(transport.ArtistSearches == 1 && transport.ArtistDetails == 1, "artist genres cached across different songs by the same artist");
    var disabled = await resolver.ResolveGenreMetadataAsync(track, recording, settings with { ExternalConsent = false }, default);
    Check(disabled.Genres.Length == 0 && disabled.Status.Contains("Enable external"), "genre status explains disabled consent without using cached artist tags");
    disabled = await resolver.ResolveGenreMetadataAsync(track, recording, settings with { Providers = [new("Experimental Spotify", true)] }, default);
    Check(disabled.Genres.Length == 0 && disabled.Status.Contains("MusicBrainz or Apple"), "Spotify-only configuration explains which genre provider to enable");
}
using (var transport = new ArtistGenreFixtureHandler(ambiguous: true))
using (var http = new ProviderHttp(transport))
{
    var provider = new MusicBrainzProvider(http);
    Check((await provider.ResolveArtistGenresAsync(track.Artist, default)).Genres.Length == 0, "same-name MusicBrainz artists cannot supply an ambiguous genre");
    await provider.ResolveArtistGenresAsync(track.Artist, default);
    Check(transport.ArtistSearches == 1 && transport.ArtistDetails == 0, "ambiguous artist misses cached without an arbitrary detail request");
}
using (var transport = new ArtistGenreFixtureHandler(wrongDetail: true))
using (var http = new ProviderHttp(transport))
{
    Check((await new MusicBrainzProvider(http).ResolveArtistGenresAsync(track.Artist, default)).Genres.Length == 0, "genre detail must match the verified artist ID and name");
}
using (var http = new ProviderHttp(new AnyFixtureHandler("{\"recordings\":[{\"id\":\"" + mbid + "\",\"title\":\"Test song\",\"length\":180000,\"artist-credit\":[{\"name\":\"Test artist\"}],\"isrcs\":[\"US0000000001\"],\"tags\":[{\"name\":\"jazz\",\"count\":5}]}]}")))
{
    var rows = await new MusicBrainzProvider(http).SearchAsync(track, default);
    Check(rows.Single().Mbid == mbid && rows[0].Isrc == "US0000000001" && rows[0].Duration == 180, "MusicBrainz recording response parsed");
    Check(rows[0].Genres.SequenceEqual(new[] { "jazz" }), "MusicBrainz tags retained as genre metadata");
}
using (var http = new ProviderHttp(new AnyFixtureHandler("[{\"spotify_track_ids\":[\"aaaaaaaaaaaaaaaaaaaaaa\"]}]")))
{
    var rows = await new ListenBrainzProvider(http).SearchAsync(track with { Mbid = mbid }, default);
    Check(rows.Single().Mbid == mbid && rows[0].SpotifyId.Length == 22, "ListenBrainz MBID mapping response parsed");
}
using (var http = new ProviderHttp(new AnyFixtureHandler("{\"results\":[{\"trackName\":\"Test song\",\"artistName\":\"Test artist\",\"trackTimeMillis\":180000,\"trackId\":123,\"primaryGenreName\":\"Jazz\"}]}")))
{
    var rows = await new AppleMetadataProvider(http).SearchAsync(track, default);
    Check(rows.Single().SpotifyId == "" && rows[0].Duration == 180, "Apple ID never treated as Spotify ID");
    Check(rows[0].Genres.SequenceEqual(new[] { "Jazz" }), "Apple primary genre retained");
}
using (var http = new ProviderHttp(new AnyFixtureHandler("{\"data\":[{\"name\":\"Test song\",\"artists\":[{\"name\":\"Test artist\"}],\"duration_ms\":180000,\"external_metadata\":{\"spotify\":[{\"id\":\"aaaaaaaaaaaaaaaaaaaaaa\"}]}}]}")))
{
    var rows = await new ACRCloudProvider(http, () => "fixture-credential").SearchAsync(track, default);
    Check(rows.Single().SpotifyId.Length == 22, "ACRCloud Spotify identifiers parsed");
}
using (var http = new ProviderHttp(new AnyFixtureHandler("{\"tracks\":{\"items\":[{\"id\":\"aaaaaaaaaaaaaaaaaaaaaa\",\"name\":\"Test song\",\"artists\":[{\"name\":\"Test artist\"}],\"duration_ms\":180000}]}}")))
{
    var rows = await new SpotifyOfficialProvider(http, _ => Task.FromResult("fixture-token")).SearchAsync(track, default);
    Check(rows.Single().SpotifyId.Length == 22 && rows[0].Duration == 180, "official Spotify search response parsed");
}
using (var http = new ProviderHttp(new AnyFixtureHandler("not-json")))
{
    var invalid = false; try { await http.GetAsync("https://example.test/fixture", default); } catch (JsonException) { invalid = true; }
    Check(invalid, "invalid JSON rejected");
}
using (var http = new ProviderHttp(new AnyFixtureHandler(new string('x', 2_000_001))))
{
    var oversized = false; try { await http.GetAsync("https://example.test/fixture", default); } catch (ProviderException) { oversized = true; }
    Check(oversized, "oversized provider response rejected");
}
var settingsDirectory = Path.Combine(root, "wallpaper-preferences");
new AppSettings { Providers = [new("MusicBrainz", true, 85), new("ListenBrainz", true, -1)], LrcLibPopularity = 150 }.Save();
var savedWeights = AppSettings.Load();
Check(savedWeights.Providers.Single(p => p.Name == "MusicBrainz").Popularity == 85 && savedWeights.Providers.Single(p => p.Name == "ListenBrainz").Popularity == 0 && savedWeights.LrcLibPopularity == 100, "source weights survive JSON reload and are normalized");
Check(AppSettings.NormalizePopularity(double.NaN) == 50, "invalid source weight receives neutral default");
var preferences = new WallpaperSettingsStore(settingsDirectory);
Check(!preferences.Read().Initialized && !File.Exists(preferences.PathName), "reading defaults never creates or resets the settings file");
using (var document = JsonDocument.Parse("{\"version\":1,\"config\":{\"mode\":\"vinyl\",\"lyricStyle\":\"minimal\",\"lyricSize\":1.25,\"lyricOffset\":1.5},\"lyricsKey\":\"sl_pk_fixture\"}"))
{
    var saved = preferences.Save(document.RootElement, "");
    var restored = new WallpaperSettingsStore(settingsDirectory).Read();
    Check(saved.Initialized && restored.Revision == saved.Revision && restored.Settings.Config["mode"].GetString() == "vinyl" && restored.Settings.Config["lyricSize"].GetDouble() == 1.25 && restored.Settings.Config["lyricOffset"].GetDouble() == 1.5 && restored.Settings.LyricsKey == "sl_pk_fixture", "JSON preferences and lyric key survive store restart");
    using (var visuals = JsonDocument.Parse("""{"version":1,"config":{"manualTheme":"soul","particleStyle":"fireflies","songAccents":false,"performancePreset":"low","backgroundBrightness":0.4,"censorLyrics":true}}"""))
    {
        var visualFile = new WallpaperSettingsStore(Path.Combine(settingsDirectory, "visuals"));
        visualFile.Save(visuals.RootElement, "");
        var config = new WallpaperSettingsStore(Path.Combine(settingsDirectory, "visuals")).Read().Settings.Config;
        Check(config["manualTheme"].GetString() == "soul" && config["particleStyle"].GetString() == "fireflies" && !config["songAccents"].GetBoolean() && config["performancePreset"].GetString() == "low" && config["backgroundBrightness"].GetDouble() == .4 && config["censorLyrics"].GetBoolean(), "background and easter egg preferences survive file reload");
    }
    var effectPath = Path.Combine(settingsDirectory, "effects");
    var effectStore = new WallpaperSettingsStore(effectPath);
    var shader = "vec4 effect(vec2 uv){return vec4(uv,0.,1.);}" + new string(' ', 10000);
    using (var effectsDoc = JsonDocument.Parse(JsonSerializer.Serialize(new { version = 1, config = new { particleMotion = 2.4, particleScale = 2.2 }, customEffects = new { enabled = false, file = new { version = 1, effects = new[] { new { id = "saved-shader", shader } } } } })))
    {
        var effectSaved = effectStore.Save(effectsDoc.RootElement, "");
        var effectReloaded = new WallpaperSettingsStore(effectPath).Read();
        Check(effectReloaded.Settings.CustomEffects!.Value.GetProperty("file").GetProperty("effects")[0].GetProperty("shader").GetString() == shader &&
            !effectReloaded.Settings.CustomEffects.Value.GetProperty("enabled").GetBoolean() && effectReloaded.Settings.Config["particleScale"].GetDouble() == 2.2,
            "custom shader libraries larger than 8 KiB and visual controls survive companion restart");
        using var legacy = JsonDocument.Parse("""{"version":1,"config":{"casing":"beige"}}""");
        effectStore.Save(legacy.RootElement, effectSaved.Revision);
        Check(effectStore.Read().Settings.CustomEffects.HasValue, "older wallpaper saves preserve companion effect libraries");
        using var invalidEffects = JsonDocument.Parse("""{"version":1,"config":{},"customEffects":{"enabled":true,"file":{"version":2,"effects":[]}}}""");
        var rejectedEffects = false; try { effectStore.Save(invalidEffects.RootElement, effectStore.Read().Revision); } catch (JsonException) { rejectedEffects = true; }
        Check(rejectedEffects && effectStore.Read().Settings.CustomEffects.HasValue, "invalid custom library envelope never replaces saved effects");
    }
    Check(restored.Settings.Config.Count == 41 && restored.Settings.Config["fps"].GetInt32() == 60, "settings migration fills missing defaults without resetting saved values");
    var conflict = false; try { preferences.Save(document.RootElement, ""); } catch (WallpaperSettingsConflictException) { conflict = true; }
    Check(conflict && preferences.Read().Revision == saved.Revision, "stale settings writers cannot overwrite the file");
    foreach (var invalid in new[] { "{\"version\":2,\"config\":{}}", "{\"version\":1,\"config\":{\"lyricSize\":99}}", "{\"version\":1,\"config\":{\"lyrics\":\"true\"}}", "{\"version\":1,\"config\":{},\"lyricsKey\":\"sl_sk_secret\"}" })
    {
        using var bad = JsonDocument.Parse(invalid); var rejected = false;
        try { preferences.Save(bad.RootElement, saved.Revision); } catch (JsonException) { rejected = true; }
        Check(rejected && preferences.Read().Revision == saved.Revision, "invalid wallpaper settings never replace a saved file");
    }
    File.WriteAllText(preferences.PathName, "not JSON");
    var malformed = false; try { preferences.Read(); } catch (JsonException) { malformed = true; }
    Check(malformed && File.ReadAllText(preferences.PathName) == "not JSON", "malformed external edits are reported without overwriting the file");
}
using (var exportRequest = JsonDocument.Parse("""{"name":"my-effect.json","file":{"version":1,"effects":[{"id":"saved-effect","shader":"vec4 effect(vec2 uv){return vec4(uv,0.,1.);}"}]}}"""))
{
    var store = new EffectExportStore(Path.Combine(settingsDirectory, "export-check"));
    var exported = store.Save(exportRequest.RootElement); var secondExport = store.Save(exportRequest.RootElement);
    using var savedExport = JsonDocument.Parse(File.ReadAllText(exported));
    Check(savedExport.RootElement.GetProperty("effects")[0].GetProperty("id").GetString() == "saved-effect" && exported != secondExport && File.Exists(exported), "companion exports preserve shader JSON and never overwrite a previous file");
    using var traversal = JsonDocument.Parse("""{"name":"../outside.json","file":{"version":1,"effects":[]}}""");
    var rejectedExport = false; try { store.Save(traversal.RootElement); } catch (JsonException) { rejectedExport = true; }
    Check(rejectedExport, "export paths cannot escape the owned exports folder");
}
using (var saveAsRequest = JsonDocument.Parse("""{"name":"my-effect.json","path":"ignored.json","file":{"version":1,"effects":[{"id":"save-as"}]}}"""))
{
    var store = new EffectExportStore(Path.Combine(settingsDirectory, "dialog-exports"));
    var destination = Path.Combine(settingsDirectory, "my chosen effect موسیقی.json");
    var selected = await store.SaveAsAsync(saveAsRequest.RootElement, (suggestion, _) => { Check(suggestion == "my-effect.json", "Save As receives the suggested JSON filename"); return Task.FromResult<string?>(destination); }, default);
    Check(selected == destination && File.ReadAllText(destination).Contains("save-as"), "Save As writes JSON to the user-selected Unicode path");
    var cancelled = await store.SaveAsAsync(saveAsRequest.RootElement, (_, _) => Task.FromResult<string?>(null), default);
    Check(cancelled is null && !Directory.Exists(Path.Combine(settingsDirectory, "dialog-exports", "exports")), "canceling Save As creates no default export");
    using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
    var stopped = false; try { await store.SaveAsAsync(saveAsRequest.RootElement, (_, _) => Task.FromResult<string?>(destination), cancellation.Token); } catch (OperationCanceledException) { stopped = true; }
    Check(stopped, "worker cancellation prevents writing the chosen export");
}
Check(LoopbackServer.IsAllowed("127.0.0.1:43821", "https://iamaloneforever.github.io"), "wallpaper origin allowed");
Check(!LoopbackServer.IsAllowed("127.0.0.1:43821", "https://evil.example"), "foreign origin denied");
Check(!LoopbackServer.IsAllowed("evil.example:43821", "https://iamaloneforever.github.io"), "DNS rebinding host denied");
Check(!LoopbackServer.IsAllowed("127.0.0.1:43821", ""), "missing origin denied");
using (var cancellation = new CancellationTokenSource())
using (var http = new HttpClient())
{
    const int testPort = 43829;
    var receipts = 0; var searchCalls = 0; var bridgeTrackKey = new string('a', 64);
    var server = new LoopbackServer("fixture-token", testPort).RunAsync(() => track with { Position = 12, Thumbnail = "cover", TrackKey = bridgeTrackKey, CapturedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, cancellation.Token, (_, source, timed) => { if (source == "lrclib" && timed) receipts++; }, (native, title, artist, _) =>
    {
        searchCalls++; return Task.FromResult(new MusicSearchResult(native.TrackKey, [candidate with { Title = title, Artist = artist }], ["Fixture: " + title + " — " + artist], ""));
    });
    async Task<HttpResponseMessage> Request(string? origin, string method = "GET", string? host = null)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), $"http://127.0.0.1:{testPort}/now-playing");
        if (origin is not null) request.Headers.Add("Origin", origin);
        request.Headers.Add("X-RetroWave-Key", "fixture-token");
        if (host is not null) request.Headers.Host = host;
        return await http.SendAsync(request);
    }
    using (var response = await Request("https://iamaloneforever.github.io"))
    {
        var body = await response.Content.ReadAsStringAsync();
        Check(response.IsSuccessStatusCode && body.Contains("Test song"), "real loopback HTTP snapshot");
        Check(!body.Contains("cover"), "clock polls avoid retransmitting cover artwork");
        Check(response.Headers.GetValues("Access-Control-Allow-Origin").Single() == "https://iamaloneforever.github.io", "HTTP allows only matching origin");
    }
    using (var eventRequest = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{testPort}/playback-events"))
    {
        eventRequest.Headers.Add("Origin", "https://iamaloneforever.github.io"); eventRequest.Headers.Add("X-RetroWave-Key", "fixture-token");
        using var response = await http.SendAsync(eventRequest, HttpCompletionOption.ResponseHeadersRead);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());
        var firstEvent = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(3));
        Check(response.IsSuccessStatusCode && response.Content.Headers.ContentType?.MediaType == "text/event-stream" && firstEvent?.StartsWith("data: ", StringComparison.Ordinal) == true && (firstEvent?.Contains(bridgeTrackKey) ?? false), "paired wallpaper receives an immediate playback event stream snapshot");
    }
    using (var response = await Request("https://evil.example")) Check(response.StatusCode == HttpStatusCode.Forbidden, "foreign HTTP origin rejected");
    using (var response = await Request(null)) Check(response.StatusCode == HttpStatusCode.Forbidden, "originless HTTP requests rejected");
    using (var response = await Request("https://iamaloneforever.github.io", host: "evil.example")) Check(response.StatusCode == HttpStatusCode.Forbidden, "HTTP rebinding rejected");
    using (var response = await Request("https://iamaloneforever.github.io", "OPTIONS")) Check(response.IsSuccessStatusCode && response.Headers.GetValues("Access-Control-Allow-Private-Network").Single() == "true", "private network preflight supported");
    using (var response = await Request("https://iamaloneforever.github.io", "POST")) Check(response.StatusCode == HttpStatusCode.NotFound, "HTTP cannot control playback or setup");
    using (var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{testPort}/now-playing"))
    {
        request.Headers.Add("Origin", "https://iamaloneforever.github.io");
        using var response = await http.SendAsync(request); Check(response.StatusCode == HttpStatusCode.Forbidden, "origin alone cannot read private playback metadata");
    }
    async Task<HttpStatusCode> Receipt(bool authenticated, string body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{testPort}/lyrics-status") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.Add("Origin", "https://iamaloneforever.github.io"); if (authenticated) request.Headers.Add("X-RetroWave-Key", "fixture-token");
        using var response = await http.SendAsync(request); return response.StatusCode;
    }
    var receiptBody = JsonSerializer.Serialize(new { trackKey = new string('a', 64), source = "lrclib", timed = true });
    Check(await Receipt(false, receiptBody) == HttpStatusCode.Forbidden && receipts == 0, "lyrics receipts require pairing authentication");
    Check(await Receipt(true, receiptBody) == HttpStatusCode.OK && receipts == 1, "authenticated lyrics provenance receipt");
    Check(await Receipt(true, new string('x', 1025)) == HttpStatusCode.BadRequest, "lyrics receipt body limit");
    async Task<HttpResponseMessage> SearchRequest(string key, bool paired = true)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{testPort}/music-search?title=Fly%20Me%20to%20the%20Moon&artist=Artist&trackKey={key}");
        request.Headers.Add("Origin", "https://iamaloneforever.github.io"); if (paired) request.Headers.Add("X-RetroWave-Key", "fixture-token");
        return await http.SendAsync(request);
    }
    using (var response = await SearchRequest(bridgeTrackKey, false)) Check(response.StatusCode == HttpStatusCode.Forbidden && searchCalls == 0, "picker requests require pairing authentication");
    using (var response = await SearchRequest(new string('b', 64))) Check(response.StatusCode == HttpStatusCode.BadRequest && searchCalls == 0, "picker rejects an obsolete playback identity before searching");
    using (var response = await SearchRequest(bridgeTrackKey))
    {
        var body = await response.Content.ReadAsStringAsync();
        Check(response.IsSuccessStatusCode && searchCalls == 1 && body.Contains("Fly Me to the Moon") && body.Contains(new string('a', 22)), "authenticated picker returns edited-title candidates and IDs");
    }
    async Task<HttpResponseMessage> PreferencesRequest(bool paired, string? body = null)
    {
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, $"http://127.0.0.1:{testPort}/wallpaper-settings");
        request.Headers.Add("Origin", "https://iamaloneforever.github.io"); if (paired) request.Headers.Add("X-RetroWave-Key", "fixture-token");
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        return await http.SendAsync(request);
    }
    using (var response = await PreferencesRequest(false)) Check(response.StatusCode == HttpStatusCode.Forbidden, "wallpaper preferences require bridge pairing");
    var preferenceBody = "{\"expectedRevision\":\"\",\"settings\":{\"version\":1,\"config\":{\"lyricColor\":\"neutral\"},\"lyricsKey\":\"sl_pk_fixture\"}}";
    using (var response = await PreferencesRequest(true, preferenceBody)) Check(response.IsSuccessStatusCode && File.Exists(new WallpaperSettingsStore().PathName), "authenticated wallpaper changes persist to JSON");
    using (var response = await PreferencesRequest(true))
    {
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Check(response.IsSuccessStatusCode && json.RootElement.GetProperty("settings").GetProperty("config").GetProperty("lyricColor").GetString() == "neutral", "companion delivers saved preferences back to the wallpaper");
    }
    var largeEffectRequest = JsonSerializer.Serialize(new { expectedRevision = new WallpaperSettingsStore().Read().Revision, settings = new { version = 1, config = new { particleMotion = 2.4, particleScale = 2.2 }, customEffects = new { enabled = true, file = new { version = 1, effects = new[] { new { id = "http-shader", shader = new string(' ', 10000) } } } } } });
    using (var response = await PreferencesRequest(true, largeEffectRequest)) Check(response.IsSuccessStatusCode && new WallpaperSettingsStore().Read().Settings.CustomEffects.HasValue, "HTTP settings accepts effect libraries larger than the old 8 KiB request limit");
    using (var response = await PreferencesRequest(true, preferenceBody)) Check(response.StatusCode == HttpStatusCode.Conflict, "HTTP settings save rejects an outdated revision");
    async Task<HttpResponseMessage> ExportRequest(bool paired)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{testPort}/effect-export");
        request.Headers.Add("Origin", "https://iamaloneforever.github.io"); if (paired) request.Headers.Add("X-RetroWave-Key", "fixture-token");
        request.Content = new StringContent("""{"name":"exported-effect.json","file":{"version":1,"effects":[{"id":"exported"}]}}""", Encoding.UTF8, "application/json");
        return await http.SendAsync(request);
    }
    using (var response = await ExportRequest(false)) Check(response.StatusCode == HttpStatusCode.Forbidden, "effect exports require companion pairing");
    using (var response = await ExportRequest(true))
    {
        using var exported = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Check(response.IsSuccessStatusCode && File.Exists(exported.RootElement.GetProperty("path").GetString()), "authenticated HTTP effect export creates a JSON file and returns its location");
    }
    cancellation.Cancel(); try { await server; } catch (OperationCanceledException) { }
}
using (var dialogStop = new CancellationTokenSource())
{
    var selectedPath = Path.Combine(root, "chosen effect.json");
    var opened = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var choice = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
    var requests = 0;
    var dialogServer = new LoopbackServer("dialog-token", 43830, async (_, token) => { if (Interlocked.Increment(ref requests) == 1) { opened.SetResult(); return await choice.Task.WaitAsync(token); } return selectedPath; }).RunAsync(() => track, dialogStop.Token);
    using var dialogHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
    async Task<HttpResponseMessage> DialogRequest(bool save)
    {
        using var request = new HttpRequestMessage(save ? HttpMethod.Post : HttpMethod.Get, "http://127.0.0.1:43830/" + (save ? "effect-export" : "now-playing"));
        request.Headers.Add("Origin", "https://iamaloneforever.github.io"); request.Headers.Add("X-RetroWave-Key", "dialog-token");
        if (save) request.Content = new StringContent("""{"name":"picked.json","chooseLocation":true,"file":{"version":1,"effects":[{"id":"picked"}]}}""", Encoding.UTF8, "application/json");
        return await dialogHttp.SendAsync(request);
    }
    try
    {
        var pendingSave = DialogRequest(true); await opened.Task.WaitAsync(TimeSpan.FromSeconds(5)); await Task.Delay(2200);
        using (var playback = await DialogRequest(false)) Check(playback.IsSuccessStatusCode && !pendingSave.IsCompleted, "playback remains responsive while Save As exceeds the normal HTTP timeout");
        using (var duplicate = await DialogRequest(true)) Check(duplicate.StatusCode == HttpStatusCode.Conflict && requests == 1, "duplicate export requests cannot open overlapping dialogs");
        choice.SetResult(null);
        using (var canceled = await pendingSave) { using var body = JsonDocument.Parse(await canceled.Content.ReadAsStringAsync()); Check(body.RootElement.GetProperty("cancelled").GetBoolean() && !File.Exists(selectedPath), "HTTP export cancel reports cancellation without creating a file"); }
        using (var saved = await DialogRequest(true)) { using var body = JsonDocument.Parse(await saved.Content.ReadAsStringAsync()); Check(body.RootElement.GetProperty("dialog").GetBoolean() && body.RootElement.GetProperty("path").GetString() == selectedPath && File.Exists(selectedPath), "HTTP Save As returns the user-selected saved file"); }
    }
    finally { dialogStop.Cancel(); try { await dialogServer; } catch (OperationCanceledException) { } }
}
Directory.CreateDirectory(root);
try
{
    var library = Path.Combine(root, "library"); var installation = Path.Combine(root, "installed");
    var custom = Path.Combine(root, "موسیقی SpicyBond");
    Check(WindowsSetup.ValidateDestination(custom) == custom, "custom Unicode installation destination");
    var driveRejected = false; try { WindowsSetup.ValidateDestination(Path.GetPathRoot(root)!); } catch (IOException) { driveRejected = true; }
    Check(driveRejected, "drive-root installation rejected");
    var binaries = Path.Combine(root, "source"); Directory.CreateDirectory(binaries); File.WriteAllText(Path.Combine(binaries, "SpicyBond.exe"), "owned binary"); File.WriteAllText(Path.Combine(binaries, ".spicy-bond-owned"), "Spicy Bond 4"); File.WriteAllText(Path.Combine(binaries, "user.txt"), "keep");
    var moved = Path.Combine(root, "moved موسیقی"); var registrations = 0;
    InstallationFiles.CopyForRelocation(binaries, moved, () => registrations++, () => registrations--);
    Check(registrations == 1 && File.ReadAllText(Path.Combine(moved, "SpicyBond.exe")) == "owned binary" && File.Exists(Path.Combine(binaries, "user.txt")), "relocation copies owned binary and preserves user additions");
    var failed = Path.Combine(root, "failed"); Directory.CreateDirectory(failed); File.WriteAllText(Path.Combine(failed, "user.txt"), "keep"); var rolledBack = false;
    try { InstallationFiles.CopyForRelocation(binaries, failed, () => throw new IOException("fixture failure"), () => rolledBack = true); } catch (IOException) { }
    Check(rolledBack && !File.Exists(Path.Combine(failed, "SpicyBond.exe")) && File.Exists(Path.Combine(failed, "user.txt")) && File.Exists(Path.Combine(binaries, "SpicyBond.exe")), "relocation failure restores registration and keeps source and unrelated files");
    var collision = false; try { InstallationFiles.CopyForRelocation(binaries, moved, () => { }, () => { }); } catch (IOException) { collision = true; }
    Check(collision && File.ReadAllText(Path.Combine(moved, "SpicyBond.exe")) == "owned binary", "relocation refuses destination collisions");
    var report = DiagnosticReport.FromSnapshot(true, true, "Connected", 3, "available", track with { Thumbnail = "PRIVATE_ARTWORK", TrackId = "PRIVATE_KEY", Position = 12, Sequence = 42 });
    var reportJson = report.Serialize();
    Check(!reportJson.Contains("Test song") && !reportJson.Contains("Test artist") && !reportJson.Contains("PRIVATE_"), "diagnostic reports exclude private metadata and credentials");
    Check(report.Position == 12 && report.Sequence == 42 && report.Sessions == 3, "diagnostic report retains usable timing and session evidence");
    var logPath = Path.Combine(root, "log.txt");
    File.WriteAllText(logPath, new string('x', 256 * 1024 + 1));
    DiagnosticLog.Append(logPath, "worker_started");
    Check(File.Exists(logPath + ".previous") && new FileInfo(logPath).Length < 1024, "bounded diagnostic log rotates");
    var installer = new WallpaperInstaller(installation, library);
    var template = File.ReadAllText("lively/LivelyInfo.json");
    var first = installer.Install(template, [1, 2, 3], true, false);
    Check(first.Created && File.Exists(Path.Combine(first.Entry, "LivelyInfo.json")), "Lively package installed");
    installer.Install(template, [], true, false);
    Check(!File.Exists(Path.Combine(first.Entry, "thumbnail.jpg")), "repair removes an old owned thumbnail when no image is supplied");
    var second = installer.Install(template, [1, 2, 3], true, false);
    Check(second.Entry == first.Entry && Directory.GetDirectories(Path.Combine(library, "wallpapers")).Length == 1, "repair does not duplicate wallpaper");
    Check(File.ReadAllBytes(Path.Combine(second.Entry, "thumbnail.jpg")).SequenceEqual(new byte[] { 1, 2, 3 }), "repair still writes a supplied thumbnail");
    using (var metadata = JsonDocument.Parse(File.ReadAllText(Path.Combine(first.Entry, "LivelyInfo.json"))))
    {
        Check(metadata.RootElement.GetProperty("Type").GetInt32() == 3 && metadata.RootElement.GetProperty("FileName").GetString() == WallpaperInstaller.WallpaperUrl + "#bridge=" + first.BridgeToken, "real URL wallpaper schema with automatic pairing");
        Check(metadata.RootElement.GetProperty("Arguments").GetString() == WallpaperInstaller.Arguments, "audio media pause flags automatically retained");
        Check(metadata.RootElement.GetProperty("License").GetString() == "AGPL-3.0", "new wallpaper registration has the AGPL license");
    }
    File.WriteAllText(Path.Combine(first.Entry, "user-note.txt"), "keep");
    installer.Uninstall(); Check(File.Exists(Path.Combine(first.Entry, "user-note.txt")), "uninstall keeps user additions");
    var reinstall = installer.Install(template, [], false, false);
    Check(reinstall.Entry != first.Entry && File.Exists(Path.Combine(first.Entry, "user-note.txt")), "reinstall preserves files retained by uninstall");
    Check(!File.Exists(Path.Combine(reinstall.Entry, "thumbnail.jpg")) && JsonDocument.Parse(File.ReadAllText(Path.Combine(reinstall.Entry, "LivelyInfo.json"))).RootElement.GetProperty("Thumbnail").GetString() == "", "thumbnail-free installation omits unused preview image");
    installer.Uninstall();
    File.Delete(Path.Combine(first.Entry, "user-note.txt")); Directory.Delete(first.Entry);
    var existing = Path.Combine(library, "wallpapers", "existing"); Directory.CreateDirectory(existing);
    var original = "{\"Title\":\"My TV\",\"Author\":\"Me\",\"License\":\"MIT\",\"CustomSetting\":17,\"FileName\":\"https://iamaloneforever.github.io/Spicy-Bond/\",\"Type\":3,\"Arguments\":\"--audio false --pause-event false\"}";
    File.WriteAllText(Path.Combine(existing, "LivelyInfo.json"), original);
    File.WriteAllBytes(Path.Combine(existing, "thumbnail.jpg"), [9, 8, 7]);
    var adopted = installer.Install(template, [], false, false);
    Check(File.ReadAllBytes(Path.Combine(existing, "thumbnail.jpg")).SequenceEqual(new byte[] { 9, 8, 7 }), "repair preserves the thumbnail of an adopted wallpaper");
    Check(adopted.Entry == existing && !adopted.Created, "existing hosted wallpaper reused");
    Check(File.ReadAllText(Path.Combine(existing, "LivelyInfo.json")).Contains("My TV"), "existing identity preserved");
    using (var metadata = JsonDocument.Parse(File.ReadAllText(Path.Combine(existing, "LivelyInfo.json"))))
        Check(metadata.RootElement.GetProperty("License").GetString() == "AGPL-3.0" && metadata.RootElement.GetProperty("CustomSetting").GetInt32() == 17, "adoption migrates MIT while preserving unrelated custom registration fields");
    installer.Install(template, [], true, false); installer.Uninstall();
    using (var restored = JsonDocument.Parse(File.ReadAllText(Path.Combine(existing, "LivelyInfo.json"))))
        Check(restored.RootElement.GetProperty("Arguments").GetString() == "--audio false --pause-event false" && restored.RootElement.GetProperty("License").GetString() == "AGPL-3.0" && restored.RootElement.GetProperty("CustomSetting").GetInt32() == 17, "repair and uninstall restore unrelated original host metadata without restoring a false license");
    installer.Install(template, [], true, false); File.AppendAllText(Path.Combine(existing, "LivelyInfo.json"), " ");
    var editedMetadata = File.ReadAllText(Path.Combine(existing, "LivelyInfo.json")); installer.Uninstall();
    Check(File.ReadAllText(Path.Combine(existing, "LivelyInfo.json")) == editedMetadata, "uninstall respects edits made after setup");
    // Lost journals and pre-rename registrations must retain their pairing key.
    foreach (var hostPath in new[] { "Spicy-Bond", "Lively-wallpaper_Retro_TV" })
    {
        var paired = JsonNode.Parse(original)!.AsObject();
        var pairing = new string('b', 64);
        paired["FileName"] = $"https://iamaloneforever.github.io/{hostPath}/?live=1#bridge={pairing}";
        File.WriteAllText(Path.Combine(existing, "LivelyInfo.json"), paired.ToJsonString());
        var migrated = installer.Install(template, [], true, false);
        Check(migrated.Entry == existing && migrated.BridgeToken == pairing, "URL migration preserves adopted pairing: " + hostPath);
        Check(JsonNode.Parse(File.ReadAllText(Path.Combine(existing, "LivelyInfo.json")))!["FileName"]!.GetValue<string>() == WallpaperInstaller.WallpaperUrl + "#bridge=" + pairing, "migration uses current public path: " + hostPath);
        var repaired = installer.Install(template, [], true, false);
        Check(repaired.BridgeToken == pairing, "repair preserves journal pairing: " + hostPath);
        installer.Uninstall();
    }
    var rejected = false;
    try { WallpaperInstaller.RequireChild(library, Path.Combine(root, "outside", "LivelyInfo.json")); } catch (InvalidDataException) { rejected = true; }
    Check(rejected, "installation journal cannot escape owning library");
}
finally { Directory.Delete(root, true); } // Absolute, generated test directory strictly beneath artifacts.
Console.WriteLine($"{checks} companion contract checks passed.");
if (args.Contains("--live"))
{
    var publicExample = new PlaybackSnapshot { Title = "Never Gonna Give You Up", Artist = "Rick Astley", Album = "Whenever You Need Somebody", Duration = 213 };
    using var liveHttp = new ProviderHttp();
    foreach (var provider in new IMusicProvider[] { new ListenBrainzProvider(liveHttp), new MusicBrainzProvider(liveHttp), new AppleMetadataProvider(liveHttp) })
    {
        try { var rows = await provider.SearchAsync(publicExample, default); Console.WriteLine($"LIVE {provider.Name}: {rows.Length} parsed candidates; {TrackMatcher.Match(publicExample, rows).Status}"); }
        catch (Exception ex) { Console.WriteLine($"LIVE {provider.Name}: unavailable ({ex.GetType().Name})"); }
    }
}

sealed class FixtureHandler(string json) : HttpMessageHandler
{
    public int Calls { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Calls++;
        if (request.RequestUri!.Host != "labs.api.listenbrainz.org") throw new Exception("Unexpected API host.");
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") });
    }
}
sealed class MockProvider(TrackCandidate[] candidates, string name = "Fixture") : IMusicProvider
{
    public string Name => name;
    public bool Configured => true;
    public int Calls { get; private set; }
    public PlaybackSnapshot? LastTrack { get; private set; }
    public Task<TrackCandidate[]> SearchAsync(PlaybackSnapshot track, CancellationToken cancellation) { LastTrack = track; Calls++; cancellation.ThrowIfCancellationRequested(); return Task.FromResult(candidates); }
}
sealed class ErrorHandler(HttpStatusCode status) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation) => Task.FromResult(new HttpResponseMessage(status));
}
sealed class AnyFixtureHandler(string body) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
}
sealed class ArtistGenreFixtureHandler(bool ambiguous = false, bool wrongDetail = false) : HttpMessageHandler
{
    public int RecordingSearches { get; private set; }
    public int ArtistSearches { get; private set; }
    public int ArtistDetails { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
    {
        const string artistId = "00000000-0000-0000-0000-000000000003";
        string body;
        if (request.RequestUri!.AbsolutePath == "/ws/2/recording/")
        {
            RecordingSearches++;
            body = JsonSerializer.Serialize(new { recordings = new[] { 1, 2 }.Select(i => new Dictionary<string, object> {
                ["id"] = $"00000000-0000-0000-0000-{i:000000000000}", ["title"] = "Test song", ["length"] = 180000,
                ["artist-credit"] = new[] { new { name = "Test artist" } }, ["isrcs"] = new[] { "US0000000001" }
            }) });
        }
        else if (request.RequestUri.AbsolutePath == "/ws/2/artist/")
        {
            ArtistSearches++;
            body = JsonSerializer.Serialize(new { artists = (ambiguous ? new[] { artistId, "00000000-0000-0000-0000-000000000004" } : new[] { artistId }).Select(id => new { id, name = "Test artist" }) });
        }
        else if (request.RequestUri.AbsolutePath == "/ws/2/artist/" + artistId)
        {
            ArtistDetails++;
            body = JsonSerializer.Serialize(new { id = wrongDetail ? "00000000-0000-0000-0000-000000000099" : artistId, name = "Test artist", genres = new[] { new { name = "pop", count = 8 } } });
        }
        else throw new Exception("Unexpected genre fixture URL: " + request.RequestUri.AbsolutePath);
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
    }
}
sealed class ExperimentalFixtureHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
    {
        string body;
        if (request.RequestUri!.Host == "open.spotify.com") body = "<script id=\"__NEXT_DATA__\">" + JsonSerializer.Serialize(new { props = new { pageProps = new { state = new { settings = new { session = new { accessToken = "private-session-token", accessTokenExpirationTimestampMs = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds() } } } } } }) + "</script>";
        else
        {
            if (request.Headers.Authorization?.Parameter != "private-session-token") throw new Exception("Missing fixture authentication");
            body = "{\"data\":{\"searchV2\":{\"tracksV2\":{\"items\":[{\"item\":{\"data\":{\"id\":\"aaaaaaaaaaaaaaaaaaaaaa\",\"name\":\"Test song\",\"artists\":{\"items\":[{\"profile\":{\"name\":\"Test artist\"}}]},\"duration\":{\"totalMilliseconds\":180000}}}}]}}}}";
        }
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
    }
}

sealed class WaitingProvider : IMusicProvider
{
    public string Name => "Waiting";
    public bool Configured => true;
    public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource<TrackCandidate[]> Result { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public async Task<TrackCandidate[]> SearchAsync(PlaybackSnapshot track, CancellationToken cancellation)
    { Started.TrySetResult(); return await Result.Task.WaitAsync(cancellation); }
}
sealed class ParallelHostHandler : HttpMessageHandler
{
    public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
    {
        if (request.RequestUri!.Host == "slow.example.test") { Started.TrySetResult(); await Release.Task.WaitAsync(cancellation); }
        return new(HttpStatusCode.OK) { Content = new StringContent("{}") };
    }
}
